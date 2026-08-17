//! 本地语音识别(ASR):阿里 Paraformer 双语(中英)流式模型经 sherpa-onnx
//! 在线转写,供输入框语音输入使用。
//!
//! - 模型:sherpa-onnx-streaming-paraformer-bilingual-zh-en int8
//!   (encoder 约 165MB + decoder 约 72MB),普通话(含方言口音)+ 英语,
//!   流式识别边说边出字,完全离线运行、不上传任何音频;
//! - 模型文件缺失时由 [`prepare`] 自动从 sherpa-onnx release 下载
//!   (`COMBO_ASR_MODEL_URL` 可覆盖下载地址,国内可指向镜像),
//!   解压到 `<数据目录>/models/` 下,`status` 可轮询下载/加载进度;
//! - `POST /v1/transcribe`:请求体为 16kHz 单声道 PCM16 小端原始音频,
//!   响应 `{ text, lang }`(整段送入流式识别器后收尾);
//! - `GET /v1/transcribe/stream`(WebSocket):客户端持续推送 PCM16 二进制帧,
//!   服务端回发 `{"type":"partial","text":..}` 增量结果;发送
//!   `{"type":"finish"}` 文本帧后回发 `{"type":"final","text":..}` 并关闭。
//!
//! sherpa-rs 0.6 未封装 online(流式)识别器,这里经其 re-export 的
//! `sherpa_rs_sys` 直接调用 sherpa-onnx C API;识别器进程内共享,
//! 所有流操作经 `OnlineRecognizer::ops` 锁串行化保证线程安全,
//! 每个连接/每次转写创建独立的 OnlineStream。
//!
//! 音频由前端负责解码与重采样(AudioWorklet 直接以 16kHz 采集 →
//! Float32 → PCM16),后端只接收原始采样,避免 Rust 侧引入 ffmpeg 等重依赖。

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
use serde_json::json;
use sherpa_rs::sherpa_rs_sys as sys;
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::serve::AppState;

/// 默认模型下载地址(流式 Paraformer 双语 int8,GitHub release)。
const DEFAULT_MODEL_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2";

/// 转写请求体上限(32MB ≈ 16 分钟 16kHz PCM16,足够听写使用)。
const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;

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
    fn name(&self) -> &'static str {
        match self {
            Self::NotReady => "not_ready",
            Self::Downloading { .. } => "downloading",
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Failed(_) => "failed",
        }
    }
}

/// 流式 Paraformer 模型文件三件套。
#[derive(Debug, Clone)]
struct ModelFiles {
    encoder: PathBuf,
    decoder: PathBuf,
    tokens: PathBuf,
}

/// sherpa-onnx online(流式)识别器的原生指针封装。
/// 所有 C API 调用(AcceptWaveform / Decode / 取结果等)都持 `ops` 锁,
/// 使共享同一识别器的多个连接在多线程下串行访问,保证安全。
pub struct OnlineRecognizer {
    recognizer: *const sys::SherpaOnnxOnlineRecognizer,
    ops: Mutex<()>,
}

// 指向 C 对象的裸指针默认不 Send/Sync;所有访问都经 `ops` 锁串行,
// 创建/销毁只在 ensure_ready 的后台线程中发生一次。
unsafe impl Send for OnlineRecognizer {}
unsafe impl Sync for OnlineRecognizer {}

impl OnlineRecognizer {
    /// 从模型文件创建识别器(阻塞,CPU 密集)。
    fn new(files: &ModelFiles) -> anyhow::Result<Self> {
        let encoder = cpath(&files.encoder)?;
        let decoder = cpath(&files.decoder)?;
        let tokens = cpath(&files.tokens)?;
        let provider = CString::new("cpu").unwrap();
        let greedy = CString::new("greedy_search").unwrap();
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4) as i32)
            .unwrap_or(2);

        let mut model_config: sys::SherpaOnnxOnlineModelConfig = unsafe { std::mem::zeroed() };
        model_config.paraformer = sys::SherpaOnnxOnlineParaformerModelConfig {
            encoder: encoder.as_ptr(),
            decoder: decoder.as_ptr(),
        };
        model_config.tokens = tokens.as_ptr();
        model_config.num_threads = threads;
        model_config.provider = provider.as_ptr();

        let mut config: sys::SherpaOnnxOnlineRecognizerConfig = unsafe { std::mem::zeroed() };
        config.feat_config = sys::SherpaOnnxFeatureConfig {
            sample_rate: 16000,
            feature_dim: 80,
        };
        config.model_config = model_config;
        config.decoding_method = greedy.as_ptr();
        // 端点检测:停顿超过阈值即判定一句话结束,提前固化并重置解码状态
        config.enable_endpoint = 1;
        config.rule1_min_trailing_silence = 2.4;
        config.rule2_min_trailing_silence = 1.2;
        config.rule3_min_utterance_length = 20.0;

        let recognizer = unsafe { sys::SherpaOnnxCreateOnlineRecognizer(&config) };
        if recognizer.is_null() {
            anyhow::bail!("初始化流式 Paraformer 识别器失败");
        }
        Ok(Self {
            recognizer,
            ops: Mutex::new(()),
        })
    }

    fn raw(&self) -> *const sys::SherpaOnnxOnlineRecognizer {
        self.recognizer
    }
}

impl Drop for OnlineRecognizer {
    fn drop(&mut self) {
        unsafe { sys::SherpaOnnxDestroyOnlineRecognizer(self.recognizer) };
    }
}

/// 一次听写会话:独占一个 OnlineStream,`finalized` 累计已固化的分段文本。
/// (端点检测触发时把当前结果并入 `finalized` 并重置流,避免解码状态无限增长)
pub struct StreamSession {
    recognizer: Arc<OnlineRecognizer>,
    stream: *const sys::SherpaOnnxOnlineStream,
    finalized: String,
}

unsafe impl Send for StreamSession {}

impl StreamSession {
    fn new(recognizer: Arc<OnlineRecognizer>) -> Self {
        let stream = unsafe { sys::SherpaOnnxCreateOnlineStream(recognizer.raw()) };
        Self {
            recognizer,
            stream,
            finalized: String::new(),
        }
    }

    /// 读取流上的当前(未固化)识别文本。
    fn current_text(&self) -> String {
        unsafe {
            let result = sys::SherpaOnnxGetOnlineStreamResult(self.recognizer.raw(), self.stream);
            if result.is_null() {
                return String::new();
            }
            let text = if (*result).text.is_null() {
                String::new()
            } else {
                CStr::from_ptr((*result).text).to_string_lossy().into_owned()
            };
            sys::SherpaOnnxDestroyOnlineRecognizerResult(result);
            text
        }
    }

    /// 送入一段采样并推进解码,返回累计文本(已固化分段 + 当前部分结果)。
    fn feed(&mut self, sample_rate: u32, samples: &[f32]) -> String {
        let _guard = self.recognizer.ops.lock().unwrap();
        unsafe {
            sys::SherpaOnnxOnlineStreamAcceptWaveform(
                self.stream,
                sample_rate as i32,
                samples.as_ptr(),
                samples.len() as i32,
            );
            while sys::SherpaOnnxIsOnlineStreamReady(self.recognizer.raw(), self.stream) == 1 {
                sys::SherpaOnnxDecodeOnlineStream(self.recognizer.raw(), self.stream);
            }
            if sys::SherpaOnnxOnlineStreamIsEndpoint(self.recognizer.raw(), self.stream) == 1 {
                self.finalized.push_str(&self.current_text());
                sys::SherpaOnnxOnlineStreamReset(self.recognizer.raw(), self.stream);
            }
        }
        let mut text = self.finalized.clone();
        text.push_str(&self.current_text());
        text
    }

    /// 结束会话:收尾解码并返回最终文本。
    fn finish(&mut self) -> String {
        let _guard = self.recognizer.ops.lock().unwrap();
        unsafe {
            sys::SherpaOnnxOnlineStreamInputFinished(self.stream);
            while sys::SherpaOnnxIsOnlineStreamReady(self.recognizer.raw(), self.stream) == 1 {
                sys::SherpaOnnxDecodeOnlineStream(self.recognizer.raw(), self.stream);
            }
        }
        let mut text = self.finalized.clone();
        text.push_str(&self.current_text());
        text
    }
}

impl Drop for StreamSession {
    fn drop(&mut self) {
        unsafe { sys::SherpaOnnxDestroyOnlineStream(self.stream) };
    }
}

/// 本地 ASR 服务:懒加载的流式识别器 + 模型下载状态。
pub struct AsrService {
    /// 模型搜索根目录(`<数据目录>/models`)。
    model_root: PathBuf,
    /// 已加载的识别器(加载一次后常驻)。
    recognizer: OnceLock<Arc<OnlineRecognizer>>,
    /// 下载/加载阶段(供 status 端点与前端进度展示)。
    phase: Mutex<Phase>,
    /// 串行化下载/加载,防止并发触发重复下载。
    prepare_lock: AsyncMutex<()>,
}

impl AsrService {
    pub fn new(model_root: PathBuf) -> Self {
        Self {
            model_root,
            recognizer: OnceLock::new(),
            phase: Mutex::new(Phase::NotReady),
            prepare_lock: AsyncMutex::new(()),
        }
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

    /// 在模型根目录下查找 (encoder, decoder, tokens) 文件。
    /// 优先 int8 量化版;返回 None 表示模型尚未下载。
    fn find_model_files(root: &Path) -> Option<ModelFiles> {
        let mut int8: Option<ModelFiles> = None;
        let mut fp32: Option<ModelFiles> = None;
        for entry in walkdir::WalkDir::new(root).follow_links(false).into_iter().flatten() {
            let name = entry.file_name().to_string_lossy();
            let is_int8 = name == "encoder.int8.onnx";
            if (!is_int8 && name != "encoder.onnx")
                || !entry.metadata().map(|m| m.is_file()).unwrap_or(false)
            {
                continue;
            }
            let Some(dir) = entry.path().parent() else { continue };
            // decoder 与 encoder 保持同量化档位;缺失时回退另一档
            let primary = if is_int8 { "decoder.int8.onnx" } else { "decoder.onnx" };
            let fallback = if is_int8 { "decoder.onnx" } else { "decoder.int8.onnx" };
            let decoder = if dir.join(primary).is_file() {
                dir.join(primary)
            } else if dir.join(fallback).is_file() {
                dir.join(fallback)
            } else {
                continue;
            };
            let tokens = dir.join("tokens.txt");
            if !tokens.is_file() {
                continue;
            }
            let files = ModelFiles {
                encoder: entry.path().to_path_buf(),
                decoder,
                tokens,
            };
            if is_int8 {
                int8 = Some(files);
            } else {
                fp32 = fp32.or(Some(files));
            }
        }
        int8.or(fp32)
    }

    /// 确保模型就绪:缺失则下载,然后加载识别器。幂等,可并发调用。
    pub async fn ensure_ready(self: &Arc<Self>) -> anyhow::Result<()> {
        let _guard = self.prepare_lock.lock().await;
        if self.recognizer.get().is_some() {
            return Ok(());
        }
        if Self::find_model_files(&self.model_root).is_none() {
            if let Err(e) = self.download().await {
                self.set_phase(Phase::Failed(format!("模型下载失败: {e:#}")));
                return Err(e);
            }
        }
        self.set_phase(Phase::Loading);
        let this = self.clone();
        let recognizer = tokio::task::spawn_blocking(move || {
            let files = Self::find_model_files(&this.model_root)
                .ok_or_else(|| anyhow::anyhow!("模型文件缺失"))?;
            OnlineRecognizer::new(&files)
        })
        .await
        .map_err(|e| anyhow::anyhow!("加载线程失败: {e}"))??;
        let _ = self.recognizer.set(Arc::new(recognizer));
        self.set_phase(Phase::Ready);
        Ok(())
    }

    /// 下载模型压缩包并解压到模型根目录。
    async fn download(&self) -> anyhow::Result<()> {
        let url = std::env::var("COMBO_ASR_MODEL_URL").unwrap_or_else(|_| DEFAULT_MODEL_URL.to_string());
        std::fs::create_dir_all(&self.model_root)?;
        let archive_path = self.model_root.join("paraformer-bilingual.tar.bz2.part");

        tracing::info!("开始下载语音识别模型: {url}");
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

        // 解压(阻塞,放后台线程):tar.bz2 → 模型根目录,随后删除压缩包。
        let extract_root = self.model_root.clone();
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let f = std::fs::File::open(&archive_path)?;
            let dec = bzip2::read::BzDecoder::new(f);
            let mut archive = tar::Archive::new(dec);
            archive.unpack(&extract_root)?;
            let _ = std::fs::remove_file(&archive_path);
            Ok(())
        })
        .await
        .map_err(|e| anyhow::anyhow!("解压线程失败: {e}"))??;

        if Self::find_model_files(&self.model_root).is_none() {
            anyhow::bail!("压缩包解压后未找到 encoder/decoder/tokens 模型文件");
        }
        tracing::info!("语音识别模型下载完成: {}", self.model_root.display());
        Ok(())
    }

    /// 整段转写:创建会话,一次性送入全部采样后收尾(阻塞,须在 spawn_blocking 中执行)。
    fn transcribe_blocking(recognizer: &Arc<OnlineRecognizer>, sample_rate: u32, samples: Vec<f32>) -> String {
        let mut session = StreamSession::new(recognizer.clone());
        session.feed(sample_rate, &samples);
        session.finish()
    }
}

/// 路径 → CString(路径含 NUL 时报错)。
fn cpath(p: &Path) -> anyhow::Result<CString> {
    let s = p.display().to_string();
    CString::new(s).map_err(|_| anyhow::anyhow!("模型路径包含非法字符 NUL"))
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
        "model_dir": asr.model_dir().display().to_string(),
    }))
}

/// POST /v1/transcribe/prepare — 触发模型下载/加载(幂等;后台执行,立即返回)。
async fn prepare(State(state): State<AppState>) -> Json<serde_json::Value> {
    let asr = state.asr.clone();
    if asr.recognizer.get().is_none() && !matches!(&*asr.phase.lock().unwrap(), Phase::Downloading { .. }) {
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
    let Some(recognizer) = state.asr.recognizer.get().cloned() else {
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
    Json(json!({ "text": text, "lang": "" })).into_response()
}

/// GET /v1/transcribe/stream — 流式听写 WebSocket。
/// 客户端持续发送 PCM16 二进制帧,服务端回发 partial 增量;
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
    let Some(recognizer) = asr.recognizer.get().cloned() else {
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
    while let Some(msg) = socket.recv().await {
        match msg {
            Ok(Message::Binary(bytes)) => {
                if bytes.is_empty() || bytes.len() % 2 != 0 {
                    continue;
                }
                let samples = pcm16_to_f32(&bytes);
                let session = session.clone();
                let text = tokio::task::spawn_blocking(move || {
                    session.lock().unwrap().feed(sample_rate, &samples)
                })
                .await
                .unwrap_or_default();
                if text != last_sent {
                    last_sent = text.clone();
                    if socket
                        .send(Message::Text(json!({"type": "partial", "text": text}).to_string()))
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

fn err_response(code: StatusCode, message: &str, err_code: Option<&str>) -> Response {
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
    fn find_model_files_prefers_int8() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        let fp32 = root.join("fp32");
        let int8 = root.join("int8");
        std::fs::create_dir_all(&fp32).unwrap();
        std::fs::create_dir_all(&int8).unwrap();
        for d in [&fp32, &int8] {
            std::fs::write(d.join("tokens.txt"), "a 0\n").unwrap();
        }
        std::fs::write(fp32.join("encoder.onnx"), b"x").unwrap();
        std::fs::write(fp32.join("decoder.onnx"), b"x").unwrap();

        // 只有 fp32 时使用 fp32
        let files = AsrService::find_model_files(&root).unwrap();
        assert!(files.encoder.ends_with("encoder.onnx"));
        assert!(files.decoder.ends_with("decoder.onnx"));

        std::fs::write(int8.join("encoder.int8.onnx"), b"x").unwrap();
        std::fs::write(int8.join("decoder.int8.onnx"), b"x").unwrap();
        let files = AsrService::find_model_files(&root).unwrap();
        assert!(files.encoder.ends_with("encoder.int8.onnx"));
        assert!(files.decoder.ends_with("decoder.int8.onnx"));

        // 空目录 → None
        let empty = tempfile::tempdir().unwrap();
        assert!(AsrService::find_model_files(empty.path()).is_none());
    }

    #[test]
    fn find_model_files_decoder_falls_back_to_other_quant() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("models");
        let m = root.join("m");
        std::fs::create_dir_all(&m).unwrap();
        std::fs::write(m.join("encoder.int8.onnx"), b"x").unwrap();
        // decoder 只有 fp32
        std::fs::write(m.join("decoder.onnx"), b"x").unwrap();
        std::fs::write(m.join("tokens.txt"), "a 0\n").unwrap();
        let files = AsrService::find_model_files(&root).unwrap();
        assert!(files.encoder.ends_with("encoder.int8.onnx"));
        assert!(files.decoder.ends_with("decoder.onnx"));

        // 缺 tokens → None
        std::fs::remove_file(m.join("tokens.txt")).unwrap();
        assert!(AsrService::find_model_files(&root).is_none());
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
    fn phase_names_are_stable() {        assert_eq!(Phase::NotReady.name(), "not_ready");
        assert_eq!(Phase::Downloading { progress: 0.5 }.name(), "downloading");
        assert_eq!(Phase::Loading.name(), "loading");
        assert_eq!(Phase::Ready.name(), "ready");
        assert_eq!(Phase::Failed("x".into()).name(), "failed");
    }
}
