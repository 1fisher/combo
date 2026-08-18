//! 本地语音合成(TTS):多模型可选(piper 中文女/男声 int8、HF 高质量中文),
//! 文本 → WAV 字节(16-bit PCM + 44 字节头),供前端朗读 agent 回复。
//!
//! - 模型(`TtsModel`,配置 `[tts] model` 选择,`POST /v1/speech/model` 切换,
//!   未设置/非法回落 `piper-zh-xiaoya`),首次合成自动下载;
//! - 模型文件经 GitHub release 下载(`COMBO_TTS_MODEL_URL` 可覆盖下载地址),
//!   缓存于 `<数据目录>/models/<id>/`,与 ASR 共用同一模型根目录;
//! - `POST /v1/speech` 按句合成,`enabled=false` 时返回 400 `tts_disabled`
//!   (开关以后端配置 `[tts] enabled` 为准)。

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

/// 可选的 TTS 模型。新增模型时同步更新:parse/下载地址/文件查找/加载。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtsModel {
    /// piper 中文女声(int8,~14MB,默认)。
    PiperZhXiaoya,
    /// piper 中文男声(int8,~14MB)。
    PiperZhChaowen,
    /// HF vits 高质量中文女声(~113MB,多说话人,官方示例 sid=100)。
    VitsZhFanchenC,
}

impl TtsModel {
    /// 配置/接口使用的模型 id。
    pub fn id(&self) -> &'static str {
        match self {
            Self::PiperZhXiaoya => "piper-zh-xiaoya",
            Self::PiperZhChaowen => "piper-zh-chaowen",
            Self::VitsZhFanchenC => "vits-zh-fanchen-c",
        }
    }

    /// 用户可读名称。
    pub fn label(&self) -> &'static str {
        match self {
            Self::PiperZhXiaoya => "Piper 小雅(中文女声)",
            Self::PiperZhChaowen => "Piper 超闻(中文男声)",
            Self::VitsZhFanchenC => "VITS 凡尘-C(高质量女声)",
        }
    }

    /// 默认模型下载地址(GitHub release;`COMBO_TTS_MODEL_URL` 可覆盖)。
    fn download_url(&self) -> &'static str {
        match self {
            Self::PiperZhXiaoya => "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-xiao_ya-medium-int8.tar.bz2",
            Self::PiperZhChaowen => "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-chaowen-medium-int8.tar.bz2",
            Self::VitsZhFanchenC => "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-fanchen-C.tar.bz2",
        }
    }

    /// 下载中转文件名(区分模型,避免互相覆盖)。
    fn archive_name(&self) -> &'static str {
        match self {
            Self::PiperZhXiaoya => "piper-zh-xiaoya-int8.tar.bz2.part",
            Self::PiperZhChaowen => "piper-zh-chaowen-int8.tar.bz2.part",
            Self::VitsZhFanchenC => "vits-zh-fanchen-c.tar.bz2.part",
        }
    }

    /// 解析模型 id;未知值返回 None。
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "piper-zh-xiaoya" | "xiao-ya" => Some(Self::PiperZhXiaoya),
            "piper-zh-chaowen" | "chaowen" => Some(Self::PiperZhChaowen),
            "vits-zh-fanchen-c" | "fanchen-c" | "fanchen" => Some(Self::VitsZhFanchenC),
            _ => None,
        }
    }

    /// 该模型在模型根目录下的专属子目录(`<models>/<id>/`;未下载时可能不存在)。
    fn subdir(&self, root: &std::path::Path) -> std::path::PathBuf {
        root.join(self.id())
    }

    /// 多说话人模型的说话人 id(piper 单说话人用 0)。
    fn default_sid(&self) -> i32 {
        match self {
            Self::VitsZhFanchenC => 100,
            _ => 0,
        }
    }

    /// 在模型根目录下查找该模型的文件;未下载返回 None。
    /// 优先模型专属子目录(新布局);找不到再全目录搜索(兼容散落布局)。
    fn find_files(&self, root: &Path) -> Option<TtsFiles> {
        let files = self.find_in(&self.subdir(root));
        if files.is_some() {
            return files;
        }
        self.find_in(root)
    }

    fn find_in(&self, root: &Path) -> Option<TtsFiles> {
        find_tts_files(root)
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
fn find_tts_files(root: &Path) -> Option<TtsFiles> {
    let mut model: Option<std::path::PathBuf> = None;
    let mut tokens: Option<std::path::PathBuf> = None;
    let mut lexicon: Option<std::path::PathBuf> = None;
    let mut has_fst = false;
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
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

/// 把 f32 采样封装为 16-bit PCM WAV 字节(44 字节标准头,单声道)。
fn f32_to_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = samples.len() * 2;
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
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// 统一的离线合成器:屏蔽模型差异,`synthesize` 阻塞(调用方须在
/// spawn_blocking 中执行),多线程下经外层互斥锁串行。
pub struct Synthesizer {
    inner: OfflineTts,
    sid: i32,
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
        Ok(Self { inner, sid: model.default_sid() })
    }

    /// 合成文本,返回 WAV 字节(阻塞)。`speed` 为语速倍率(0.5~2.0,1.0 正常);
    /// piper 直接用,HF vits 由 sherpa-onnx 内部映射为 length_scale=1/speed。
    fn synthesize(&self, text: &str, speed: f32) -> Option<Vec<u8>> {
        let gen = GenerationConfig { sid: self.sid, speed, ..Default::default() };
        let audio = self
            .inner
            .generate_with_config(text, &gen, None::<fn(&[f32], f32) -> bool>)?;
        let sr = self.inner.sample_rate().max(1) as u32;
        Some(f32_to_wav(audio.samples(), sr))
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
        let synth = tokio::task::spawn_blocking(move || this.load_synthesizer())
            .await
            .map_err(|e| anyhow::anyhow!("加载线程失败: {e}"))??;
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

    /// 合成文本 → WAV 字节(阻塞,须在 spawn_blocking 中执行)。
    fn synthesize_blocking(synth: &Synthesizer, text: String, speed: f32) -> anyhow::Result<Vec<u8>> {
        synth
            .synthesize(&text, speed)
            .ok_or_else(|| anyhow::anyhow!("语音合成失败"))
    }
}

/// 单句合成文本上限(字符):句子级朗读,超长拒绝。
const MAX_TEXT_CHARS: usize = 500;

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
    if !state.tts.enabled() {
        return err_response(
            StatusCode::BAD_REQUEST,
            "语音朗读未开启,请先在设置中打开",
            Some("tts_disabled"),
        );
    }
    let text = body.text.trim().to_string();
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

/// 挂载 TTS 路由。
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/speech/status", get(status))
        .route("/v1/speech/prepare", post(prepare))
        .route("/v1/speech/config", post(set_enabled))
        .route("/v1/speech/speed", post(set_speed))
        .route("/v1/speech/model", post(set_model))
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
        assert_eq!(TtsModel::parse("unknown"), None);
        assert_eq!(TtsModel::PiperZhXiaoya.id(), "piper-zh-xiaoya");
        assert_eq!(TtsModel::PiperZhChaowen.id(), "piper-zh-chaowen");
        assert_eq!(TtsModel::VitsZhFanchenC.id(), "vits-zh-fanchen-c");
        assert!(TtsModel::PiperZhXiaoya.download_url().contains("xiao_ya"));
        assert!(TtsModel::PiperZhChaowen.download_url().contains("chaowen"));
        assert!(TtsModel::VitsZhFanchenC.download_url().contains("fanchen-C"));
        assert_eq!(TtsModel::VitsZhFanchenC.default_sid(), 100);
        assert_eq!(TtsModel::PiperZhXiaoya.default_sid(), 0);
    }

    #[test]
    fn f32_to_wav_header_is_standard() {
        let samples = vec![0.0f32, 0.5, -0.5, 1.0, -1.0];
        let wav = f32_to_wav(&samples, 22050);
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

    #[tokio::test]
    async fn speech_endpoint_validation() {
        let state = AppState::test_state(Arc::new(crate::meta::MetaStore::new()), None);
        // 默认配置朗读关闭 → synthesize 返回 400 tts_disabled
        let resp = synthesize(State(state.clone()), Json(SynthesizeReq { text: "你好".into() })).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
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
}
