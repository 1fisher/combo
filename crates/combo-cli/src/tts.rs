//! 本地语音合成(TTS):多模型可选(piper 中文女/男声 int8、HF 高质量中文、
//! MeloTTS 中英双语),文本 → WAV 字节(16-bit PCM + 44 字节头),供前端朗读
//! agent 回复。
//!
//! - 模型(`TtsModel`,配置 `[tts] model` 选择,`POST /v1/speech/model` 切换,
//!   未设置/非法回落 `piper-zh-xiaoya`),首次合成自动下载;
//! - 模型文件经 GitHub release 下载(`COMBO_TTS_MODEL_URL` 可覆盖下载地址),
//!   缓存于 `<数据目录>/models/<id>/`,与 ASR 共用同一模型根目录;
//! - `POST /v1/speech` 按句合成,`enabled=false` 时返回 400 `tts_disabled`
//!   (开关以后端配置 `[tts] enabled` 为准);
//! - `POST /v1/speech/stream` **流式合成**(NDJSON):服务端把文本切成片段
//!   (句末/逗号边界),逐个合成逐个下发,客户端边收边播 — 消除句间
//!   「等下一句合成完」的空档与标点/空格造成的长停顿(见 synthesize_stream)。

use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;
use futures::StreamExt;
use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsVitsModelConfig};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::asr::err_response;
use crate::serve::AppState;
use base64::{engine::general_purpose::STANDARD, Engine as _};

/// 可选的 TTS 模型。新增模型时同步更新:parse/下载地址/文件查找/加载。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtsModel {
    /// piper 中文女声(int8,~14MB,默认)。
    PiperZhXiaoya,
    /// piper 中文男声(int8,~14MB)。
    PiperZhChaowen,
    /// HF vits 高质量中文女声(~113MB,多说话人,官方示例 sid=100)。
    VitsZhFanchenC,
    /// MeloTTS 中英双语女声(fp32,~163MB,44.1kHz,lexicon 自带中英词典,
    /// 英文按单词发音,原生支持中英混读)。
    VitsZhEnMelo,
}

impl TtsModel {
    /// 配置/接口使用的模型 id。
    pub fn id(&self) -> &'static str {
        match self {
            Self::PiperZhXiaoya => "piper-zh-xiaoya",
            Self::PiperZhChaowen => "piper-zh-chaowen",
            Self::VitsZhFanchenC => "vits-zh-fanchen-c",
            Self::VitsZhEnMelo => "vits-zh-en-melo",
        }
    }

    /// 用户可读名称。
    pub fn label(&self) -> &'static str {
        match self {
            Self::PiperZhXiaoya => "Piper 小雅(中文女声)",
            Self::PiperZhChaowen => "Piper 超闻(中文男声)",
            Self::VitsZhFanchenC => "VITS 凡尘-C(高质量女声)",
            Self::VitsZhEnMelo => "MeloTTS 中英双语(女声)",
        }
    }

    /// 默认模型下载地址(GitHub release;`COMBO_TTS_MODEL_URL` 可覆盖)。
    fn download_url(&self) -> &'static str {
        match self {
            Self::PiperZhXiaoya => "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-xiao_ya-medium-int8.tar.bz2",
            Self::PiperZhChaowen => "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-chaowen-medium-int8.tar.bz2",
            Self::VitsZhFanchenC => "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-fanchen-C.tar.bz2",
            Self::VitsZhEnMelo => "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2",
        }
    }

    /// 下载中转文件名(区分模型,避免互相覆盖)。
    fn archive_name(&self) -> &'static str {
        match self {
            Self::PiperZhXiaoya => "piper-zh-xiaoya-int8.tar.bz2.part",
            Self::PiperZhChaowen => "piper-zh-chaowen-int8.tar.bz2.part",
            Self::VitsZhFanchenC => "vits-zh-fanchen-c.tar.bz2.part",
            Self::VitsZhEnMelo => "vits-melo-tts-zh_en.tar.bz2.part",
        }
    }

    /// 解析模型 id;未知值返回 None。
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "piper-zh-xiaoya" | "xiao-ya" => Some(Self::PiperZhXiaoya),
            "piper-zh-chaowen" | "chaowen" => Some(Self::PiperZhChaowen),
            "vits-zh-fanchen-c" | "fanchen-c" | "fanchen" => Some(Self::VitsZhFanchenC),
            "vits-zh-en-melo" | "melo-tts" | "melo" => Some(Self::VitsZhEnMelo),
            _ => None,
        }
    }

    /// 该模型在模型根目录下的专属子目录(`<models>/<id>/`;未下载时可能不存在)。
    fn subdir(&self, root: &std::path::Path) -> std::path::PathBuf {
        root.join(self.id())
    }

    /// 多说话人模型的说话人 id(piper/MeloTTS 单说话人用 0)。
    fn default_sid(&self) -> i32 {
        match self {
            Self::VitsZhFanchenC => 100,
            _ => 0,
        }
    }

    /// 模型是否原生支持英文单词(双语模型自带中英词典,英文按单词发音)。
    /// 仅无英文 token 的中文单语模型需要把拉丁文本改写成中文逐字母读音。
    fn supports_english(&self) -> bool {
        matches!(self, Self::VitsZhEnMelo)
    }

    /// 在模型根目录下查找该模型的文件;未下载返回 None。
    /// 优先模型专属子目录(递归,压缩包解压后可能多一层目录);找不到再在根目录
    /// 直属层搜索(兼容旧版散落布局)——不递归,避免误匹配其他模型(如 ASR 模型)
    /// 子目录里的 onnx/tokens,造成「张冠李戴」的加载失败。
    fn find_files(&self, root: &Path) -> Option<TtsFiles> {
        find_tts_files(&self.subdir(root), true).or_else(|| find_tts_files(root, false))
    }
}

/// TTS 模型文件集合(piper 与 HF 布局统一:onnx + tokens + lexicon + fst 规则)。
#[derive(Debug, Clone)]
pub struct TtsFiles {
    model: std::path::PathBuf,
    tokens: std::path::PathBuf,
    lexicon: Option<std::path::PathBuf>,
    /// 顶层 OfflineTtsConfig.rule_fsts:`phone.fst,date.fst,number.fst`(逗号拼接)。
    rule_fsts: Option<String>,
}

/// 查找 TTS 模型文件:任意 `*.onnx`(排除 `.onnx.json` 旁车文件)+ `tokens.txt` +
/// `lexicon.txt`(可选);模型根目录存在 `phone.fst` 时拼接 rule_fsts。
/// `recursive=true` 递归搜索(模型专属子目录);`false` 只扫直属层(根目录兜底,
/// 防止跨目录误匹配其他模型的文件)。
fn find_tts_files(root: &Path, recursive: bool) -> Option<TtsFiles> {
    let mut model: Option<std::path::PathBuf> = None;
    let mut tokens: Option<std::path::PathBuf> = None;
    let mut lexicon: Option<std::path::PathBuf> = None;
    let mut has_fst = false;
    let walker = if recursive {
        walkdir::WalkDir::new(root).follow_links(false)
    } else {
        walkdir::WalkDir::new(root).follow_links(false).max_depth(1)
    };
    for entry in walker.into_iter().flatten() {
        if !entry.metadata().map(|m| m.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name.ends_with(".onnx") && !name.ends_with(".onnx.json") {
            model = Some(entry.path().to_path_buf());
        } else if name == "tokens.txt" {
            tokens = Some(entry.path().to_path_buf());
        } else if name == "lexicon.txt" {
            lexicon = Some(entry.path().to_path_buf());
        } else if name == "phone.fst" {
            has_fst = true;
        }
    }
    let model = model?;
    let tokens = tokens?;
    let rule_fsts = if has_fst {
        let dir = model.parent()?;
        let join = |n: &str| dir.join(n).display().to_string();
        Some(format!("{},{},{}", join("phone.fst"), join("date.fst"), join("number.fst")))
    } else {
        None
    };
    Some(TtsFiles { model, tokens, lexicon, rule_fsts })
}

/// f32 采样 → PCM16 LE 字节。
fn f32_to_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// 把 PCM16 LE 字节封装为 WAV(44 字节标准头,单声道)。
fn pcm16_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let data_len = pcm.len();
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// 裁掉首尾低于阈值的采样(模型自带的静音 padding)。片段间停顿全部交由
/// 播放端控制,避免「模型静音尾巴 + 播放间隙」叠加造成句间长停顿;
/// 全静音则清空(调用方按空音频跳过)。
fn trim_silence(samples: &mut Vec<f32>) {
    const THR: f32 = 0.0015;
    let Some(start) = samples.iter().position(|&s| s.abs() > THR) else {
        samples.clear();
        return;
    };
    let end = samples.iter().rposition(|&s| s.abs() > THR).expect("首采样已非静音") + 1;
    if start > 0 {
        samples.drain(..start);
    }
    samples.truncate(end - start);
}

/// 统一的离线合成器:屏蔽模型差异,`synthesize` 阻塞(调用方须在
/// spawn_blocking 中执行),多线程下经外层互斥锁串行。
pub struct Synthesizer {
    inner: OfflineTts,
    sid: i32,
    /// 模型是否原生支持英文单词(MeloTTS 双语模型跳过拉丁转写)。
    supports_english: bool,
}

impl Synthesizer {
    /// 按模型配置创建合成器(阻塞,CPU 密集)。
    fn new(model: TtsModel, files: &TtsFiles, threads: i32) -> anyhow::Result<Self> {
        let mut cfg = OfflineTtsConfig::default();
        cfg.model.num_threads = threads;
        cfg.model.vits = OfflineTtsVitsModelConfig {
            model: Some(files.model.display().to_string()),
            tokens: Some(files.tokens.display().to_string()),
            lexicon: files.lexicon.as_ref().map(|p| p.display().to_string()),
            ..Default::default()
        };
        cfg.rule_fsts = files.rule_fsts.clone();
        cfg.max_num_sentences = 1;
        let inner = OfflineTts::create(&cfg)
            .ok_or_else(|| anyhow::anyhow!("初始化 {} 合成器失败", model.label()))?;
        Ok(Self { inner, sid: model.default_sid(), supports_english: model.supports_english() })
    }

    /// 合成文本,返回 PCM16 LE 字节与采样率(阻塞)。首尾静音已裁剪,
    /// 片段间停顿由播放端控制;`silence_scale` 压低模型内部插入的静音时长
    /// (sherpa 默认 0.2,这里取更小值配合流式短停顿)。`speed` 为语速倍率
    /// (0.5~2.0,1.0 正常);piper 直接用,HF vits 由 sherpa-onnx 内部映射为
    /// length_scale=1/speed。
    fn synthesize_pcm(&self, text: &str, speed: f32) -> Option<(Vec<u8>, u32)> {
        let gen = GenerationConfig {
            sid: self.sid,
            speed,
            silence_scale: 0.08,
            ..Default::default()
        };
        let audio = self
            .inner
            .generate_with_config(text, &gen, None::<fn(&[f32], f32) -> bool>)?;
        let sr = self.inner.sample_rate().max(1) as u32;
        let mut samples = audio.samples().to_vec();
        trim_silence(&mut samples);
        Some((f32_to_pcm16(&samples), sr))
    }
}

/// 本地 TTS 服务:当前模型 + 懒加载合成器 + 模型下载状态;支持运行时切换模型。
pub struct TtsService {
    /// 模型搜索根目录(`<数据目录>/models`)。
    model_root: std::path::PathBuf,
    /// 当前选用的模型(运行时可切)。
    model: Mutex<TtsModel>,
    /// 朗读开关(启动时从 `[tts] enabled` 加载;运行时经 set_enabled 切换)。
    enabled: Mutex<bool>,
    /// 朗读语速倍率(启动时从 `[tts] speed` 加载;运行时经 set_speed 切换)。
    speed: Mutex<f32>,
    /// 已加载的合成器(随模型懒加载;切换模型时清空)。
    synth: Mutex<Option<Arc<Synthesizer>>>,
    /// 下载/加载阶段(复用 asr.rs 的 Phase,供 status 端点与前端进度展示)。
    phase: Mutex<crate::asr::Phase>,
    /// 串行化下载/加载/切换,防止并发竞争。
    prepare_lock: AsyncMutex<()>,
}

impl TtsService {
    pub fn new(model_root: std::path::PathBuf, model: TtsModel) -> Self {
        Self {
            model_root,
            model: Mutex::new(model),
            enabled: Mutex::new(false),
            speed: Mutex::new(1.0),
            synth: Mutex::new(None),
            phase: Mutex::new(crate::asr::Phase::NotReady),
            prepare_lock: AsyncMutex::new(()),
        }
    }

    /// 朗读开关状态。
    pub fn enabled(&self) -> bool {
        *self.enabled.lock().unwrap()
    }

    /// 设置朗读开关(运行时;持久化由调用方写 `[tts] enabled`)。
    pub fn set_enabled(&self, enabled: bool) {
        *self.enabled.lock().unwrap() = enabled;
    }

    /// 当前选用的模型。
    pub fn current_model(&self) -> TtsModel {
        *self.model.lock().unwrap()
    }

    /// 已加载的合成器(未加载返回 None)。
    pub(crate) fn synthesizer(&self) -> Option<Arc<Synthesizer>> {
        self.synth.lock().unwrap().clone()
    }

    /// 当前朗读语速倍率(1.0 为正常语速)。
    pub fn speed(&self) -> f32 {
        *self.speed.lock().unwrap()
    }

    /// 设置朗读语速倍率(运行时;持久化由调用方写 `[tts] speed`)。
    pub fn set_speed(&self, speed: f32) {
        *self.speed.lock().unwrap() = speed.clamp(0.5, 2.0);
    }

    /// 模型根目录(展示用)。
    pub fn model_dir(&self) -> &Path {
        &self.model_root
    }

    pub(crate) fn set_phase(&self, phase: crate::asr::Phase) {
        *self.phase.lock().unwrap() = phase;
    }

    pub(crate) fn phase_snapshot(&self) -> crate::asr::Phase {
        self.phase.lock().unwrap().clone()
    }

    /// 切换模型:清空已加载合成器并回到未就绪(与进行中的下载/加载互斥)。
    pub async fn set_model(self: &Arc<Self>, model: TtsModel) {
        let _guard = self.prepare_lock.lock().await;
        if self.current_model() == model {
            return;
        }
        *self.synth.lock().unwrap() = None;
        *self.model.lock().unwrap() = model;
        self.set_phase(crate::asr::Phase::NotReady);
    }

    /// 确保当前模型的合成器就绪:缺失则下载,然后加载。幂等,可并发调用。
    pub async fn ensure_ready(self: &Arc<Self>) -> anyhow::Result<()> {
        let _guard = self.prepare_lock.lock().await;
        if self.synthesizer().is_some() {
            return Ok(());
        }
        let model = self.current_model();
        if model.find_files(&self.model_root).is_none() {
            if let Err(e) = self.download(model).await {
                self.set_phase(crate::asr::Phase::Failed(format!("模型下载失败: {e:#}")));
                return Err(e);
            }
        }
        self.set_phase(crate::asr::Phase::Loading);
        let this = self.clone();
        let synth = match tokio::task::spawn_blocking(move || this.load_synthesizer()).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                // 加载失败不能停在 Loading(前端会一直显示「模型加载中」),
                // 置为 Failed 让 status 端点带出错误、前端展示「重新下载」按钮
                self.set_phase(crate::asr::Phase::Failed(format!(
                    "初始化 {} 合成器失败: {e}",
                    model.label()
                )));
                return Err(anyhow::anyhow!("初始化 {} 合成器失败: {e}", model.label()));
            }
            Err(e) => {
                self.set_phase(crate::asr::Phase::Failed("加载线程失败".into()));
                return Err(anyhow::anyhow!("加载线程失败: {e}"));
            }
        };
        *self.synth.lock().unwrap() = Some(Arc::new(synth));
        self.set_phase(crate::asr::Phase::Ready);
        Ok(())
    }

    /// 按当前模型加载合成器(阻塞,CPU 密集)。
    fn load_synthesizer(&self) -> anyhow::Result<Synthesizer> {
        let model = self.current_model();
        let files = model
            .find_files(&self.model_root)
            .ok_or_else(|| anyhow::anyhow!("模型文件缺失"))?;
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4) as i32)
            .unwrap_or(2);
        Synthesizer::new(model, &files, threads)
    }

    /// 下载指定模型的压缩包并解压到其专属子目录(镜像 asr.rs::download)。
    async fn download(&self, model: TtsModel) -> anyhow::Result<()> {
        let url =
            std::env::var("COMBO_TTS_MODEL_URL").unwrap_or_else(|_| model.download_url().to_string());
        let extract_root = model.subdir(&self.model_root);
        std::fs::create_dir_all(&extract_root)?;
        let archive_path = extract_root.join(model.archive_name());

        tracing::info!("开始下载语音合成模型({}): {url}", model.label());
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()?;
        let resp = client.get(&url).send().await?.error_for_status()?;
        let total = resp.content_length().unwrap_or(0) as f64;

        let mut file = tokio::fs::File::create(&archive_path).await?;
        let mut downloaded: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            downloaded += chunk.len() as u64;
            if total > 0.0 {
                let progress = (downloaded as f64 / total).clamp(0.0, 1.0);
                self.set_phase(crate::asr::Phase::Downloading { progress });
            }
        }
        file.flush().await?;
        drop(file);

        // 解压(阻塞,放后台线程):tar.bz2 → 模型子目录,随后删除压缩包。
        let extract_root_clone = extract_root.clone();
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let f = std::fs::File::open(&archive_path)?;
            let dec = bzip2::read::BzDecoder::new(f);
            let mut archive = tar::Archive::new(dec);
            archive.unpack(&extract_root_clone)?;
            let _ = std::fs::remove_file(&archive_path);
            Ok(())
        })
        .await
        .map_err(|e| anyhow::anyhow!("解压线程失败: {e}"))??;

        if model.find_files(&self.model_root).is_none() {
            anyhow::bail!("压缩包解压后未找到 {} 的模型文件", model.label());
        }
        tracing::info!("语音合成模型下载完成: {}", extract_root.display());
        Ok(())
    }

    /// 合成单个片段,返回 PCM16 LE 字节与采样率(阻塞,须在 spawn_blocking 中
    /// 执行)。文本先做拉丁转写与规范化;规范化后无可读内容的片段返回空音频
    /// (调用方跳过)。
    fn synthesize_fragment_pcm(
        synth: &Synthesizer,
        text: String,
        speed: f32,
    ) -> anyhow::Result<(Vec<u8>, u32)> {
        // 中文单语模型(char 级词库)没有英文字母 token,英文词会被当作 OOV 静默
        // 丢弃,需逐字母转中文读音;双语模型(MeloTTS)自带中英词典,原样传入即可
        // 按单词发音,跳过转写以免破坏英文读音。
        let text = if synth.supports_english { text } else { localize_latin_text(&text) };
        let text = normalize_tts_text(&text, synth.supports_english);
        if !speakable(&text) {
            return Ok((Vec::new(), 0));
        }
        synth
            .synthesize_pcm(&text, speed)
            .ok_or_else(|| anyhow::anyhow!("语音合成失败"))
    }

    /// 合成整段文本为单个 WAV(旧的整体返回端点使用;阻塞,须在 spawn_blocking
    /// 中执行)。同样按片段切分合成,片段间插入固定短静音(替代模型在标点处
    /// 生成的长停顿),再拼接封装 WAV。
    fn synthesize_blocking(synth: &Synthesizer, text: String, speed: f32) -> anyhow::Result<Vec<u8>> {
        let frags = split_tts_fragments(&text, MAX_FRAGMENT_CHARS);
        let mut parts: Vec<(Vec<u8>, bool)> = Vec::new();
        let mut sr = 0u32;
        for (frag, hard) in frags {
            let (pcm, s) = Self::synthesize_fragment_pcm(synth, frag, speed)?;
            if pcm.is_empty() {
                continue;
            }
            sr = s;
            parts.push((pcm, hard));
        }
        if parts.is_empty() {
            return Err(anyhow::anyhow!("语音合成失败"));
        }
        let mut pcm: Vec<u8> = Vec::new();
        for (i, (p, hard)) in parts.iter().enumerate() {
            if i > 0 {
                let gap_secs = if *hard { 0.26 } else { 0.14 };
                pcm.extend_from_slice(&vec![0u8; (sr as f32 * gap_secs) as usize * 2]);
            }
            pcm.extend_from_slice(p);
        }
        Ok(pcm16_to_wav(&pcm, sr))
    }
}

/// 单个合成片段的字符上限(与前端 MAX_SENTENCE_CHARS 对齐,防长句无停顿)。
const MAX_FRAGMENT_CHARS: usize = 100;
/// 流式合成请求的文本上限(整段回复一次提交,服务端再切片段)。
const MAX_STREAM_TEXT_CHARS: usize = 4000;

/// 句末标点(硬边界:自然停顿点;半角/全角叹号问号、全角分号都算)。
/// 注:全角变体(U+FF01 等)用 `\u{}` 转义书写,避免编辑器自动归一化。
fn is_hard_boundary(ch: char) -> bool {
    matches!(
        ch,
        '。' | '\u{FF01}' | '!' | '\u{FF1F}' | '?' | '…' | '\n' | '\u{FF1B}'
    )
}

/// 句中标点(软边界:模型在这些标点处会插入较长静音,切开成独立片段后由
/// 播放端用短停顿衔接)。注:全角分号(U+FF1B)已按句末(硬边界)处理。
fn is_soft_boundary(ch: char) -> bool {
    matches!(ch, ',' | '\u{FF0C}' | '、' | ';' | ':' | '\u{FF1A}')
}

/// 片段是否含有可朗读内容(至少一个字母/数字/汉字等文字字符)。
fn speakable(s: &str) -> bool {
    s.chars().any(char::is_alphanumeric)
}

/// 把文本切成 TTS 合成片段:`Vec<(片段, 是否句末边界)>`。
///
/// 句末标点(。!?…;换行)为硬边界;逗号/顿号/分号/冒号为软边界 — 模型在
/// 这些标点处会生成 0.3~0.8s 的静音,是「逗号长停顿」的直接来源,切开成
/// 独立片段后停顿时长交由播放端的短间隙控制。数字间的 ASCII 逗号(千分位,
/// 如 `1,000`)不是边界;单片段超过 `max_chars` 字符强制切分。
fn split_tts_fragments(text: &str, max_chars: usize) -> Vec<(String, bool)> {
    let chars: Vec<char> = text.chars().collect();
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut cur = String::new();
    fn emit(cur: &mut String, hard: bool, out: &mut Vec<(String, bool)>) {
        let t = cur.trim();
        if speakable(t) {
            out.push((t.to_string(), hard));
        }
        cur.clear();
    }
    for (i, &ch) in chars.iter().enumerate() {
        cur.push(ch);
        let thousands_sep = ch == ','
            && i > 0
            && chars[i - 1].is_ascii_digit()
            && chars.get(i + 1).is_some_and(|c| c.is_ascii_digit());
        if thousands_sep {
            // 千分位逗号:保留在片段内
        } else if is_hard_boundary(ch) {
            emit(&mut cur, true, &mut out);
        } else if is_soft_boundary(ch) {
            emit(&mut cur, false, &mut out);
        } else if cur.chars().count() >= max_chars {
            emit(&mut cur, false, &mut out);
        }
    }
    emit(&mut cur, false, &mut out);
    out
}

/// TTS 文本规范化:去除 markdown 强调符(前端断句器只剥离代码块围栏,行内
/// `**粗体**`/反引号会残留);折叠连续空白。char 级中文词库(非双语)模型
/// 额外删除 ASCII 空格 — 空格在词库里没有对应 token,合成表现为长停顿
/// (逐字母拼写间的空格尤其明显);双语模型(MeloTTS)必须保留单词间空格,
/// 仅折叠连续空白为单个。
fn normalize_tts_text(text: &str, supports_english: bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_ws = false;
    for ch in text.chars() {
        match ch {
            '\r' | '*' | '`' | '#' | '~' | '|' => {}
            ' ' | '\t' | '\n' => {
                if supports_english && !last_ws {
                    out.push(' ');
                    last_ws = true;
                }
            }
            _ => {
                out.push(ch);
                last_ws = false;
            }
        }
    }
    out.trim().to_string()
}

/// 单句合成文本上限(字符):句子级朗读,超长拒绝。
const MAX_TEXT_CHARS: usize = 500;

/// 拉丁字母 → 中文读音(按中国人读英文的习惯逐字母念出)。
const LETTER_NAMES: &[(&str, &str); 26] = &[
    ("a", "诶"), ("b", "比"), ("c", "西"), ("d", "迪"), ("e", "衣"),
    ("f", "艾弗"), ("g", "吉"), ("h", "艾尺"), ("i", "爱"), ("j", "杰"),
    ("k", "开"), ("l", "艾勒"), ("m", "艾姆"), ("n", "恩"), ("o", "欧"),
    ("p", "皮"), ("q", "扣"), ("r", "阿尔"), ("s", "艾斯"), ("t", "提"),
    ("u", "优"), ("v", "维"), ("w", "达布流"), ("x", "艾克斯"), ("y", "歪"),
    ("z", "贼"),
];

/// 把文本中的拉丁字母串改写为中文逐字母读音。
///
/// 中文 TTS 模型(char 级词库,如 vits-zh-fanchen-c / piper-zh-*)没有英文字母
/// token,直接合成会被当作 OOV 静默丢弃(sherpa-onnx 日志 `Ignore OOV 'Combo'`),
/// 导致英文词从音频里消失。逐字母转成中文读音后,英文词/标识符可完整念出。
/// 双语模型(vits-zh-en-melo)自带中英词典,英文按单词发音,不需要此转换。
fn localize_latin_text(text: &str) -> String {
    fn spell(buf: &mut Vec<char>, out: &mut String) {
        if buf.is_empty() {
            return;
        }
        for (i, letter) in buf.iter().enumerate() {
            if i > 0 {
                out.push(' ');
            }
            let lower = letter.to_ascii_lowercase();
            let name = LETTER_NAMES
                .iter()
                .find(|(l, _)| l.as_bytes()[0] == lower as u8)
                .map(|(_, n)| *n)
                .unwrap_or("");
            out.push_str(name);
        }
        buf.clear();
    }
    let mut out = String::with_capacity(text.len());
    let mut buf: Vec<char> = Vec::new();
    for ch in text.chars() {
        if ch.is_ascii_alphabetic() {
            buf.push(ch);
        } else {
            spell(&mut buf, &mut out);
            out.push(ch);
        }
    }
    spell(&mut buf, &mut out);
    out
}

/// GET /v1/speech/status — TTS 状态(开关 + 模型 + 下载/加载进度)。
async fn status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let tts = state.tts.clone();
    let enabled = tts.enabled();
    let phase = tts.phase_snapshot();
    let (progress, error) = match &phase {
        crate::asr::Phase::Downloading { progress } => (Some(*progress), None),
        crate::asr::Phase::Failed(e) => (None, Some(e.clone())),
        _ => (None, None),
    };
    Json(json!({
        "enabled": enabled,
        "ready": matches!(phase, crate::asr::Phase::Ready),
        "phase": phase.name(),
        "progress": progress,
        "error": error,
        "model": tts.current_model().id(),
        "model_dir": tts.model_dir().display().to_string(),
        "speed": tts.speed(),
    }))
}

/// POST /v1/speech/prepare — 触发模型下载/加载(幂等;后台执行,立即返回)。
async fn prepare(State(state): State<AppState>) -> Json<serde_json::Value> {
    let tts = state.tts.clone();
    if tts.synthesizer().is_none()
        && !matches!(&*tts.phase.lock().unwrap(), crate::asr::Phase::Downloading { .. })
    {
        let worker = tts.clone();
        tokio::spawn(async move {
            if let Err(e) = worker.ensure_ready().await {
                tracing::warn!("语音合成模型准备失败: {e:#}");
            }
        });
    }
    let phase = tts.phase_snapshot();
    Json(json!({
        "ok": true,
        "phase": phase.name(),
    }))
}

/// POST /v1/speech/config — 打开/关闭朗读,写入配置 `[tts] enabled`。
#[derive(Deserialize)]
struct SetEnabledReq {
    enabled: bool,
}

async fn set_enabled(
    State(state): State<AppState>,
    Json(body): Json<SetEnabledReq>,
) -> Response {
    if let Err(e) = crate::config::set_tts_enabled(&crate::config::default_config_path(), body.enabled) {
        return err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("保存配置失败: {e}"),
            None,
        );
    }
    state.tts.set_enabled(body.enabled);
    tracing::info!("语音朗读已{}", if body.enabled { "开启" } else { "关闭" });
    Json(json!({ "ok": true, "enabled": body.enabled })).into_response()
}

/// POST /v1/speech/model — 切换 TTS 模型并持久化到配置 `[tts] model`。
#[derive(Deserialize)]
struct SetModelReq {
    model: String,
}

async fn set_model(
    State(state): State<AppState>,
    Json(body): Json<SetModelReq>,
) -> Response {
    let Some(model) = TtsModel::parse(&body.model) else {
        return err_response(
            StatusCode::BAD_REQUEST,
            "未知语音朗读模型,可选:piper-zh-xiaoya(中文女声)/ piper-zh-chaowen(中文男声)/ vits-zh-fanchen-c(高质量女声)",
            None,
        );
    };
    // 先持久化配置,再切换运行时(失败早退,不留半切换状态)
    if let Err(e) = crate::config::set_tts_model(&crate::config::default_config_path(), model.id()) {
        return err_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("保存配置失败: {e}"), None);
    }
    state.tts.set_model(model).await;
    tracing::info!("语音朗读模型已切换为 {}({})", model.label(), model.id());
    let phase = state.tts.phase_snapshot();
    Json(json!({
        "ok": true,
        "model": model.id(),
        "phase": phase.name(),
    }))
    .into_response()
}

/// POST /v1/speech/speed — 设置朗读语速倍率(0.5~2.0),持久化到配置 `[tts] speed`。
#[derive(Deserialize)]
struct SetSpeedReq {
    speed: f32,
}

async fn set_speed(
    State(state): State<AppState>,
    Json(body): Json<SetSpeedReq>,
) -> Response {
    if !(0.5..=2.0).contains(&body.speed) {
        return err_response(StatusCode::BAD_REQUEST, "语速倍率需在 0.5~2.0 之间", None);
    }
    if let Err(e) = crate::config::set_tts_speed(&crate::config::default_config_path(), body.speed) {
        return err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("保存配置失败: {e}"),
            None,
        );
    }
    state.tts.set_speed(body.speed);
    tracing::info!("语音朗读语速已设置为 {}x", body.speed);
    Json(json!({ "ok": true, "speed": body.speed })).into_response()
}

/// POST /v1/speech — 合成单句文本为 WAV(响应体为 audio/wav 字节)。
#[derive(Deserialize)]
struct SynthesizeReq {
    text: String,
}

async fn synthesize(
    State(state): State<AppState>,
    Json(body): Json<SynthesizeReq>,
) -> Response {
    synthesize_impl(state, body.text, true).await
}

/// POST /v1/speech/test — 试听模型音色:合成单句文本为 WAV。
/// 与正式合成唯一区别:不要求朗读开关打开(试听只验证音色,不触发朗读)。
async fn synthesize_test(
    State(state): State<AppState>,
    Json(body): Json<SynthesizeReq>,
) -> Response {
    synthesize_impl(state, body.text, false).await
}

async fn synthesize_impl(state: AppState, raw_text: String, require_enabled: bool) -> Response {
    if require_enabled && !state.tts.enabled() {
        return err_response(
            StatusCode::BAD_REQUEST,
            "语音朗读未开启,请先在设置中打开",
            Some("tts_disabled"),
        );
    }
    let text = raw_text.trim().to_string();
    if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
        return err_response(
            StatusCode::BAD_REQUEST,
            "文本为空或超过 500 字符上限",
            Some("tts_text_invalid"),
        );
    }
    // 首次合成前确保模型就绪:未就绪则后台触发下载/加载并立即返回 503(不阻塞
    // 请求),前端轮询 /v1/speech/status 展示下载进度,就绪后重试合成。
    if state.tts.synthesizer().is_none() {
        let tts = state.tts.clone();
        if !matches!(&*tts.phase.lock().unwrap(), crate::asr::Phase::Downloading { .. }) {
            tokio::spawn(async move {
                if let Err(e) = tts.ensure_ready().await {
                    tracing::warn!("语音合成模型准备失败: {e:#}");
                }
            });
        }
        return err_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "语音合成模型正在下载/加载,请稍后重试",
            Some("tts_not_ready"),
        );
    }
    let Some(synth) = state.tts.synthesizer() else {
        return err_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "语音合成模型尚未就绪,请稍后重试",
            Some("tts_not_ready"),
        );
    };
    let speed = state.tts.speed();
    let wav = match tokio::task::spawn_blocking(move || TtsService::synthesize_blocking(&synth, text, speed))
        .await
    {
        Ok(Ok(wav)) => wav,
        Ok(Err(e)) => {
            tracing::warn!("语音合成失败: {e:#}");
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "语音合成失败,请稍后重试",
                None,
            );
        }
        Err(e) => {
            tracing::warn!("合成线程失败: {e}");
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "语音合成失败,请稍后重试",
                None,
            );
        }
    };
    (StatusCode::OK, [("Content-Type", "audio/wav")], axum::body::Body::from(wav)).into_response()
}

/// POST /v1/speech/stream — 流式合成(NDJSON,chunked 传输)。
///
/// 请求体 `{"text": "...", "test": false}`;`test=true` 不要求朗读开关打开
/// (供设置区试听与通知语音播报使用,同 `/v1/speech/test`)。
///
/// 服务端把文本切成片段(句末/逗号边界,见 `split_tts_fragments`),逐个
/// 合成、合成一个就流出一行 JSON:
/// - `{"type":"chunk","seq":1,"hard":false,"sample_rate":22050,"pcm":"<base64 PCM16LE>"}`
/// - `{"type":"done"}`(全部片段完成)/ `{"type":"error","message":"..."}`
///
/// 客户端收到 chunk 即可解码排期播放,后续片段在前一段播放期间继续合成 —
/// 句间不再有「等下一句合成完」的空档;片段首尾静音已裁剪、逗号被切开,
/// 停顿时长由播放端的短间隙(硬/软边界区分)控制。
#[derive(Deserialize)]
struct StreamReq {
    text: String,
    #[serde(default)]
    test: bool,
}

async fn synthesize_stream(State(state): State<AppState>, Json(body): Json<StreamReq>) -> Response {
    if !body.test && !state.tts.enabled() {
        return err_response(
            StatusCode::BAD_REQUEST,
            "语音朗读未开启,请先在设置中打开",
            Some("tts_disabled"),
        );
    }
    let text = body.text.trim().to_string();
    if text.is_empty() || text.chars().count() > MAX_STREAM_TEXT_CHARS {
        return err_response(
            StatusCode::BAD_REQUEST,
            &format!("文本为空或超过 {MAX_STREAM_TEXT_CHARS} 字符上限"),
            Some("tts_text_invalid"),
        );
    }
    // 首次合成前确保模型就绪:未就绪则后台触发下载/加载并立即返回 503(不阻塞
    // 请求),前端轮询 /v1/speech/status 展示下载进度,就绪后重试。
    if state.tts.synthesizer().is_none() {
        let tts = state.tts.clone();
        if !matches!(&*tts.phase.lock().unwrap(), crate::asr::Phase::Downloading { .. }) {
            tokio::spawn(async move {
                if let Err(e) = tts.ensure_ready().await {
                    tracing::warn!("语音合成模型准备失败: {e:#}");
                }
            });
        }
        return err_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "语音合成模型正在下载/加载,请稍后重试",
            Some("tts_not_ready"),
        );
    }
    let Some(synth) = state.tts.synthesizer() else {
        return err_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "语音合成模型尚未就绪,请稍后重试",
            Some("tts_not_ready"),
        );
    };
    let speed = state.tts.speed();
    let frags = split_tts_fragments(&text, MAX_FRAGMENT_CHARS);

    /// unfold 的流状态:当前片段下标 + 是否已发送 done 行 + 是否已失败。
    struct StreamState {
        synth: Arc<Synthesizer>,
        frags: Vec<(String, bool)>,
        idx: usize,
        speed: f32,
        done_sent: bool,
        failed: bool,
    }
    let init = StreamState { synth, frags, idx: 0, speed, done_sent: false, failed: false };
    let stream = futures::stream::unfold(init, |mut st| async move {
        if st.failed {
            return None;
        }
        if st.idx < st.frags.len() {
            let (frag, hard) = st.frags[st.idx].clone();
            let seq = st.idx + 1;
            st.idx += 1;
            let synth = st.synth.clone();
            let speed = st.speed;
            let res = tokio::task::spawn_blocking(move || {
                TtsService::synthesize_fragment_pcm(&synth, frag, speed)
            })
            .await;
            let line = match res {
                Ok(Ok((pcm, sr))) if !pcm.is_empty() => json!({
                    "type": "chunk",
                    "seq": seq,
                    "hard": hard,
                    "sample_rate": sr,
                    "pcm": STANDARD.encode(&pcm),
                }),
                Ok(Ok(_)) => {
                    // 规范化后无可读内容的片段:跳过(空帧,不产出行)
                    return Some((Ok::<axum::body::Bytes, std::convert::Infallible>(
                        axum::body::Bytes::new(),
                    ), st));
                }
                Ok(Err(e)) => {
                    tracing::warn!("流式语音合成失败: {e:#}");
                    st.failed = true;
                    json!({ "type": "error", "message": "语音合成失败,请稍后重试" })
                }
                Err(e) => {
                    tracing::warn!("合成线程失败: {e}");
                    st.failed = true;
                    json!({ "type": "error", "message": "语音合成失败,请稍后重试" })
                }
            };
            let mut s = line.to_string();
            s.push('\n');
            Some((Ok(axum::body::Bytes::from(s)), st))
        } else if !st.done_sent {
            st.done_sent = true;
            Some((Ok::<axum::body::Bytes, std::convert::Infallible>(
                axum::body::Bytes::from_static(b"{\"type\":\"done\"}\n"),
            ), st))
        } else {
            None
        }
    });
    (
        StatusCode::OK,
        [
            ("content-type", "application/x-ndjson; charset=utf-8"),
            ("cache-control", "no-store"),
            // 经 nginx 等反向代理时不缓冲,保证片段即产即达
            ("x-accel-buffering", "no"),
        ],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

/// 挂载 TTS 路由。
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/speech/status", get(status))
        .route("/v1/speech/prepare", post(prepare))
        .route("/v1/speech/config", post(set_enabled))
        .route("/v1/speech/speed", post(set_speed))
        .route("/v1/speech/model", post(set_model))
        .route("/v1/speech/test", post(synthesize_test))
        .route("/v1/speech/stream", post(synthesize_stream))
        .route("/v1/speech", post(synthesize))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn tts_model_parse_and_ids() {
        assert_eq!(TtsModel::parse("piper-zh-xiaoya"), Some(TtsModel::PiperZhXiaoya));
        assert_eq!(TtsModel::parse(" chaowen "), Some(TtsModel::PiperZhChaowen));
        assert_eq!(TtsModel::parse("fanchen-c"), Some(TtsModel::VitsZhFanchenC));
        assert_eq!(TtsModel::parse("melo"), Some(TtsModel::VitsZhEnMelo));
        assert_eq!(TtsModel::parse("vits-zh-en-melo"), Some(TtsModel::VitsZhEnMelo));
        assert_eq!(TtsModel::parse("unknown"), None);
        assert_eq!(TtsModel::PiperZhXiaoya.id(), "piper-zh-xiaoya");
        assert_eq!(TtsModel::PiperZhChaowen.id(), "piper-zh-chaowen");
        assert_eq!(TtsModel::VitsZhFanchenC.id(), "vits-zh-fanchen-c");
        assert_eq!(TtsModel::VitsZhEnMelo.id(), "vits-zh-en-melo");
        assert!(TtsModel::PiperZhXiaoya.download_url().contains("xiao_ya"));
        assert!(TtsModel::PiperZhChaowen.download_url().contains("chaowen"));
        assert!(TtsModel::VitsZhFanchenC.download_url().contains("fanchen-C"));
        assert!(TtsModel::VitsZhEnMelo.download_url().contains("melo-tts-zh_en"));
        assert_eq!(TtsModel::VitsZhFanchenC.default_sid(), 100);
        assert_eq!(TtsModel::PiperZhXiaoya.default_sid(), 0);
        assert_eq!(TtsModel::VitsZhEnMelo.default_sid(), 0);
        // 只有双语模型跳过拉丁转写
        assert!(!TtsModel::PiperZhXiaoya.supports_english());
        assert!(!TtsModel::VitsZhFanchenC.supports_english());
        assert!(TtsModel::VitsZhEnMelo.supports_english());
    }

    #[test]
    fn localize_latin_text_spells_letters_and_keeps_cjk() {
        // 纯中文与标点不动
        assert_eq!(localize_latin_text("你好,世界!"), "你好,世界!");
        // 英文词逐字母转中文读音(大小写不敏感)
        assert_eq!(localize_latin_text("Combo"), "西 欧 艾姆 比 欧");
        assert_eq!(localize_latin_text("AI"), "诶 爱");
        assert_eq!(localize_latin_text("api"), "诶 皮 爱");
        // 混排:中文与标点原样,仅拉丁串转写;中文全角标点前不留多余空格
        assert_eq!(
            localize_latin_text("Combo 是一个 IDE 助手。"),
            "西 欧 艾姆 比 欧 是一个 爱 迪 衣 助手。"
        );
        // 数字与符号保留(数字由 rule_fsts 处理)
        assert_eq!(localize_latin_text("GPT-4"), "吉 皮 提-4");
        assert_eq!(localize_latin_text(""), "");
    }

    #[test]
    fn pcm16_to_wav_header_is_standard() {
        let samples = vec![0.0f32, 0.5, -0.5, 1.0, -1.0];
        let pcm = f32_to_pcm16(&samples);
        let wav = pcm16_to_wav(&pcm, 22050);
        // 44 字节头 + 5 采样 * 2 字节
        assert_eq!(wav.len(), 44 + 10);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes(wav[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 1, "PCM");
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1, "mono");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 22050);
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 22050 * 2);
        assert_eq!(u16::from_le_bytes(wav[32..34].try_into().unwrap()), 2, "block align");
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16, "bits");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 10);
        // PCM16 采样:0.5 → 16384(0x4000),-0.5 → -16384
        let s1 = i16::from_le_bytes([wav[46], wav[47]]);
        assert_eq!(s1, 16384);
        let s2 = i16::from_le_bytes([wav[48], wav[49]]);
        assert_eq!(s2, -16384);
    }

    #[test]
    fn trim_silence_trims_edges_only() {
        let mut v = vec![0.0, 0.0001, 0.5, -0.4, 0.0, 0.0];
        trim_silence(&mut v);
        assert_eq!(v, vec![0.5, -0.4]);
        let mut all = vec![0.0f32; 8];
        trim_silence(&mut all);
        assert!(all.is_empty());
        // 首采样即非静音:不裁头
        let mut head = vec![0.6, 0.0];
        trim_silence(&mut head);
        assert_eq!(head, vec![0.6]);
    }

    #[test]
    fn split_tts_fragments_splits_hard_and_soft() {
        let frags = split_tts_fragments("你好,世界。今天天气怎么样?好的", 100);
        assert_eq!(frags[0], ("你好,".into(), false));
        assert_eq!(frags[1], ("世界。".into(), true));
        assert_eq!(frags[2], ("今天天气怎么样?".into(), true));
        assert_eq!(frags[3], ("好的".into(), false));
        // 全角变体(U+FF0C 逗号 / U+FF1F 问号)同样切分
        let full = "你好\u{FF0C}世界\u{FF1F}好的";
        let frags = split_tts_fragments(full, 100);
        assert_eq!(frags[0], ("你好\u{FF0C}".into(), false));
        assert_eq!(frags[1], ("世界\u{FF1F}".into(), true));
        assert_eq!(frags[2], ("好的".into(), false));
    }

    #[test]
    fn split_tts_fragments_keeps_thousands_separator() {
        let frags = split_tts_fragments("价格是 1,000 元。", 100);
        assert_eq!(frags.len(), 1);
        assert!(frags[0].0.contains("1,000"));
    }

    #[test]
    fn split_tts_fragments_enforces_max_chars() {
        let text = "一".repeat(250);
        let frags = split_tts_fragments(&text, 100);
        assert!(frags.iter().all(|(s, _)| s.chars().count() <= 100));
        assert_eq!(frags.len(), 3);
    }

    #[test]
    fn split_tts_fragments_drops_symbol_only_and_empty() {
        assert!(split_tts_fragments("...,,。", 100).is_empty());
        assert!(split_tts_fragments("", 100).is_empty());
    }

    #[test]
    fn normalize_tts_text_strips_markdown_and_spaces() {
        // 中文单语模型:markdown 符号删除、ASCII 空格删除(空格 → 长停顿)
        assert_eq!(normalize_tts_text("**重点** `code` # 标题", false), "重点code标题");
        assert_eq!(normalize_tts_text("你好 世界", false), "你好世界");
        // 双语模型:折叠连续空白为单空格(英文单词间隔必须保留)
        assert_eq!(normalize_tts_text("hello   world\n\ntest", true), "hello world test");
    }

    #[test]
    fn find_tts_files_detects_layout() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("m");
        std::fs::create_dir_all(&root).unwrap();
        // 模拟 piper 布局:onnx + tokens + lexicon + fst 文件
        let mut f = std::fs::File::create(root.join("zh_CN-xiao_ya-medium.onnx")).unwrap();
        f.write_all(b"onnx").unwrap();
        std::fs::write(root.join("tokens.txt"), "t").unwrap();
        std::fs::write(root.join("lexicon.txt"), "l").unwrap();
        std::fs::write(root.join("phone.fst"), "p").unwrap();
        std::fs::write(root.join("date.fst"), "d").unwrap();
        std::fs::write(root.join("number.fst"), "n").unwrap();
        let files = TtsModel::PiperZhXiaoya.find_files(&root).expect("应找到模型文件");
        assert!(files.model.file_name().unwrap().to_string_lossy().ends_with(".onnx"));
        assert!(files.tokens.ends_with("tokens.txt"));
        assert!(files.lexicon.is_some());
        assert!(files.rule_fsts.is_some(), "应识别 fst 规则文件");
        // 缺 tokens 视为未就绪
        std::fs::remove_file(root.join("tokens.txt")).unwrap();
        assert!(TtsModel::PiperZhXiaoya.find_files(&root).is_none());
    }

    #[test]
    fn find_files_does_not_leak_into_other_model_subdirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // 无关模型子目录(如 ASR sense-voice,内含 onnx + tokens + fst)
        let other = root.join("sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("model.int8.onnx"), "onnx").unwrap();
        std::fs::write(other.join("tokens.txt"), "t").unwrap();
        std::fs::write(other.join("phone.fst"), "p").unwrap();
        // 目标模型未下载(无专属子目录)→ 不得从其他模型目录误匹配
        assert!(TtsModel::PiperZhChaowen.find_files(root).is_none());
        assert!(TtsModel::PiperZhXiaoya.find_files(root).is_none());
        assert!(TtsModel::VitsZhFanchenC.find_files(root).is_none());
        // 专属子目录内套一层(压缩包解压出的目录):递归仍能找到
        let sub = root.join("piper-zh-chaowen/chaowen-medium-int8");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("zh_CN-chaowen-medium.onnx"), "onnx").unwrap();
        std::fs::write(sub.join("tokens.txt"), "t").unwrap();
        std::fs::write(sub.join("lexicon.txt"), "l").unwrap();
        std::fs::write(sub.join("phone.fst"), "p").unwrap();
        std::fs::write(sub.join("date.fst"), "d").unwrap();
        std::fs::write(sub.join("number.fst"), "n").unwrap();
        let files = TtsModel::PiperZhChaowen.find_files(root).expect("专属子目录应能找到模型");
        assert!(files.model.display().to_string().contains("piper-zh-chaowen"));
        assert!(files.rule_fsts.unwrap().contains("chaowen-medium-int8"));
    }

    #[tokio::test]
    async fn speech_endpoint_validation() {
        let state = AppState::test_state(Arc::new(crate::meta::MetaStore::new()), None);
        // 默认配置朗读关闭 → synthesize 返回 400 tts_disabled
        let resp = synthesize(State(state.clone()), Json(SynthesizeReq { text: "你好".into() })).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        // 试听端点不要求朗读开关打开:关闭时仍走模型流程
        // (模拟下载中 → 503 tts_not_ready,而非 400 tts_disabled)
        state.tts.set_phase(crate::asr::Phase::Downloading { progress: 0.5 });
        let resp = synthesize_test(State(state.clone()), Json(SynthesizeReq { text: "你好".into() })).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        state.tts.set_phase(crate::asr::Phase::NotReady);
        // status 端点返回 enabled=false 与默认模型、默认语速
        let body = status(State(state.clone())).await;
        assert_eq!(body.0["enabled"], serde_json::Value::Bool(false));
        assert_eq!(body.0["model"], serde_json::json!("piper-zh-xiaoya"));
        assert_eq!(body.0["speed"], serde_json::json!(1.0));
        // 语速越界 400
        let resp = set_speed(State(state.clone()), Json(SetSpeedReq { speed: 3.0 })).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let resp = set_speed(State(state.clone()), Json(SetSpeedReq { speed: 0.1 })).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        // 合法值写入运行态(配置写入走真实配置路径,测试态仅断言运行态切换)
        state.tts.set_speed(1.5);
        let body = status(State(state)).await;
        assert_eq!(body.0["speed"], serde_json::json!(1.5));
    }

    #[tokio::test]
    async fn speech_stream_endpoint_validation() {
        let state = AppState::test_state(Arc::new(crate::meta::MetaStore::new()), None);
        // 朗读关闭且非试听 → 400 tts_disabled
        let resp = synthesize_stream(
            State(state.clone()),
            Json(StreamReq { text: "你好".into(), test: false }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        // 试听不要求开关:模型未就绪(下载中)→ 503 tts_not_ready
        state.tts.set_phase(crate::asr::Phase::Downloading { progress: 0.5 });
        let resp = synthesize_stream(
            State(state.clone()),
            Json(StreamReq { text: "你好".into(), test: true }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        // 文本超长 → 400(在就绪检查之前拦截)
        state.tts.set_phase(crate::asr::Phase::NotReady);
        let long = "字".repeat(MAX_STREAM_TEXT_CHARS + 1);
        let resp = synthesize_stream(
            State(state),
            Json(StreamReq { text: long, test: true }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}

#[cfg(test)]
mod smoke {
    use super::*;

    /// 手动冒烟(需真实模型在 /tmp/combo-tts-smoke):
    /// `cargo test -p combo-cli --lib tts::smoke::tts_synthesize_piper_smoke -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn tts_synthesize_piper_smoke() {
        let svc = Arc::new(TtsService::new(
            std::path::PathBuf::from("/tmp/combo-tts-smoke"),
            TtsModel::PiperZhXiaoya,
        ));
        svc.ensure_ready().await.expect("模型应就绪");
        let synth = svc.synthesizer().expect("合成器应已加载");
        let wav = TtsService::synthesize_blocking(&synth, "你好,这是语音朗读测试。".into(), 1.0)
            .expect("合成应成功");
        assert!(wav.len() > 44, "WAV 应包含音频数据: {} bytes", wav.len());
        assert_eq!(&wav[0..4], b"RIFF");
        let sr = u32::from_le_bytes(wav[24..28].try_into().unwrap());
        let seconds = (wav.len() - 44) as f64 / (sr as f64 * 2.0);
        println!("WAV {} bytes, {}Hz, 约 {:.1}s", wav.len(), sr, seconds);
        assert!(seconds > 0.5, "应合成出可听音频");
        // 语速 2.0 → 时长约为 1.0 的一半(允许 ±30% 抖动)
        let fast = TtsService::synthesize_blocking(&synth, "你好,这是语音朗读测试。".into(), 2.0)
            .expect("快速合成应成功");
        let fast_seconds = (fast.len() - 44) as f64 / (sr as f64 * 2.0);
        println!("2.0x 约 {:.1}s", fast_seconds);
        assert!(
            (fast_seconds - seconds / 2.0).abs() < seconds * 0.3,
            "2.0x 时长应约为 1.0x 的一半: {:.2}s vs {:.2}s",
            fast_seconds,
            seconds
        );
    }

    /// 手动冒烟(需真实模型在 /tmp/combo-tts-smoke):
    /// `cargo test -p combo-cli --lib tts::smoke::tts_stream_smoke -- --ignored --nocapture`
    ///
    /// 验证流式端点:片段逐个下发(NDJSON 行),逗号/句号切开、首尾静音
    /// 已裁剪的 PCM chunk,末行 done。
    #[tokio::test]
    #[ignore]
    async fn tts_stream_smoke() {
        let svc = Arc::new(TtsService::new(
            std::path::PathBuf::from("/tmp/combo-tts-smoke"),
            TtsModel::PiperZhXiaoya,
        ));
        svc.ensure_ready().await.expect("模型应就绪");
        let mut state = AppState::test_state(Arc::new(crate::meta::MetaStore::new()), None);
        state.tts = svc;
        let resp = synthesize_stream(
            State(state),
            Json(StreamReq { text: "你好,这是流式语音测试。第二句来了。".into(), test: true }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let mut stream = resp.into_body().into_data_stream();
        let mut raw = Vec::new();
        while let Some(chunk) = stream.next().await {
            raw.extend_from_slice(&chunk.expect("流不应出错"));
        }
        let text = String::from_utf8(raw).expect("NDJSON 应为 UTF-8");
        let mut chunks = 0usize;
        let mut done = false;
        for line in text.lines() {
            if line.is_empty() {
                continue;
            }
            let v: serde_json::Value = serde_json::from_str(line).expect("每行应为合法 JSON");
            match v["type"].as_str() {
                Some("chunk") => {
                    chunks += 1;
                    assert!(v["pcm"].as_str().is_some_and(|p| !p.is_empty()), "chunk 应携带 PCM");
                    assert!(v["sample_rate"].as_i64().unwrap_or(0) > 0);
                }
                Some("done") => done = true,
                other => panic!("意外的行类型: {other:?} — {line}"),
            }
        }
        // 「你好,」/「这是流式语音测试。」/「第二句来了。」→ 3 个片段
        assert_eq!(chunks, 3, "应切成 3 个片段: {text}");
        assert!(done, "流应以 done 行结束");
    }
}
