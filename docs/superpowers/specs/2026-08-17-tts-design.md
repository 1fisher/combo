# TTS 朗读 agent 回复 — 设计文档

日期:2026-08-17
状态:已批准(方案 A:按句切分 + HTTP 合成)

## 背景与目标

combo 已实现本地 ASR(语音输入,sherpa-onnx + `[asr] model` 配置 + WebSocket 流式
识别)。现在补充对称的 **TTS(语音输出)**:在配置中新增 tts 开关,打开后把 agent
的回复「流式朗读」出来。

决策记录:

- **引擎**:后端 sherpa-onnx TTS(与 ASR 对称,跨平台一致、完全离线)。不用浏览器
  Web Speech API(依赖系统音色、Tauri webview 行为不一),不用 Tauri 原生 TTS
  (浏览器模式不可用)。
- **触发时机**:流式边生成边读。实现方式为用户已批准的**方案 A**——前端按句切分,
  完整句子 POST `/v1/speech` 合成 WAV,`AudioContext` 顺序播放;不做 WebSocket
  全流式管线(复杂度高、对句子级场景收益不明显)。

## 1. 配置(`crates/combo-cli/src/config.rs`)

镜像 `AsrConfig`:

```rust
/// 语音合成(TTS)配置(`[tts]` 段)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TtsConfig {
    /// 朗读开关,默认关闭。
    pub enabled: Option<bool>,
    /// TTS 模型 id(见 tts.rs::TtsModel)。
    pub model: Option<String>,
}
```

- `AppConfig` 新增字段 `pub tts: TtsConfig`(`#[serde(default)]`)。
- `resolve_enabled(&self) -> bool`:`enabled.unwrap_or(false)`。
- `resolve_model(&self) -> crate::tts::TtsModel`:`model` 解析失败回落默认
  `PiperZhXiaoya`(镜像 `AsrConfig::resolve_model`)。
- 新增 `set_tts_enabled(path: &PathBuf, enabled: bool)` 与
  `set_tts_model(path: &PathBuf, model: &str)`(镜像 `set_asr_model`,非法模型 id
  报错),写 TOML `[tts]` 段,跨重启保留。
- `write_default` 模板新增 `[tts]` 注释段(放在 `[asr]` 段之后),说明开关与模型。
- 单元测试:`tts_config_roundtrip`(默认值 / 读写 enabled / 读写 model / 非法 id 报错),
  镜像 `asr_model_config_roundtrip`。

## 2. 后端 `crates/combo-cli/src/tts.rs`(新模块,镜像 asr.rs)

### 模型 `TtsModel` 枚举

下载地址来自已核实的 k2-fsa/sherpa-onnx `tts-models` release 资产:

| id | 资产名 | 大小 | 说明 |
|---|---|---|---|
| `piper-zh-xiaoya` | `vits-piper-zh_CN-xiao_ya-medium-int8.tar.bz2` | 13MB | 中文女声(默认) |
| `piper-zh-chaowen` | `vits-piper-zh_CN-chaowen-medium-int8.tar.bz2` | 13MB | 中文男声 |
| `vits-zh-fanchen-c` | `vits-zh-hf-fanchen-C.tar.bz2` | 113MB | 高质量中文女声(可选) |

- 下载 URL:`https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/<资产名>`,
  `COMBO_TTS_MODEL_URL` 环境变量可整体覆盖(镜像 `COMBO_ASR_MODEL_URL`)。
- 新增模型时同步更新:parse / 下载地址 / 文件查找 / 加载(沿用 asr.rs 的注释约定)。
- 模型根目录与 ASR 共用(见 asr.rs 的 model_dir 逻辑),每个模型放 `<根>/<id>/`
  专属子目录;下载/解压流程尽量复用 asr.rs 既有实现(必要时抽出公共辅助函数,
  避免复制粘贴整套下载/Phase 逻辑)。

### 文件布局与加载

- **piper 结构**(piper-zh-xiaoya / piper-zh-chaowen):`model.onnx` +
  `tokens.txt` + `espeak-ng-data/`。
- **HF 结构**(vits-zh-fanchen-c):`model.onnx` + `tokens.txt` +
  `lexicon.txt` + `data/`。
- 加载使用 sherpa-onnx 1.13.5(已在 Cargo.toml)的 `OfflineTts`:
  `OfflineTtsConfig { model: OfflineTtsModelConfig { vits: VitsModelConfig { model, tokens, lexicon, data_dir, ... } } }`。
  具体字段按模型类型补齐(piper 需要 `data_dir` 指向 espeak-ng-data;HF 需要
  `lexicon` + `data_dir`)。

### 服务 `TtsService`

镜像 `AsrService` 的结构(懒加载 + Phase + 运行时切模型):

```rust
pub struct TtsService {
    current: Mutex<TtsModel>,
    phase: Arc<Mutex<Phase>>,          // 复用/镜像 asr.rs 的 Phase(未就绪/下载中/加载中/就绪/失败)
    model_root: PathBuf,
    inner: Mutex<Option<Arc<OfflineTts>>>,  // 懒加载
    // 下载任务句柄等(镜像 asr.rs)
}
```

- `synthesize(&self, text: &str) -> Result<Vec<u8>>`:取 inner 识别器,
  `tts.synthesize(text)` 得到 f32 samples + sample_rate,转 PCM16 并封装
  44 字节标准 WAV 头返回;未就绪报 `tts_not_ready`。
- 文本长度上限由 serve 层校验(见下)。
- `AppState` 新增字段 `pub tts: Arc<TtsService>`,在 `AppState::new`(serve.rs)
  构造,模型 id 取自 `cfg.tts.resolve_model()`(镜像 asr 的构造,含测试态)。

## 3. API(`crates/combo-cli/src/serve.rs`)

新增路由(挂到与 transcribe 相同的位置,`AppState` 注入):

- `GET /v1/speech/status` → `{ enabled, model, model_label, phase, model_dir, error? }`
  (镜像 `/v1/transcribe/status`;`enabled` 来自 `state.cfg.tts.resolve_enabled()`)。
- `POST /v1/speech/config`,body `{ enabled: bool }` → 调
  `config::set_tts_enabled(default_config_path(), enabled)`,返回 `{ ok }`
  (镜像 `/v1/transcribe/model` 的持久化写法)。
- `POST /v1/speech/model`,body `{ model }` → 校验 id、持久化
  `config::set_tts_model`、`state.tts.set_model(model)` 热切换,返回新的
  status(镜像 `/v1/transcribe/model`)。
- `POST /v1/speech`,body `{ text: String }`:
  - `enabled == false` → 400 `{ code: "tts_disabled" }`(后端配置是开关唯一来源)。
  - `text` 空或超 500 字符 → 400 `{ code: "tts_text_invalid" }`(句子级文本)。
  - 模型未就绪 → 503 `{ code: "tts_not_ready" }`。
  - 成功:`200`,`Content-Type: audio/wav`,body 为 WAV 字节。
  - 文本走 JSON body,无需放宽请求体上限(与 transcribe 的音频流不同)。
- `serve.rs` 的 `AppState` 构造、`build_router` 与测试态同步补齐 `tts` 字段
  (镜像 asr 在 `AppState::new` / `test_state` / integration test 中的注入)。

## 4. 前端

### API 封装(`src/lib/api/index.ts` + `types.ts` 手写 Api 命名空间段)

- `getSpeechStatus()` → `GET /v1/speech/status`,返回
  `Api.SpeechStatus { enabled, model, phase, ... }`。
- `setSpeechEnabled(enabled)` → `POST /v1/speech/config`。
- `setSpeechModel(model)` → `POST /v1/speech/model`。
- `synthesizeSpeech(text)` → `POST /v1/speech`,请求 JSON,响应按
  `arrayBuffer` 读取(`apiRequest` 需支持 ArrayBuffer 响应,或单独用 fetch,
  沿用 `apiRequest` 的 base/token 注入,注意 `ApiError` 的 `code` 字段
  供 `tts_not_ready` / `tts_disabled` 分支)。

### 设置 UI(`src/components/shell/SettingsDialog.tsx`)

新增 `TtsSection`(镜像 `AsrModelSection`,挂在 `<AsrModelSection>` 之后):

- 开关 Toggle:`getSpeechStatus` 的 `enabled` → `setSpeechEnabled`;关闭时
  立即停读(通过共享 store 或事件通知 useSpeechOutput)。
- 模型下拉:`TTS_MODELS` 常量(3 个模型 id + label),切换走
  `setSpeechModel`;文案说明「切换后首次使用自动下载」。
- `useQuery(['tts-status'], getSpeechStatus, { enabled: open })` +
  `useMutation`(镜像 asr 段写法)。

### 朗读 hook(`src/hooks/useSpeechOutput.ts`,新文件)

- **开关**:`useQuery(['tts-status'])` 拿到 `enabled`,仅 enabled 时挂载
  订阅;关闭时停播 + 清缓冲。
- **文本增量**:订阅当前会话的 assistant 消息更新(agentStore / SSE
  `message` 事件),只取 `role === 'assistant'` 的 **text part**;按
  `sessionId` 记录「已合成偏移」(part 内字符偏移),只取新增文本;切换会话
  清零偏移与缓冲。
- **过滤**:跳过代码块围栏(```` ``` ```` 内文本)、tool call/result part、
  thinking part;代码块外文本照常朗读。
- **断句**:缓冲增量文本,按中文/英文句末标点(`。！？!?…;` 与换行)切句;
  单句超过 100 字符强制切(避免长句无停顿);run 完成(`run_complete` /
  finish part)时冲刷剩余缓冲。
- **合成与播放**:完整句子 → `synthesizeSpeech(sentence)` → `AudioContext`
  `decodeAudioData` → FIFO 队列顺序播放;队列中后句失败时跳过继续
  (不阻塞朗读);`AudioContext` 懒创建(浏览器自动播放策略:用户已与页面
  交互过,combo 交互型应用无碍;Tauri webview 同理)。
- **打断**:用户新发消息 / 切换会话 / 关闭开关 / run 被取消 → `stop()`
  (停播当前音频、清 FIFO、abort 进行中的 fetch、清缓冲与偏移)。
- **去重/防抖**:同一文本偏移不重复合成;流式 updated 事件高频时按
  requestAnimationFrame / 小延时合并增量(镜像 Composer 的 asrPending 节奏)。

## 5. 测试

- Rust:
  - `config.rs`:`tts_config_roundtrip`(默认值 / enabled 读写 / model 读写 /
    非法 id 报错),镜像 `asr_model_config_roundtrip`。
  - `tts.rs`:WAV 头构造单测(44 字节头字段:RIFF/WAVE/fmt/data 块、PCM16、
    单声道、采样率透传)、`TtsModel::parse` 别名、`download_url`/`subdir`。
  - `serve.rs`:`/v1/speech/config`、`/v1/speech/model`、`/v1/speech` 的
    enabled/text 校验分支(不下载真实模型,status/400 分支可测;成功分支
    用 `test_state` 不触发加载)。
- 前端:
  - 断句器(可抽成纯函数 `src/lib/ttsSplit.ts` 便于测试):中文标点/英文
    标点/换行/超长强制切/代码块过滤。
  - hook 逻辑:mock fetch + mock `AudioContext`(测试用 `vi.stubGlobal`),
    断言增量合成、打断清空、会话切换重置。
- 全程不下载真实模型;模型下载路径仅在手动运行时触发。

## 6. 文档

- `AGENTS.md` 新增 TTS 段落(镜像 ASR 描述):配置 `[tts] enabled` / `model`、
  `/v1/speech/*` 端点、前端 hook 行为(按句切分、打断规则、代码块过滤)。
