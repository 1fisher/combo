//! 本地语音识别(ASR):多模型可选(中文 SenseVoice / Moonshine 中文/英文),
//! 经 sherpa-onnx 官方 Rust 封装(`sherpa-onnx` crate)离线转写,
//! 供输入框语音输入使用。
//!
//! - 模型(`AsrModel`,配置 `[asr] model` 选择,`POST /v1/transcribe/model`
//!   运行时切换并写回配置;模型文件按 id 隔离在 `<数据目录>/models/<id>/`):
//!   - `sense-voice`(默认,中文):阿里 SenseVoice-small int8(~230MB),
//!     中英日韩粤多语,自带标点与数字规整(ITN);
//!   - `moonshine-zh`(中文):Moonshine v2 base 中文量化版(~135MB,
//!     encoder_model.ort + decoder_model_merged.ort,中文为主兼顾英文);
//!   - `moonshine-en`(英文):Moonshine v2 base 英文量化版(仅英文)。
//! - 模型文件缺失时由 [`prepare`] 自动从 sherpa-onnx release 下载
//!   (`COMBO_ASR_MODEL_URL` 可覆盖下载地址,国内可指向镜像),
//!   `status` 可轮询下载/加载进度;
//! - `POST /v1/transcribe`:请求体为 16kHz 单声道 PCM16 小端原始音频,
//!   响应 `{ text, lang }`(内部按静音分段解码后拼接,支持长音频);
//! - `GET /v1/transcribe/stream`(WebSocket):客户端持续推送 PCM16 二进制帧,
//!   服务端回发 `{"type":"partial","text":..,"finalized":..}` 增量结果,
//!   `text` 为累计文本(已固化分段 + 当前段推断),`finalized` 为已固化前缀
//!   (单调增长,前端据此稳定保留确认文字、只修正推断尾巴);发送
//!   `{"type":"finish"}` 文本帧后回发 `{"type":"final","text":..}` 并关闭。
//!
//! 各模型均为离线(非流式)识别器:边说边出字由服务端「能量 VAD 分段 +
//! 周期性重解码当前段」模拟——静音超过 1.2s 即固化该段并重置缓冲,
//! 每累计 ~1s 新音频解码一次产出 partial,单段上限 28s(超出强制切分)。
//! 解码经共享识别器的互斥锁串行,多连接安全。
//!
//! 音频由前端负责采集与 PCM 转换(AudioWorklet 直接以 16kHz 采集),
//! 后端只接收原始采样,避免 Rust 侧引入 ffmpeg 等重依赖。

use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;
use sherpa_onnx::{
    OfflineModelConfig, OfflineMoonshineModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    OfflineSenseVoiceModelConfig,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::serve::AppState;

/// 可选的 ASR 模型。新增模型时同步更新:parse/下载地址/文件查找/加载。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsrModel {
    /// 阿里 SenseVoice-small int8:中英日韩粤,自带标点/ITN(默认,中文场景)。
    SenseVoice,
    /// Moonshine v2 base 中文量化版(encoder + merged_decoder,.ort 格式)。
    MoonshineZh,
    /// Moonshine v2 base 英文量化版(仅英文)。
    MoonshineEn,
}

impl AsrModel {
    /// 配置/接口使用的模型 id。
    pub fn id(&self) -> &'static str {
        match self {
            Self::SenseVoice => "sense-voice",
            Self::MoonshineZh => "moonshine-zh",
            Self::MoonshineEn => "moonshine-en",
        }
    }

    /// 用户可读名称。
    pub fn label(&self) -> &'static str {
        match self {
            Self::SenseVoice => "SenseVoice(中文)",
            Self::MoonshineZh => "Moonshine(中文)",
            Self::MoonshineEn => "Moonshine(英文)",
        }
    }

    /// 默认模型下载地址(GitHub release;`COMBO_ASR_MODEL_URL` 可覆盖)。
    fn download_url(&self) -> &'static str {
        match self {
            Self::SenseVoice => "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
            Self::MoonshineZh => "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-zh-quantized-2026-02-27.tar.bz2",
            Self::MoonshineEn => "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2",
        }
    }

    /// 下载中转文件名(区分模型,避免互相覆盖)。
    fn archive_name(&self) -> &'static str {
        match self {
            Self::SenseVoice => "sense-voice-int8.tar.bz2.part",
            Self::MoonshineZh => "moonshine-base-zh-quantized.tar.bz2.part",
            Self::MoonshineEn => "moonshine-base-en-quantized.tar.bz2.part",
        }
    }

    /// 解析模型 id;未知值返回 None。
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "sense-voice" | "sensevoice" => Some(Self::SenseVoice),
            "moonshine-zh" | "moonshine" => Some(Self::MoonshineZh),
            "moonshine-en" => Some(Self::MoonshineEn),
            _ => None,
        }
    }

    /// 该模型在模型根目录下的专属子目录(`<models>/<id>/`;未下载时可能不存在)。
    fn subdir(&self, root: &Path) -> PathBuf {
        root.join(self.id())
    }

    /// 在模型根目录下查找该模型的文件;未下载返回 None。
    /// 优先模型专属子目录(新布局);找不到再全目录搜索(兼容旧版散落布局)。
    fn find_files(&self, root: &Path) -> Option<ModelFiles> {
        let files = self.find_in(&self.subdir(root));
        if files.is_some() {
            return files;
        }
        self.find_in(root)
    }

    fn find_in(&self, dir: &Path) -> Option<ModelFiles> {
        match self {
            Self::SenseVoice => find_sense_voice_files(dir).map(|(model, tokens)| ModelFiles::SenseVoice { model, tokens }),
            Self::MoonshineZh | Self::MoonshineEn => {
                find_moonshine_v2_files(dir).map(|(encoder, decoder, tokens)| ModelFiles::MoonshineV2 {
                    encoder,
                    decoder_merged: decoder,
                    tokens,
                })
            }
        }
    }
}

/// 模型文件集合(按模型分派)。
#[derive(Debug, Clone, PartialEq)]
enum ModelFiles {
    SenseVoice { model: PathBuf, tokens: PathBuf },
    MoonshineV2 { encoder: PathBuf, decoder_merged: PathBuf, tokens: PathBuf },
}

/// 查找 SenseVoice 模型文件(model.int8.onnx 优先于 model.onnx)。
fn find_sense_voice_files(root: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut int8: Option<(PathBuf, PathBuf)> = None;
    let mut fp32: Option<(PathBuf, PathBuf)> = None;
    for entry in walkdir::WalkDir::new(root).follow_links(false).into_iter().flatten() {
        let name = entry.file_name().to_string_lossy();
        let is_model = name == "model.int8.onnx" || name == "model.onnx";
        if !is_model || !entry.metadata().map(|m| m.is_file()).unwrap_or(false) {
            continue;
        }
        let tokens = entry.path().parent()?.join("tokens.txt");
        if !tokens.is_file() {
            continue;
        }
        let pair = (entry.path().to_path_buf(), tokens);
        if name == "model.int8.onnx" {
            int8 = Some(pair);
        } else {
            fp32 = fp32.or(Some(pair));
        }
    }
    int8.or(fp32)
}

/// 查找 Moonshine v2 模型文件(encoder_model.ort + decoder_model_merged.ort)。
fn find_moonshine_v2_files(root: &Path) -> Option<(PathBuf, PathBuf, PathBuf)> {
    for entry in walkdir::WalkDir::new(root).follow_links(false).into_iter().flatten() {
        let name = entry.file_name().to_string_lossy();
        if name != "encoder_model.ort" || !entry.metadata().map(|m| m.is_file()).unwrap_or(false) {
            continue;
        }
        let Some(dir) = entry.path().parent() else { continue };
        let decoder = dir.join("decoder_model_merged.ort");
        let tokens = dir.join("tokens.txt");
        if decoder.is_file() && tokens.is_file() {
            return Some((entry.path().to_path_buf(), decoder, tokens));
        }
    }
    None
}

/// 转写请求体上限(32MB ≈ 16 分钟 16kHz PCM16,足够听写使用)。
const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;

/// 能量 VAD 参数(16kHz):
const VAD_FRAME_SAMPLES: usize = 480; // 30ms 帧
const VAD_SILENCE_RMS: f32 = 0.01; // 低于此 RMS 视为静音(前端已开降噪)
const VAD_MIN_SPEECH_SAMPLES: usize = 16000 * 3 / 10; // 段内至少 0.3s 语音
const VAD_END_SILENCE_SAMPLES: usize = 16000 * 12 / 10; // 尾部静音 1.2s 判段结束
const VAD_SILENCE_KEEP_PAD: usize = 16000 * 3 / 10; // 解码时尾部静音最多保留 0.3s
/// 单段采样上限(28s):离线模型对超长输入效果差,超出强制切分。
const MAX_SEGMENT_SAMPLES: usize = 16000 * 28;
/// partial 解码节奏:每累计 1s 新音频重解码当前段。
const PARTIAL_DECODE_SAMPLES: usize = 16000;

/// ASR 阶段(供前端轮询展示:未就绪 / 下载中 / 加载中 / 就绪 / 失败)。
#[derive(Debug, Clone, PartialEq)]
pub enum Phase {
    NotReady,
    Downloading { progress: f64 },
    Loading,
    Ready,
    Failed(String),
}

impl Phase {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::NotReady => "not_ready",
            Self::Downloading { .. } => "downloading",
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Failed(_) => "failed",
        }
    }
}

/// 统一的离线识别器:屏蔽各模型 API 差异,`transcribe` 阻塞(调用方须在
/// spawn_blocking 中执行),多线程下经外层互斥锁串行。
pub struct Recognizer {
    inner: OfflineRecognizer,
}

impl Recognizer {
    /// 按模型配置创建识别器(阻塞,CPU 密集)。
    fn new(model: AsrModel, files: &ModelFiles, threads: i32) -> anyhow::Result<Self> {
        let mut cfg = OfflineRecognizerConfig::default();
        cfg.model_config = OfflineModelConfig::default();
        cfg.model_config.num_threads = threads;
        match files {
            ModelFiles::SenseVoice { model, tokens } => {
                cfg.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                    model: Some(model.display().to_string()),
                    language: Some("auto".into()),
                    use_itn: true,
                };
                cfg.model_config.tokens = Some(tokens.display().to_string());
            }
            ModelFiles::MoonshineV2 { encoder, decoder_merged, tokens } => {
                cfg.model_config.moonshine = OfflineMoonshineModelConfig {
                    encoder: Some(encoder.display().to_string()),
                    merged_decoder: Some(decoder_merged.display().to_string()),
                    ..Default::default()
                };
                cfg.model_config.tokens = Some(tokens.display().to_string());
                // 中文模型按字符建模(文档要求 cjkchar),英文保持默认
                if model == AsrModel::MoonshineZh {
                    cfg.model_config.modeling_unit = Some("cjkchar".into());
                }
            }
        }
        OfflineRecognizer::create(&cfg)
            .map(|inner| Self { inner })
            .ok_or_else(|| anyhow::anyhow!("初始化 {} 识别器失败", model.label()))
    }

    /// 整段转写(阻塞)。
    fn transcribe(&self, sample_rate: u32, samples: &[f32]) -> String {
        let stream = self.inner.create_stream();
        stream.accept_waveform(sample_rate as i32, samples);
        self.inner.decode(&stream);
        stream
            .get_result()
            .map(|r| r.text)
            .unwrap_or_default()
    }
}

/// 能量 VAD 分段器(纯逻辑,无识别器依赖,便于单测)。
/// 累积采样,静音超阈值或达到单段上限时产出一段。
#[derive(Debug, Default)]
struct Segmenter {
    buffer: Vec<f32>,
    /// 缓冲尾部连续静音采样数。
    tail_silence: usize,
    /// 当前段是否出现过语音(曾有一帧 RMS 超阈值)。
    has_speech: bool,
    /// 当前段内非静音采样数(判段是否够最短语音长度)。
    speech_samples: usize,
}

impl Segmenter {
    fn new() -> Self {
        Self::default()
    }

    /// 追加采样(按 30ms 帧更新静音统计)。
    fn push(&mut self, samples: &[f32]) {
        for frame in samples.chunks(VAD_FRAME_SAMPLES) {
            let rms = frame_rms(frame);
            self.buffer.extend_from_slice(frame);
            if rms < VAD_SILENCE_RMS {
                self.tail_silence += frame.len();
            } else {
                self.tail_silence = 0;
                self.has_speech = true;
                self.speech_samples += frame.len();
            }
        }
        // 纯静音(还没说过话)不积压缓冲,只保留最近 1s
        if !self.has_speech && self.buffer.len() > 16000 {
            let cut = self.buffer.len() - 16000;
            self.buffer.drain(..cut);
        }
    }

    /// 是否应结束当前段(静音超时或达到单段上限)。
    fn segment_done(&self) -> bool {
        self.speech_samples >= VAD_MIN_SPEECH_SAMPLES
            && (self.tail_silence >= VAD_END_SILENCE_SAMPLES
                || self.buffer.len() >= MAX_SEGMENT_SAMPLES)
    }

    /// 取出一段就绪的音频(裁掉多余尾部静音);无就绪段返回 None。
    fn take_ready(&mut self) -> Option<Vec<f32>> {
        if !self.segment_done() {
            return None;
        }
        Some(self.take_buffer())
    }

    /// 收尾:取出剩余缓冲中有语音的段(不足最短语音长度则丢弃)。
    fn take_remainder(&mut self) -> Option<Vec<f32>> {
        if self.speech_samples >= VAD_MIN_SPEECH_SAMPLES {
            Some(self.take_buffer())
        } else {
            self.buffer.clear();
            self.tail_silence = 0;
            self.has_speech = false;
            self.speech_samples = 0;
            None
        }
    }

    fn take_buffer(&mut self) -> Vec<f32> {
        let decode_len = self.decode_len();
        let out = self.buffer.drain(..decode_len).collect::<Vec<f32>>();
        self.buffer.clear();
        self.tail_silence = 0;
        self.has_speech = false;
        self.speech_samples = 0;
        out
    }

    /// 解码长度:缓冲去掉过长的尾部静音(最多保留 0.3s,降低幻觉风险),
    /// 且不超过单段上限。
    fn decode_len(&self) -> usize {
        self.buffer
            .len()
            .saturating_sub(self.tail_silence.saturating_sub(VAD_SILENCE_KEEP_PAD))
            .min(MAX_SEGMENT_SAMPLES)
    }
}

/// 一帧采样的 RMS。
fn frame_rms(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum: f32 = frame.iter().map(|s| s * s).sum();
    (sum / frame.len() as f32).sqrt()
}

/// 一次听写会话:分段器 + 共享识别器,`finalized` 累计已固化分段文本。
pub struct StreamSession {
    recognizer: Arc<Mutex<Recognizer>>,
    segmenter: Segmenter,
    /// 距上次 partial 解码累计的新采样数。
    since_decode: usize,
    finalized: String,
}

impl StreamSession {
    fn new(recognizer: Arc<Mutex<Recognizer>>) -> Self {
        Self {
            recognizer,
            segmenter: Segmenter::new(),
            since_decode: 0,
            finalized: String::new(),
        }
    }

    /// 解码一段音频并追加到已固化文本。
    fn decode_append(&mut self, segment: &[f32]) {
        if segment.len() < VAD_MIN_SPEECH_SAMPLES {
            return;
        }
        let text = self.recognizer.lock().unwrap().transcribe(16000, segment);
        let text = text.trim();
        if !text.is_empty() {
            if !self.finalized.is_empty() {
                self.finalized.push(' ');
            }
            self.finalized.push_str(text);
        }
    }

    /// 送入一段采样,返回(已固化文本, 当前段推断文本)。
    /// 二者分开返回:已固化文本单调增长(前端稳定保留),推断文本可随重解码
    /// 修正,前端据此只更新推断尾巴、不让已确认文字消失。
    fn feed(&mut self, sample_rate: u32, samples: &[f32]) -> (String, String) {
        self.segmenter.push(samples);
        self.since_decode += samples.len();
        while let Some(segment) = self.segmenter.take_ready() {
            self.decode_append(&segment);
            self.since_decode = 0;
        }
        let mut partial = String::new();
        if self.since_decode >= PARTIAL_DECODE_SAMPLES {
            self.since_decode = 0;
            let decode_len = self.segmenter.decode_len();
            if decode_len >= VAD_MIN_SPEECH_SAMPLES {
                let text = self
                    .recognizer
                    .lock()
                    .unwrap()
                    .transcribe(sample_rate, &self.segmenter.buffer[..decode_len]);
                partial = text.trim().to_string();
            }
        }
        (self.finalized.clone(), partial)
    }

    /// 结束会话:解码剩余缓冲并返回最终文本。
    fn finish(&mut self) -> String {
        if let Some(segment) = self.segmenter.take_remainder() {
            self.decode_append(&segment);
        }
        self.finalized.trim().to_string()
    }
}

/// 本地 ASR 服务:当前模型 + 懒加载识别器 + 模型下载状态;支持运行时切换模型。
pub struct AsrService {
    /// 模型搜索根目录(`<数据目录>/models`)。
    model_root: PathBuf,
    /// 当前选用的模型(运行时可切)。
    model: Mutex<AsrModel>,
    /// 已加载的识别器(随模型懒加载;切换模型时清空)。
    recognizer: Mutex<Option<Arc<Mutex<Recognizer>>>>,
    /// 下载/加载阶段(供 status 端点与前端进度展示)。
    phase: Mutex<Phase>,
    /// 串行化下载/加载/切换,防止并发竞争。
    prepare_lock: AsyncMutex<()>,
}

impl AsrService {
    pub fn new(model_root: PathBuf, model: AsrModel) -> Self {
        Self {
            model_root,
            model: Mutex::new(model),
            recognizer: Mutex::new(None),
            phase: Mutex::new(Phase::NotReady),
            prepare_lock: AsyncMutex::new(()),
        }
    }

    /// 当前选用的模型。
    pub fn current_model(&self) -> AsrModel {
        *self.model.lock().unwrap()
    }

    /// 已加载的识别器(未加载返回 None)。
    fn recognizer(&self) -> Option<Arc<Mutex<Recognizer>>> {
        self.recognizer.lock().unwrap().clone()
    }

    /// 模型根目录(展示用)。
    pub fn model_dir(&self) -> &Path {
        &self.model_root
    }

    fn set_phase(&self, phase: Phase) {
        *self.phase.lock().unwrap() = phase;
    }

    fn phase_snapshot(&self) -> Phase {
        self.phase.lock().unwrap().clone()
    }

    /// 切换模型:清空已加载识别器并回到未就绪(与进行中的下载/加载互斥)。
    /// 新模型文件已存在时下次使用直接加载,否则自动下载。
    pub async fn set_model(self: &Arc<Self>, model: AsrModel) {
        let _guard = self.prepare_lock.lock().await;
        if self.current_model() == model {
            return;
        }
        *self.recognizer.lock().unwrap() = None;
        *self.model.lock().unwrap() = model;
        self.set_phase(Phase::NotReady);
    }

    /// 确保当前模型的识别器就绪:缺失则下载,然后加载。幂等,可并发调用。
    pub async fn ensure_ready(self: &Arc<Self>) -> anyhow::Result<()> {
        let _guard = self.prepare_lock.lock().await;
        if self.recognizer().is_some() {
            return Ok(());
        }
        let model = self.current_model();
        if model.find_files(&self.model_root).is_none() {
            if let Err(e) = self.download(model).await {
                self.set_phase(Phase::Failed(format!("模型下载失败: {e:#}")));
                return Err(e);
            }
        }
        self.set_phase(Phase::Loading);
        let this = self.clone();
        let recognizer = tokio::task::spawn_blocking(move || this.load_recognizer())
            .await
            .map_err(|e| anyhow::anyhow!("加载线程失败: {e}"))??;
        *self.recognizer.lock().unwrap() = Some(Arc::new(Mutex::new(recognizer)));
        self.set_phase(Phase::Ready);
        Ok(())
    }

    /// 按当前模型加载识别器(阻塞,CPU 密集)。
    fn load_recognizer(&self) -> anyhow::Result<Recognizer> {
        let model = self.current_model();
        let files = model
            .find_files(&self.model_root)
            .ok_or_else(|| anyhow::anyhow!("模型文件缺失"))?;
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4) as i32)
            .unwrap_or(2);
        Recognizer::new(model, &files, threads)
    }

    /// 下载指定模型的压缩包并解压到其专属子目录。
    async fn download(&self, model: AsrModel) -> anyhow::Result<()> {
        let url = std::env::var("COMBO_ASR_MODEL_URL").unwrap_or_else(|_| model.download_url().to_string());
        let extract_root = model.subdir(&self.model_root);
        std::fs::create_dir_all(&extract_root)?;
        let archive_path = extract_root.join(model.archive_name());

        tracing::info!("开始下载语音识别模型({}): {url}", model.label());
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
                self.set_phase(Phase::Downloading { progress });
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
        tracing::info!("语音识别模型下载完成: {}", extract_root.display());
        Ok(())
    }

    /// 整段转写:经分段器按静音切段解码后拼接(阻塞,须在 spawn_blocking 中执行)。
    fn transcribe_blocking(
        recognizer: &Arc<Mutex<Recognizer>>,
        sample_rate: u32,
        samples: Vec<f32>,
    ) -> String {
        let mut session = StreamSession::new(recognizer.clone());
        session.feed(sample_rate, &samples);
        session.finish()
    }
}

/// PCM16 小端字节 → f32 采样(归一化到 [-1, 1])。
pub fn pcm16_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect()
}

/// GET /v1/transcribe/status — 模型状态(前端轮询下载/加载进度)。
async fn status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let asr = state.asr.clone();
    let phase = asr.phase_snapshot();
    let (progress, error) = match &phase {
        Phase::Downloading { progress } => (Some(*progress), None),
        Phase::Failed(e) => (None, Some(e.clone())),
        _ => (None, None),
    };
    Json(json!({
        "ready": matches!(phase, Phase::Ready),
        "phase": phase.name(),
        "progress": progress,
        "error": error,
        "model": asr.current_model().id(),
        "model_dir": asr.model_dir().display().to_string(),
    }))
}

/// POST /v1/transcribe/prepare — 触发模型下载/加载(幂等;后台执行,立即返回)。
async fn prepare(State(state): State<AppState>) -> Json<serde_json::Value> {
    let asr = state.asr.clone();
    if asr.recognizer().is_none() && !matches!(&*asr.phase.lock().unwrap(), Phase::Downloading { .. }) {
        let worker = asr.clone();
        tokio::spawn(async move {
            if let Err(e) = worker.ensure_ready().await {
                tracing::warn!("语音模型准备失败: {e:#}");
            }
        });
    }
    let phase = asr.phase_snapshot();
    Json(json!({
        "ok": true,
        "phase": phase.name(),
    }))
}

/// POST /v1/transcribe/model — 切换 ASR 模型并持久化到配置 `[asr] model`。
#[derive(Deserialize)]
struct SetModelReq {
    model: String,
}

async fn set_model(
    State(state): State<AppState>,
    Json(body): Json<SetModelReq>,
) -> Response {
    let Some(model) = AsrModel::parse(&body.model) else {
        return err_response(
            StatusCode::BAD_REQUEST,
            "未知语音识别模型,可选:sense-voice(中文)/ moonshine-zh(中文)/ moonshine-en(英文)",
            None,
        );
    };
    // 先持久化配置,再切换运行时(失败早退,不留半切换状态)
    if let Err(e) = crate::config::set_asr_model(&crate::config::default_config_path(), model.id()) {
        return err_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("保存配置失败: {e}"), None);
    }
    state.asr.set_model(model).await;
    tracing::info!("语音识别模型已切换为 {}({})", model.label(), model.id());
    let phase = state.asr.phase_snapshot();
    Json(json!({
        "ok": true,
        "model": model.id(),
        "phase": phase.name(),
    }))
    .into_response()
}

/// POST /v1/transcribe — 转写 16kHz 单声道 PCM16 音频,返回 `{text, lang}`。
async fn transcribe(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    let sample_rate: u32 = q
        .get("sample_rate")
        .and_then(|s| s.parse().ok())
        .unwrap_or(16000);
    if sample_rate != 16000 {
        return err_response(
            StatusCode::BAD_REQUEST,
            "仅支持 16kHz 采样率(请在前端重采样后再上传)",
            None,
        );
    }
    if body.is_empty() {
        return err_response(StatusCode::BAD_REQUEST, "音频数据为空", None);
    }
    if body.len() % 2 != 0 {
        return err_response(StatusCode::BAD_REQUEST, "音频长度非法(PCM16 应为偶数字节)", None);
    }
    let Some(recognizer) = state.asr.recognizer() else {
        return err_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "语音识别模型尚未就绪,请稍后重试",
            Some("asr_not_ready"),
        );
    };
    let samples = pcm16_to_f32(&body);
    let text = tokio::task::spawn_blocking(move || {
        AsrService::transcribe_blocking(&recognizer, sample_rate, samples)
    })
    .await
    .unwrap_or_default();
    let lang = match state.asr.current_model() {
        AsrModel::SenseVoice => "zh",
        AsrModel::MoonshineZh => "zh",
        AsrModel::MoonshineEn => "en",
    };
    Json(json!({ "text": text, "lang": lang })).into_response()
}

/// GET /v1/transcribe/stream — 流式听写 WebSocket。
/// 客户端持续发送 PCM16 二进制帧,服务端回发 partial 增量
/// (`text` 累计文本 + `finalized` 已固化前缀);
/// 发送 `{"type":"finish"}`(或纯文本 `finish`)后回发 final 并关闭。
async fn stream_ws(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let sample_rate: u32 = q
        .get("sample_rate")
        .and_then(|s| s.parse().ok())
        .unwrap_or(16000);
    if sample_rate != 16000 {
        return err_response(StatusCode::BAD_REQUEST, "仅支持 16kHz 采样率", None);
    }
    let asr = state.asr.clone();
    ws.on_upgrade(move |socket| run_stream(socket, asr, sample_rate))
}

async fn run_stream(mut socket: WebSocket, asr: Arc<AsrService>, sample_rate: u32) {
    let Some(recognizer) = asr.recognizer() else {
        let _ = socket
            .send(Message::Text(
                json!({"type": "error", "code": "asr_not_ready", "message": "语音识别模型尚未就绪,请稍后重试"}).to_string(),
            ))
            .await;
        let _ = socket.close().await;
        return;
    };
    let session = Arc::new(Mutex::new(StreamSession::new(recognizer)));
    let mut last_sent = String::new();
    let mut last_finalized = String::new();
    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Binary(bytes)) => {
                if bytes.is_empty() || bytes.len() % 2 != 0 {
                    continue;
                }
                let samples = pcm16_to_f32(&bytes);
                let session = session.clone();
                let (text, finalized) = tokio::task::spawn_blocking(move || {
                    let (finalized, partial) = session.lock().unwrap().feed(sample_rate, &samples);
                    // 累计文本 = 已确认 + 当前段推断(与旧协议一致,向后兼容)
                    let mut text = finalized.clone();
                    if !partial.is_empty() {
                        text.push_str(&partial);
                    }
                    (text, finalized)
                })
                .await
                .unwrap_or_default();
                // 已确认前缀变化也要下发(分段收尾时 text 可能不变,但前端需要
                // 知道边界,才能把推断尾巴固化、避免下一轮回缩时误判)
                if text != last_sent || finalized != last_finalized {
                    last_sent = text.clone();
                    last_finalized = finalized.clone();
                    if socket
                        .send(Message::Text(
                            json!({
                                "type": "partial",
                                "text": text,
                                "finalized": finalized
                            })
                            .to_string(),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
            Ok(Message::Text(txt)) => {
                if !is_finish_message(&txt) {
                    continue;
                }
                let session = session.clone();
                let text = tokio::task::spawn_blocking(move || session.lock().unwrap().finish())
                    .await
                    .unwrap_or_default();
                let _ = socket
                    .send(Message::Text(json!({"type": "final", "text": text}).to_string()))
                    .await;
                break;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }
    let _ = socket.close().await;
}

/// 客户端收尾指令:纯文本 `finish` 或 JSON `{"type":"finish"}`。
fn is_finish_message(txt: &str) -> bool {
    let trimmed = txt.trim();
    if trimmed.eq_ignore_ascii_case("finish") {
        return true;
    }
    serde_json::from_str::<serde_json::Value>(trimmed)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| t == "finish"))
        .unwrap_or(false)
}

pub(crate) fn err_response(code: StatusCode, message: &str, err_code: Option<&str>) -> Response {
    let mut body = json!({ "message": message });
    if let Some(c) = err_code {
        body["code"] = json!(c);
    }
    (code, Json(body)).into_response()
}

/// 挂载 ASR 路由(transcribe 放宽请求体上限以容纳音频字节)。
pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/v1/transcribe",
            post(transcribe).layer(DefaultBodyLimit::max(MAX_AUDIO_BYTES)),
        )
        .route("/v1/transcribe/status", get(status))
        .route("/v1/transcribe/prepare", post(prepare))
        .route("/v1/transcribe/model", post(set_model))
        .route("/v1/transcribe/stream", get(stream_ws))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm16_to_f32_converts_and_normalizes() {
        let bytes: Vec<u8> = [0i16, 16384, -16384, i16::MIN, i16::MAX]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let f = pcm16_to_f32(&bytes);
        assert!((f[0] - 0.0).abs() < 1e-6);
        assert!((f[1] - 0.5).abs() < 1e-3);
        assert!((f[2] + 0.5).abs() < 1e-3);
        assert!((f[3] + 1.0).abs() < 1e-3);
        assert!((f[4] - 1.0).abs() < 1e-3);
        // 奇数字节被忽略(chunks_exact)
        assert_eq!(pcm16_to_f32(&[1, 2, 3]).len(), 1);
    }

    #[test]
    fn asr_model_parse_and_ids() {
        assert_eq!(AsrModel::parse("sense-voice"), Some(AsrModel::SenseVoice));
        assert_eq!(AsrModel::parse(" moonshine "), Some(AsrModel::MoonshineZh));
        assert_eq!(AsrModel::parse("moonshine-zh"), Some(AsrModel::MoonshineZh));
        assert_eq!(AsrModel::parse("moonshine-en"), Some(AsrModel::MoonshineEn));
        assert_eq!(AsrModel::parse("unknown"), None);
        assert_eq!(AsrModel::SenseVoice.id(), "sense-voice");
        assert_eq!(AsrModel::MoonshineZh.id(), "moonshine-zh");
        assert_eq!(AsrModel::MoonshineEn.id(), "moonshine-en");
        assert!(AsrModel::SenseVoice.download_url().contains("sense-voice"));
        assert!(AsrModel::MoonshineZh.download_url().contains("zh"));
        assert!(AsrModel::MoonshineEn.download_url().contains("en"));
    }

    fn write_sense_voice_set(d: &Path, suffix: &str) {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("tokens.txt"), "a 0\n").unwrap();
        std::fs::write(d.join(format!("model{suffix}.onnx")), b"x").unwrap();
    }

    fn write_moonshine_v2_set(d: &Path) {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("encoder_model.ort"), b"x").unwrap();
        std::fs::write(d.join("decoder_model_merged.ort"), b"x").unwrap();
        std::fs::write(d.join("tokens.txt"), "a 0\n").unwrap();
    }

    #[test]
    fn find_sense_voice_files_prefers_int8_and_subdir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        // 新布局:models/sense-voice/
        write_sense_voice_set(&root.join("sense-voice"), ".int8");
        let files = AsrModel::SenseVoice.find_files(&root).unwrap();
        assert!(matches!(&files, ModelFiles::SenseVoice { model, .. } if model.ends_with("model.int8.onnx")));

        // Moonshine 模型不会误识别 SenseVoice 文件
        assert_eq!(AsrModel::MoonshineZh.find_files(&root), None);
        assert_eq!(AsrModel::MoonshineEn.find_files(&root), None);

        // 旧布局兼容:散落在根目录下也能找到
        let root2 = tempfile::tempdir().unwrap();
        write_sense_voice_set(&root2.path().join("legacy"), "");
        let files = AsrModel::SenseVoice.find_files(root2.path()).unwrap();
        assert!(matches!(&files, ModelFiles::SenseVoice { model, .. } if model.ends_with("model.onnx")));

        // 空目录 → None
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(AsrModel::SenseVoice.find_files(empty.path()), None);
    }

    #[test]
    fn find_moonshine_v2_files_isolated_by_subdir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        // zh 与 en 文件名相同,必须按子目录隔离
        write_moonshine_v2_set(&root.join("moonshine-zh"));
        write_moonshine_v2_set(&root.join("moonshine-en"));

        let zh = AsrModel::MoonshineZh.find_files(&root).unwrap();
        let en = AsrModel::MoonshineEn.find_files(&root).unwrap();
        assert!(matches!(&zh, ModelFiles::MoonshineV2 { encoder, .. } if encoder.to_string_lossy().contains("moonshine-zh")));
        assert!(matches!(&en, ModelFiles::MoonshineV2 { encoder, .. } if encoder.to_string_lossy().contains("moonshine-en")));

        // SenseVoice 不会误识别 v2 文件
        assert_eq!(AsrModel::SenseVoice.find_files(&root), None);

        // 缺 decoder/tokens → None
        let incomplete = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(incomplete.path().join("moonshine-zh")).unwrap();
        std::fs::write(incomplete.path().join("moonshine-zh/encoder_model.ort"), b"x").unwrap();
        assert_eq!(AsrModel::MoonshineZh.find_files(incomplete.path()), None);
    }

    #[tokio::test]
    async fn set_model_resets_recognizer_and_phase() {
        let service = Arc::new(AsrService::new(PathBuf::from("/nonexistent"), AsrModel::MoonshineEn));
        service.set_phase(Phase::Ready);

        service.set_model(AsrModel::MoonshineZh).await;
        assert_eq!(service.current_model(), AsrModel::MoonshineZh);
        assert_eq!(service.phase_snapshot(), Phase::NotReady);

        // 相同模型幂等:不重置 phase
        service.set_phase(Phase::Ready);
        service.set_model(AsrModel::MoonshineZh).await;
        assert_eq!(service.phase_snapshot(), Phase::Ready);
    }

    #[test]
    fn segmenter_cuts_on_trailing_silence() {
        let mut seg = Segmenter::new();
        // 0.5s 语音 + 1.3s 静音
        let speech = vec![0.3f32; 16000 / 2];
        let silence = vec![0.0f32; 16000 * 13 / 10];
        seg.push(&speech);
        assert!(seg.take_ready().is_none(), "静音不足不应切段");
        seg.push(&silence);
        let out = seg.take_ready().expect("尾部静音超时应切段");
        // 裁掉多余静音后长度 = 0.5s 语音 + 0.3s 保留静音
        assert_eq!(out.len(), 16000 / 2 + VAD_SILENCE_KEEP_PAD);
        assert!(seg.take_ready().is_none());
        assert!(seg.take_remainder().is_none());
    }

    #[test]
    fn segmenter_forces_cut_at_max_length() {
        let mut seg = Segmenter::new();
        // 持续语音超过 28s 上限
        let chunk = vec![0.3f32; 16000];
        for _ in 0..30 {
            seg.push(&chunk);
        }
        let out = seg.take_ready().expect("超长应强制切段");
        assert_eq!(out.len(), MAX_SEGMENT_SAMPLES);
    }

    #[test]
    fn segmenter_drops_long_pure_silence_and_remainder() {
        let mut seg = Segmenter::new();
        // 纯静音 3s:缓冲只保留最近 1s,且不产出段
        seg.push(&vec![0.0f32; 16000 * 3]);
        assert!(seg.buffer.len() <= 16000);
        assert!(seg.take_ready().is_none());
        // 尾部补 0.4s 语音,收尾应产出
        seg.push(&vec![0.3f32; 16000 * 4 / 10]);
        let out = seg.take_remainder().expect("有语音应收尾产出");
        assert!(out.len() >= 16000 * 4 / 10);
    }

    #[test]
    fn segmenter_too_short_speech_is_dropped() {
        let mut seg = Segmenter::new();
        // 0.1s 语音 + 静音:不足最短语音长度,整段丢弃
        seg.push(&vec![0.3f32; 1600]);
        seg.push(&vec![0.0f32; 16000 * 2]);
        assert!(seg.take_ready().is_none());
        assert!(seg.take_remainder().is_none());
        assert!(seg.buffer.is_empty());
    }

    #[test]
    fn finish_message_forms_are_recognized() {
        assert!(is_finish_message("finish"));
        assert!(is_finish_message(" FINISH \n"));
        assert!(is_finish_message(r#"{"type":"finish"}"#));
        assert!(!is_finish_message(r#"{"type":"partial"}"#));
        assert!(!is_finish_message(""));
        assert!(!is_finish_message("hello"));
    }

    #[tokio::test]
    async fn transcribe_returns_503_when_model_missing() {
        let state = AppState::test_state(
            Arc::new(crate::meta::MetaStore::new()),
            None,
        );
        let resp = transcribe(
            axum::extract::State(state),
            axum::extract::Query(std::collections::HashMap::new()),
            Bytes::from_static(&[0u8, 0, 0, 0]),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn phase_names_are_stable() {
        assert_eq!(Phase::NotReady.name(), "not_ready");
        assert_eq!(Phase::Downloading { progress: 0.5 }.name(), "downloading");
        assert_eq!(Phase::Loading.name(), "loading");
        assert_eq!(Phase::Ready.name(), "ready");
        assert_eq!(Phase::Failed("x".into()).name(), "failed");
    }
}
