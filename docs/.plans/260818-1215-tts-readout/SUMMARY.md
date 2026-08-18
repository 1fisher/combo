# TTS 朗读 agent 回复 Implementation Plan

> **For crush agents:** Use the `execute-plan` skill to execute this plan phase-by-phase.
> Tasks map 1:1 to phases; each `- [ ]` step is a sub-item within its phase.
> Use checkbox (`- [ ]`) syntax for tracking. Mark phases `[-]` in-progress, `[x]` done.

**Goal:** 在配置中新增 `[tts] enabled` 开关与模型选择,打开后把 agent 的回复流式按句朗读出来(前端断句 → `POST /v1/speech` 后端 sherpa-onnx 合成 WAV → AudioContext 顺序播放)。

**Architecture:** 后端新增 `tts.rs` 模块(镜像 `asr.rs`):`TtsService` 懒加载 sherpa-onnx `OfflineTts`,`POST /v1/speech` 按句合成 WAV(PCM16 + 44 字节头),开关 `[tts] enabled` 与模型 `[tts] model` 写入 TOML 配置。前端新增 `useSpeechOutput` hook:订阅 agentStore 当前会话 assistant 文本增量,按句末标点/换行断句(跳过代码块围栏),完整句子经 HTTP 合成后排队播放;新发消息/切会话/关开关/run 出错即打断。

**Tech Stack:** Rust(sherpa-onnx 1.13.5 `OfflineTts`、axum、rusqlite、toml)、React 19 + Zustand + TanStack Query、Vitest。

**已核实的模型资产(k2-fsa/sherpa-onnx `tts-models` release,`gh api` 确认):**
- `vits-piper-zh_CN-xiao_ya-medium-int8.tar.bz2`(14MB,女声,默认)
- `vits-piper-zh_CN-chaowen-medium-int8.tar.bz2`(14MB,男声)
- `vits-zh-hf-fanchen-C.tar.bz2`(113MB,高质量女声)

**已核实的加载配置(解压检查 + sherpa-onnx 官方脚本):**
- piper zh 与 fanchen-C 统一:`model=*.onnx` + `tokens=tokens.txt` + `lexicon=lexicon.txt` + **顶层 `rule_fsts` = `phone.fst,date.fst,number.fst`**(逗号拼接,文件在模型根目录),无需 data_dir/dict_dir(fanchen-C 的 `dict/` 目录未使用)。
- fanchen-C 是多说话人模型,官方示例用 **`sid=100`**;piper 用 `sid=0`。
- sherpa-onnx crate 无 feature 开关,`OfflineTts` 默认可用,无需改 Cargo.toml。

---

### Task 1: TTS 模型枚举 + 配置段 `[tts]`

**Files:**
- Create: `crates/combo-cli/src/tts.rs`(本任务只写 TtsModel 枚举部分)
- Modify: `crates/combo-cli/src/lib.rs`(注册 `pub mod tts;`)
- Modify: `crates/combo-cli/src/config.rs`(`TtsConfig` + `set_tts_enabled`/`set_tts_model` + 模板 + 单测)

- [x] **Step 1: 注册模块 + 写 TtsModel 枚举与单测**

先创建 `crates/combo-cli/src/lib.rs` 追加(在 `pub mod asr;` 行后):

```rust
pub mod tts;
```

创建 `crates/combo-cli/src/tts.rs`,本任务先写模型枚举部分(文件末尾附带单测):

```rust
//! 本地语音合成(TTS):多模型可选(piper 中文女/男声 int8、HF 高质量中文),
//! 文本 → WAV 字节(16-bit PCM + 44 字节头),供前端朗读 agent 回复。
//!
//! - 模型(`TtsModel`,配置 `[tts] model` 选择,`POST /v1/speech/model` 切换,
//!   未设置/非法回落 `piper-zh-xiaoya`),首次合成自动下载;
//! - 模型文件经 GitHub release 下载(`COMBO_TTS_MODEL_URL` 可覆盖下载地址),
//!   缓存于 `<数据目录>/models/<id>/`,与 ASR 共用同一模型根目录;
//! - `POST /v1/speech` 按句合成,`enabled=false` 时返回 400 `tts_disabled`
//!   (开关以后端配置 `[tts] enabled` 为准)。

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
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
```

- [x] **Step 2: 写 config.rs 的 TtsConfig 与读写函数(含单测)**

在 `crates/combo-cli/src/config.rs` 中:

(a) `AppConfig` 结构体 `pub asr: AsrConfig,` 行后加(第 295-297 行区域):

```rust
    /// 语音合成(TTS)设置。
    #[serde(default)]
    pub tts: TtsConfig,
```

(b) `AsrConfig` impl 块结束后(第 316 行后)追加:

```rust
/// 语音合成(TTS)配置(`[tts]` 段)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TtsConfig {
    /// 朗读开关,默认关闭。
    pub enabled: Option<bool>,
    /// TTS 模型 id:piper-zh-xiaoya(默认)/ piper-zh-chaowen / vits-zh-fanchen-c。
    pub model: Option<String>,
}

impl TtsConfig {
    /// 朗读开关;未设置默认关闭。
    pub fn resolve_enabled(&self) -> bool {
        self.enabled.unwrap_or(false)
    }

    /// 解析为模型枚举;未设置或非法值回落默认(piper-zh-xiaoya)。
    pub fn resolve_model(&self) -> crate::tts::TtsModel {
        self.model
            .as_deref()
            .and_then(crate::tts::TtsModel::parse)
            .unwrap_or(crate::tts::TtsModel::PiperZhXiaoya)
    }
}
```

(c) `set_asr_model` 函数(第 716-724 行)后追加:

```rust
/// 设置语音合成(TTS)开关,写入 `[tts] enabled`,跨重启保留。
pub fn set_tts_enabled(path: &PathBuf, enabled: bool) -> Result<()> {
    let mut cfg = load_config(path)?;
    cfg.tts.enabled = Some(enabled);
    write_config(path, &cfg)
}

/// 设置语音合成(TTS)模型,写入 `[tts] model = "<id>"`,跨重启保留。
pub fn set_tts_model(path: &PathBuf, model: &str) -> Result<()> {
    if crate::tts::TtsModel::parse(model).is_none() {
        return Err(anyhow::anyhow!("未知 TTS 模型 id: {model}"));
    }
    let mut cfg = load_config(path)?;
    cfg.tts.model = Some(model.to_string());
    write_config(path, &cfg)
}
```

(d) `write_default` 模板中 `[asr]` 段(第 820-825 行)后追加:

```toml
# ========== 语音合成(TTS)==========
# 朗读 agent 回复的本地模型:
#   piper-zh-xiaoya(中文女声,默认)/ piper-zh-chaowen(中文男声)/ vits-zh-fanchen-c(高质量女声)。
# 首次使用自动下载模型文件;也可在应用「设置」中打开朗读开关并切换模型。
# [tts]
# enabled = false
# model = "piper-zh-xiaoya"
```

(e) `asr_model_config_roundtrip` 测试(第 1026-1042 行)后追加:

```rust
    #[test]
    fn tts_config_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("combo-cli.toml");
        // 未设置时默认关闭 + 默认模型(中文女声)
        assert_eq!(AppConfig::default().tts.resolve_enabled(), false);
        assert_eq!(AppConfig::default().tts.resolve_model(), crate::tts::TtsModel::PiperZhXiaoya);
        // 非法模型值同样回落默认
        let cfg: AppConfig = toml::from_str(r#"[tts]
model = "nope""#).unwrap();
        assert_eq!(cfg.tts.resolve_model(), crate::tts::TtsModel::PiperZhXiaoya);

        // 写入 → 重读生效
        set_tts_enabled(&path, true).unwrap();
        set_tts_model(&path, "vits-zh-fanchen-c").unwrap();
        let cfg = AppConfig::load_or_create(&path).unwrap();
        assert!(cfg.tts.resolve_enabled());
        assert_eq!(cfg.tts.resolve_model(), crate::tts::TtsModel::VitsZhFanchenC);

        // 非法 id 拒绝写入
        assert!(set_tts_model(&path, "unknown").is_err());
    }
```

(f) 第 1047 行的 `resolve_prefers_cli_over_file` 测试的 `AppConfig { ... }` 字面量中,`asr: AsrConfig::default(),` 行后加 `tts: TtsConfig::default(),`(该测试是显式全字段字面量,不加会编译失败;第 1112 行用 `..Default::default()` 无需改)。

- [x] **Step 3: 运行测试验证**

Run: `cargo test -p combo-cli tts_config_roundtrip tts_model_parse_and_ids`
Expected: 两个测试 PASS;`cargo build -p combo-cli` 无编译错误。

- [x] **Step 4: Commit**

```bash
git add crates/combo-cli/src/tts.rs crates/combo-cli/src/lib.rs crates/combo-cli/src/config.rs
git commit -m "feat: TTS 模型枚举与 [tts] 配置段(开关+模型)"
```

---

### Task 2: TTS 服务(文件查找 + WAV 头 + 合成器 + TtsService)

**Files:**
- Modify: `crates/combo-cli/src/tts.rs`(追加 TtsFiles 查找、f32_to_wav、Synthesizer、TtsService)

- [x] **Step 1: 写单测(f32_to_wav 头字段、find_tts_files)**

在 `crates/combo-cli/src/tts.rs` 的 `mod tests` 中追加:

```rust
    use std::io::Write;

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
        assert!(files.model.ends_with(".onnx"));
        assert!(files.tokens.ends_with("tokens.txt"));
        assert!(files.lexicon.is_some());
        assert!(files.rule_fsts.is_some(), "应识别 fst 规则文件");
        // 缺 tokens 视为未就绪
        std::fs::remove_file(root.join("tokens.txt")).unwrap();
        assert!(TtsModel::PiperZhXiaoya.find_files(&root).is_none());
    }
```

- [x] **Step 2: 运行确认失败**

Run: `cargo test -p combo-cli find_tts_files_detects_layout`
Expected: 编译失败(`f32_to_wav`/`find_files`/`TtsFiles` 不存在)。

- [x] **Step 3: 实现 TtsFiles 查找 + WAV 头**

在 `crates/combo-cli/src/tts.rs` 的 `impl TtsModel` 块内、`default_sid` 后追加:

```rust
    /// 在模型根目录下查找该模型的文件;未下载返回 None。
    /// 优先模型专属子目录(新布局);找不到再全目录搜索(兼容散落布局)。
    fn find_files(&self, root: &std::path::Path) -> Option<TtsFiles> {
        let files = self.find_in(&self.subdir(root));
        if files.is_some() {
            return files;
        }
        self.find_in(root)
    }

    fn find_in(&self, root: &std::path::Path) -> Option<TtsFiles> {
        find_tts_files(root)
    }
```

`impl TtsModel` 块结束后追加:

```rust
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
fn find_tts_files(root: &std::path::Path) -> Option<TtsFiles> {
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
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}
```

- [x] **Step 4: 实现 Synthesizer + TtsService(下载/加载/合成)**

`f32_to_wav` 后追加(文件顶部需加 imports,见 Step 5):

```rust
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

    /// 合成文本,返回 WAV 字节(阻塞)。
    fn synthesize(&self, text: &str) -> Option<Vec<u8>> {
        let gen = GenerationConfig { sid: self.sid, ..Default::default() };
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
            synth: Mutex::new(None),
            phase: Mutex::new(crate::asr::Phase::NotReady),
            prepare_lock: AsyncMutex::new(()),
        }
    }

    /// 当前选用的模型。
    pub fn current_model(&self) -> TtsModel {
        *self.model.lock().unwrap()
    }

    /// 已加载的合成器(未加载返回 None)。
    pub(crate) fn synthesizer(&self) -> Option<Arc<Synthesizer>> {
        self.synth.lock().unwrap().clone()
    }

    /// 模型根目录(展示用)。
    pub fn model_dir(&self) -> &std::path::Path {
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
    fn synthesize_blocking(synth: &Synthesizer, text: String) -> anyhow::Result<Vec<u8>> {
        synth
            .synthesize(&text)
            .ok_or_else(|| anyhow::anyhow!("语音合成失败"))
    }
}
```

- [x] **Step 5: 补文件顶部 imports**

`crates/combo-cli/src/tts.rs` 顶部(在 `//!` 文档注释后)加:

```rust
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;
use futures::StreamExt;
use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsVitsModelConfig};
```

(注意:`std::path::Path` 用于 `subdir`/`find_files` 签名,`use std::path::Path` 后 `subdir` 签名里的 `&std::path::Path` 可保留全限定写法,二者并存不冲突;`PathBuf` 用全限定 `std::path::PathBuf`。)

- [x] **Step 6: 运行测试验证**

Run: `cargo test -p combo-cli tts`
Expected: `tts_model_parse_and_ids`、`f32_to_wav_header_is_standard`、`find_tts_files_detects_layout` 全部 PASS;`cargo build -p combo-cli` 无错误。

- [x] **Step 7: Commit**

```bash
git add crates/combo-cli/src/tts.rs
git commit -m "feat: TTS 合成服务(模型查找/WAV 封装/sherpa-onnx 懒加载)"
```

---

### Task 3: HTTP 端点 + serve 接线

**Files:**
- Modify: `crates/combo-cli/src/asr.rs`(`Phase::name` 与 `err_response` 改 `pub(crate)`)
- Modify: `crates/combo-cli/src/tts.rs`(追加 status/set_enabled/set_model/synthesize 端点 + router + 端点测试)
- Modify: `crates/combo-cli/src/serve.rs`(AppState 字段 + new/test_state 构造 + router merge)
- Modify: `crates/combo-cli/tests/combo_cli_serve_integration_test.rs`(两处 AppState 字面量加 tts 字段)

- [x] **Step 1: asr.rs 暴露两个辅助项**

`crates/combo-cli/src/asr.rs` 两处改动:

(a) 第 217 行 `fn name(&self)` 改为 `pub(crate) fn name(&self)`;
(b) 第 825 行 `fn err_response(...)` 改为 `pub(crate) fn err_response(...)`。

- [x] **Step 2: tts.rs 追加端点与路由(含单测)**

在 `crates/combo-cli/src/tts.rs` 的 `impl TtsService` 块结束后追加:

```rust
/// 单句合成文本上限(字符):句子级朗读,超长拒绝。
const MAX_TEXT_CHARS: usize = 500;

/// GET /v1/speech/status — TTS 状态(开关 + 模型 + 下载/加载进度)。
async fn status(State(state): State<AppState>) -> Json<serde_json::Value> {
    let tts = state.tts.clone();
    let enabled = crate::config::AppConfig::load_or_create(&crate::config::default_config_path())
        .map(|c| c.tts.resolve_enabled())
        .unwrap_or(false);
    let phase = tts.phase_snapshot();
    let (progress, error) = match &phase {
        crate::asr::Phase::Downloading { progress } => (Some(*progress), None),
        crate::asr::Phase::Failed(e) => (None, Some(e.clone())),
        _ => (None, None),
    };
    Json(serde_json::json!({
        "enabled": enabled,
        "ready": matches!(phase, crate::asr::Phase::Ready),
        "phase": phase.name(),
        "progress": progress,
        "error": error,
        "model": tts.current_model().id(),
        "model_dir": tts.model_dir().display().to_string(),
    }))
}

/// POST /v1/speech/config — 打开/关闭朗读,写入配置 `[tts] enabled`。
#[derive(Deserialize)]
struct SetEnabledReq {
    enabled: bool,
}

async fn set_enabled(
    State(_state): State<AppState>,
    Json(body): Json<SetEnabledReq>,
) -> Response {
    if let Err(e) = crate::config::set_tts_enabled(&crate::config::default_config_path(), body.enabled) {
        return err_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("保存配置失败: {e}"),
            None,
        );
    }
    tracing::info!("语音朗读已{}", if body.enabled { "开启" } else { "关闭" });
    Json(serde_json::json!({ "ok": true, "enabled": body.enabled })).into_response()
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
    Json(serde_json::json!({
        "ok": true,
        "model": model.id(),
        "phase": phase.name(),
    }))
    .into_response()
}

/// POST /v1/speech — 合成单句文本为 WAV(响应体为 audio/wav 字节)。
async fn synthesize(
    State(state): State<AppState>,
    Json(body): Json<SynthesizeReq>,
) -> Response {
    let enabled = crate::config::AppConfig::load_or_create(&crate::config::default_config_path())
        .map(|c| c.tts.resolve_enabled())
        .unwrap_or(false);
    if !enabled {
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
    let Some(synth) = state.tts.synthesizer() else {
        return err_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "语音合成模型尚未就绪,请稍后重试",
            Some("tts_not_ready"),
        );
    };
    let wav = match tokio::task::spawn_blocking(move || TtsService::synthesize_blocking(&synth, text))
        .await
    {
        Ok(Ok(wav)) => wav,
        Ok(Err(e)) | Err(e) => {
            tracing::warn!("语音合成失败: {e:#}");
            return err_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "语音合成失败,请稍后重试",
                None,
            );
        }
    };
    (StatusCode::OK, [("Content-Type", "audio/wav")], axum::body::Body::from(wav)).into_response()
}

#[derive(Deserialize)]
struct SynthesizeReq {
    text: String,
}

/// 挂载 TTS 路由。
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/speech/status", get(status))
        .route("/v1/speech/config", post(set_enabled))
        .route("/v1/speech/model", post(set_model))
        .route("/v1/speech", post(synthesize))
}
```

文件顶部 imports 追加:

```rust
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::asr::err_response;
use crate::serve::AppState;
```


`mod tests` 追加(只测 enabled/文本校验分支,不触发真实模型加载):

```rust
    #[tokio::test]
    async fn speech_endpoint_validation() {
        let state = AppState::test_state(
            Arc::new(crate::meta::MetaStore::new()),
            None,
        );
        // 默认配置朗读关闭 → 400 tts_disabled
        let app = crate::serve::build_router(state, Vec::new(), None);
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/v1/speech")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(r#"{"text":"你好"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        // status 端点返回 enabled=false 与默认模型
        let app = crate::serve::build_router(
            AppState::test_state(Arc::new(crate::meta::MetaStore::new()), None),
            Vec::new(),
            None,
        );
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/v1/speech/status")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["enabled"], serde_json::Value::Bool(false));
        assert_eq!(v["model"], serde_json::json!("piper-zh-xiaoya"));
    }
```

(注:需要 `use crate::serve::AppState;` 与 `use std::sync::Arc;` 已在 tts.rs 顶部。`MetaStore::new` 路径按实际模块调整:`crate::meta::MetaStore`。)

- [x] **Step 3: serve.rs 接线**

`crates/combo-cli/src/serve.rs` 四处改动:

(a) 顶部 `use crate::asr;` 后加 `use crate::tts;`;

(b) `AppState` 结构体 `pub asr: Arc<asr::AsrService>,` 行后加:

```rust
    /// 本地语音合成(piper 中文 / HF 高质量,朗读 agent 回复)。
    pub tts: Arc<tts::TtsService>,
```

(c) `AppState::new` 中 `asr:` 构造块后加(第 116 行 `)),` 之后):

```rust
            // TTS 模型取自配置 [tts] model(未设置/非法回落 piper-zh-xiaoya)
            tts: Arc::new(tts::TtsService::new(
                crate::paths::default_data_dir().join("models"),
                AppConfig::load_or_create(&crate::config::default_config_path())
                    .map(|c| c.tts.resolve_model())
                    .unwrap_or(tts::TtsModel::PiperZhXiaoya),
            )),
```

(d) `test_state` 中 `asr:` 构造块后加:

```rust
            // 指向临时目录下的空路径:测试中模型永远未就绪(speech 返回 503)
            tts: Arc::new(tts::TtsService::new(
                std::env::temp_dir().join("combo-tts-test-models"),
                tts::TtsModel::PiperZhXiaoya,
            )),
```

(e) `build_router` 中 `.merge(asr::router())` 行后加:

```rust
        // ---- 本地语音合成(TTS) ----
        .merge(tts::router())
```

- [x] **Step 4: integration test 两处字面量加 tts 字段**

`crates/combo-cli/tests/combo_cli_serve_integration_test.rs` 两处 `asr: Arc::new(...)` 行后各加:

```rust
        tts: Arc::new(combo_cli::tts::TtsService::new(
            std::env::temp_dir().join("combo-tts-test-models"),
            combo_cli::tts::TtsModel::PiperZhXiaoya,
        )),
```

- [x] **Step 5: 运行测试验证**

Run: `cargo test -p combo-cli`
Expected: 全部测试 PASS(含新增 `speech_endpoint_validation`),无编译错误。

- [x] **Step 6: Commit**

```bash
git add crates/combo-cli/src/asr.rs crates/combo-cli/src/tts.rs crates/combo-cli/src/serve.rs crates/combo-cli/tests/combo_cli_serve_integration_test.rs
git commit -m "feat: /v1/speech/* 端点与 TTS 服务接线"
```

---

### Task 4: 前端 API 层

**Files:**
- Modify: `src/lib/api/client.ts`(新增 `apiRequestBinary`,ArrayBuffer 响应)
- Modify: `src/lib/api/index.ts`(新增 speech 封装)
- Modify: `src/lib/api/types.ts`(Api 命名空间追加 SpeechStatus/SpeechConfigResult/SpeechModelResult)

- [x] **Step 1: client.ts 新增 apiRequestBinary**

`src/lib/api/client.ts` 的 `apiRequestRaw` 函数后追加:

```ts
/**
 * 二进制响应版请求(如 TTS 合成返回 WAV):响应按 ArrayBuffer 读取,
 * 错误响应仍按 JSON 解析为 ApiError;支持外部 AbortSignal(打断朗读)。
 */
export async function apiRequestBinary(
  path: string,
  opts: {
    method?: string;
    query?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<ArrayBuffer> {
  const base = getProxyBaseUrl();
  const q = new URLSearchParams(opts.query ?? {});
  if (!q.has('client_id')) q.set('client_id', getClientId());
  const token = getAccessToken();
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ac = new AbortController();
  const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  const signal = opts.signal ?? ac.signal;
  let res: Response;
  try {
    const url = `${base}${path}?${q.toString()}`;
    const p2p = getP2pTransport();
    const init = {
      method: opts.method ?? 'POST',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal,
    };
    res = p2p?.isReady() ? await p2p.fetch(url, init) : await fetch(url, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError(0, '请求已取消');
    }
    throw new ApiError(0, 'network error');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { message?: string; code?: string };
      if (j.message) message = j.message;
      code = j.code;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message, code);
  }
  return res.arrayBuffer();
}
```

- [x] **Step 2: types.ts 追加类型**

`src/lib/api/types.ts` 的 `TranscribeResult` 类型结束后、命名空间闭合 `}` 前追加:

```ts
  // ---------- 本地语音合成(TTS,piper 中文 / HF 高质量) ----------

  /** TTS 开关+模型状态:GET /v1/speech/status 响应。 */
  export type SpeechStatus = {
    enabled: boolean;
    ready: boolean;
    phase: TranscribePhase;
    /** downloading 阶段 0~1。 */
    progress?: number | null;
    error?: string | null;
    /** 当前 TTS 模型 id:piper-zh-xiaoya / piper-zh-chaowen / vits-zh-fanchen-c。 */
    model?: string;
    model_dir?: string;
  };

  /** POST /v1/speech/config 响应。 */
  export type SpeechConfigResult = {
    ok: boolean;
    enabled: boolean;
  };

  /** POST /v1/speech/model 响应。 */
  export type SpeechModelResult = {
    ok: boolean;
    model: string;
    phase: TranscribePhase;
  };
```

- [x] **Step 3: api/index.ts 追加封装**

`src/lib/api/index.ts` 的 `transcribeAudio` 函数后追加:

```ts
// ---------- 本地语音合成(TTS,piper 中文 / HF 高质量) ----------

/** 查询语音朗读状态(开关 + 模型 + 下载/加载进度)。 */
export function getSpeechStatus(): Promise<Api.SpeechStatus> {
  return apiRequest('/v1/speech/status');
}

/** 打开/关闭语音朗读并持久化到配置(`[tts] enabled`)。 */
export function setSpeechEnabled(enabled: boolean): Promise<Api.SpeechConfigResult> {
  return apiRequest('/v1/speech/config', { method: 'POST', body: { enabled } });
}

/**
 * 切换语音朗读模型并持久化到配置(`[tts] model`)。
 * `model` 取值:`piper-zh-xiaoya`(中文女声)/ `piper-zh-chaowen`(中文男声)/ `vits-zh-fanchen-c`(高质量);
 * 切换后回到未就绪状态,首次合成自动下载。
 */
export function setSpeechModel(model: string): Promise<Api.SpeechModelResult> {
  return apiRequest('/v1/speech/model', { method: 'POST', body: { model } });
}

/**
 * 合成单句文本为 WAV(ArrayBuffer 响应)。
 * 关闭时抛 code 为 `tts_disabled` 的 ApiError(400);模型未就绪抛 `tts_not_ready`(503)。
 * 传 AbortSignal 可取消(打断朗读)。
 */
export function synthesizeSpeech(text: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  return apiRequestBinary('/v1/speech', {
    method: 'POST',
    body: { text },
    signal,
    timeoutMs: 30_000,
  });
}
```

- [x] **Step 4: 类型检查验证**

Run: `npm run tsc`
Expected: 无类型错误。

- [x] **Step 5: Commit**

```bash
git add src/lib/api/client.ts src/lib/api/index.ts src/lib/api/types.ts
git commit -m "feat: 前端 TTS API 封装(getSpeechStatus/setSpeechEnabled/setSpeechModel/synthesizeSpeech)"
```

---

### Task 5: 断句器 ttsSplit.ts

**Files:**
- Create: `src/lib/ttsSplit.ts`
- Test: `src/lib/ttsSplit.test.ts`

- [x] **Step 1: 写失败单测**

创建 `src/lib/ttsSplit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { splitSentences } from './ttsSplit';

describe('splitSentences', () => {
  it('按中文句末标点切句', () => {
    const { sentences, rest } = splitSentences('今天天气很好。明天也不错！后天呢？');
    expect(sentences).toEqual(['今天天气很好。', '明天也不错！', '后天呢？']);
    expect(rest).toBe('');
  });

  it('英文标点与换行同样切句', () => {
    const { sentences, rest } = splitSentences('Hello! How are you?\nFine.');
    expect(sentences).toEqual(['Hello!', ' How are you?\n', 'Fine.']);
    expect(rest).toBe('');
  });

  it('未成句的尾部保留在 rest(供下一轮增量拼接)', () => {
    const { sentences, rest } = splitSentences('今天天气');
    expect(sentences).toEqual([]);
    expect(rest).toBe('今天天气');
    // 第二轮增量
    const r2 = splitSentences(rest + '很好。');
    expect(r2.sentences).toEqual(['今天天气很好。']);
    expect(r2.rest).toBe('');
  });

  it('代码块围栏内内容不朗读、不切句', () => {
    const { sentences, rest } = splitSentences(
      '答案如下\n```python\nx = 1\nprint(x)\n```\n结果是 1。'
    );
    expect(sentences).toEqual(['答案如下\n', '结果是 1。']);
    expect(rest).toBe('');
  });

  it('围栏状态跨增量保留(rest 携带围栏标记)', () => {
    const first = splitSentences('答案如下\n```python\nx = 1');
    expect(first.sentences).toEqual(['答案如下\n']);
    // rest 必须包含 ``` 开头,下一轮才能重新进入围栏态
    expect(first.rest.startsWith('```')).toBe(true);
    const second = splitSentences(first.rest + '\nprint(x)\n```\n结果是 1。');
    expect(second.sentences).toEqual(['结果是 1。']);
    expect(second.rest).toBe('');
  });

  it('未闭合围栏的剩余内容留在 rest(由调用方在 run 结束时丢弃)', () => {
    const { sentences, rest } = splitSentences('答案如下\n```python\nx = 1');
    expect(sentences).toEqual(['答案如下\n']);
    expect(rest.includes('x = 1')).toBe(true);
  });

  it('超长单句强制切分(默认 100 字符)', () => {
    const long = '甲'.repeat(120);
    const { sentences, rest } = splitSentences(long);
    expect(sentences.length).toBe(1);
    expect(sentences[0].length).toBe(100);
    expect(rest.length).toBe(20);
  });

  it('空白候选不输出(连续换行)', () => {
    const { sentences, rest } = splitSentences('第一句。\n\n\n第二句。');
    expect(sentences).toEqual(['第一句。\n', '第二句。']);
    expect(rest).toBe('');
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/ttsSplit.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现 splitSentences**

创建 `src/lib/ttsSplit.ts`:

```ts
/**
 * 流式朗读的断句器(纯函数)。
 *
 * 输入尚未成句的文本缓冲,输出完整句子列表与剩余未成句部分。
 * 规则:
 * - 句末标点 `。！？!?…;` 与换行 `\n` 视为句子边界(空白候选不输出);
 * - 代码块围栏(行首 ``` 配对)内内容不朗读、不切句;围栏标记连同内容保留在
 *   rest 中,使围栏状态可跨增量调用重建(rest 必然以 ``` 开头,下一轮重新进入围栏态);
 * - 单句超过 MAX_SENTENCE_CHARS 字符强制切分(防长句无停顿);
 * - 未成句的尾部(含围栏内容)原样返回,等待下一轮增量或 run 结束时的冲刷。
 */

export const MAX_SENTENCE_CHARS = 100;
const SENTENCE_END = /[。！？!?…;]/;
const FENCE_MARK = '```';

export function splitSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let inFence = false;
  let cur = '';
  let fenceBuf = '';
  let atLineStart = true;
  const emit = (s: string) => {
    if (s.trim()) sentences.push(s);
  };
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (atLineStart && buf.startsWith(FENCE_MARK, i)) {
      inFence = !inFence;
      if (inFence) {
        fenceBuf += FENCE_MARK;
      } else {
        fenceBuf = ''; // 围栏闭合:丢弃围栏内容(永不朗读)
      }
      i += FENCE_MARK.length - 1;
      atLineStart = false;
      continue;
    }
    if (ch === '\n') {
      atLineStart = true;
      if (inFence) {
        fenceBuf += ch;
        continue;
      }
      cur += ch;
      emit(cur);
      cur = '';
      continue;
    }
    atLineStart = false;
    if (inFence) {
      fenceBuf += ch;
      continue;
    }
    cur += ch;
    if (SENTENCE_END.test(ch) || cur.length >= MAX_SENTENCE_CHARS) {
      emit(cur);
      cur = '';
    }
  }
  return { sentences, rest: cur + fenceBuf };
}
```

- [x] **Step 4: 运行测试验证**

Run: `npx vitest run src/lib/ttsSplit.test.ts`
Expected: 全部 PASS。

- [x] **Step 5: Commit**

```bash
git add src/lib/ttsSplit.ts src/lib/ttsSplit.test.ts
git commit -m "feat: TTS 流式断句器(中英文标点/换行/代码块过滤/超长切分)"
```

---

### Task 6: useSpeechOutput 朗读 hook

**Files:**
- Create: `src/hooks/useSpeechOutput.ts`
- Test: `src/hooks/useSpeechOutput.test.tsx`(含 JSX,必须是 .tsx)
- Modify: `src/components/shell/AppShell.tsx`(挂载 hook)

- [x] **Step 1: 写失败单测**

创建 `src/hooks/useSpeechOutput.test.tsx`(注意 .tsx:测试含 JSX):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// --- mock 网络与音频 ---
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

class FakeAudioContext {
  state = 'running';
  destination = {};
  buffers: AudioBuffer[] = [];
  async decodeAudioData(buf: ArrayBuffer): Promise<AudioBuffer> {
    const b = { duration: 0, length: 0, numberOfChannels: 1, sampleRate: 22050 } as AudioBuffer;
    return b;
  }
  createBufferSource() {
    return {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
vi.stubGlobal('AudioContext', FakeAudioContext);

// --- mock agentStore(独立状态,避免真实持久化干扰) ---
const { useAgentStore } = await import('../stores/agentStore');

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

// 初始 status:enabled=true
fetchMock.mockImplementation(async (url: string) => {
  if (url.includes('/v1/speech/status')) {
    return {
      ok: true,
      json: async () => ({ enabled: true, ready: false, phase: 'not_ready', model: 'piper-zh-xiaoya' }),
    };
  }
  if (url.includes('/v1/speech')) {
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(44 + 8) };
  }
  throw new Error(`unexpected url ${url}`);
});

beforeEach(() => {
  fetchMock.mockClear();
  useAgentStore.getState().setActiveWorkspace('ws1');
  useAgentStore.getState().setActiveSessionId('s1');
});

describe('useSpeechOutput', () => {
  it('assistant 文本增量按句合成,不重复合成已消费前缀', async () => {
    const { useSpeechOutput } = await import('./useSpeechOutput');
    renderHook(() => useSpeechOutput(), { wrapper: makeWrapper() });
    // 先进入 running(仅朗读本次运行的增量,历史消息不读)
    useAgentStore.getState().setActiveSessionId('s1');
    useAgentStore.getState().markRun('s1', 'r1', 'running');
    // 第一段增量
    useAgentStore
      .getState()
      .upsertMessage('s1', {
        id: 'm1',
        role: 'assistant',
        session_id: 's1',
        model: 'm',
        provider: 'p',
        created_at: 1,
        updated_at: 1,
        parts: [{ type: 'text', data: { text: '你好。世界' } }],
      });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v1/speech?'));
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0][1].body).text).toBe('你好。');
    });
    // 增量补全第二句(不重读 你好。)
    useAgentStore
      .getState()
      .upsertMessage('s1', {
        id: 'm1',
        role: 'assistant',
        session_id: 's1',
        model: 'm',
        provider: 'p',
        created_at: 1,
        updated_at: 2,
        parts: [{ type: 'text', data: { text: '你好。世界真大。' } }],
      });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/v1/speech?'));
      expect(calls.length).toBe(2);
      expect(JSON.parse(calls[1][1].body).text).toBe('世界真大。');
    });
  });
});
```

(注:测试中 `upsertMessage` 的 `parts` 类型是 `Api.ContentPart`,测试里直接给字面量即可,TS 会按结构类型校验;若报类型错误,在测试文件顶部 `import type { Api } from '../lib/api/types';` 并把 parts 标为 `Api.ContentPart[]`。)

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run src/hooks/useSpeechOutput.test.tsx`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现 useSpeechOutput**

创建 `src/hooks/useSpeechOutput.ts`:

```ts
import { useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getSpeechStatus, synthesizeSpeech } from '../lib/api';
import { useAgentStore } from '../stores/agentStore';
import { splitSentences } from '../lib/ttsSplit';

/** 待处理缓冲上限(字符):防止超长未成句内容(如大段代码块)无限累积。 */
const MAX_PENDING_CHARS = 4000;

/**
 * 语音朗读 agent 回复(流式按句):
 *
 * - 仅后端配置 `[tts] enabled` 打开时工作(经 getSpeechStatus 轮询);
 * - 订阅当前会话 assistant 文本增量(只取 text part),按句末标点/换行断句
 *   (代码块围栏内容跳过,断句器跨增量保持围栏状态);
 * - 完整句子经 `POST /v1/speech` 合成 WAV,AudioContext 解码后 FIFO 顺序播放;
 * - 打断:新发消息(出现新 user 消息)/ 切换会话 / 关闭开关 / run 出错或取消
 *   → 停播 + 清空缓冲与已消费偏移。
 */
/** 提取一条消息的全部 text part 文本(非 assistant 返回空)。 */
function textOf(m: { role: string; parts: { type: string; data?: { text?: string } }[] }): string {
  if (m.role !== 'assistant') return '';
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.data?.text ?? '')
    .join('');
}

export function useSpeechOutput() {
  const enabled = useQuery({
    queryKey: ['tts-status'],
    queryFn: getSpeechStatus,
  }).data?.enabled ?? false;

  const sessionId = useAgentStore((s) => s.activeSessionId);
  const messages = useAgentStore((s) =>
    s.activeSessionId ? s.bySession[s.activeSessionId]?.messages : undefined
  );
  const run = useAgentStore((s) =>
    s.activeSessionId ? s.bySession[s.activeSessionId]?.run : undefined
  );

  const ctxRef = useRef<AudioContext | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  /** 打断代次:每次 stop 自增,已入队句子在轮到播放时发现代次不符则跳过。 */
  const epochRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  /** 每消息已消费的文本长度(messageId → 字符偏移)。 */
  const consumedRef = useRef<Map<string, number>>(new Map());
  const pendingRef = useRef('');

  /** 打断朗读:取消在途合成、停播当前音频,已入队的句子全部作废。 */
  const stop = useCallback(() => {
    epochRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    activeSrcRef.current?.stop();
    activeSrcRef.current = null;
  }, []);

  /** 把一句文本合成并播放(入队,顺序播放)。 */
  const speak = useCallback((sentence: string) => {
    const text = sentence.trim();
    if (!text) return;
    const epoch = epochRef.current;
    queueRef.current = queueRef.current
      .then(async () => {
        if (epoch !== epochRef.current) return;
        abortRef.current?.abort();
        abortRef.current = new AbortController();
        let wav: ArrayBuffer;
        try {
          wav = await synthesizeSpeech(text, abortRef.current.signal);
        } catch {
          return; // tts_disabled / tts_not_ready / 已取消:静默跳过
        }
        if (epoch !== epochRef.current) return;
        const ctx =
          ctxRef.current ??
          (ctxRef.current = new AudioContext());
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        const buffer = await ctx.decodeAudioData(wav);
        if (epoch !== epochRef.current) return;
        await new Promise<void>((resolve) => {
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(ctx.destination);
          src.onended = () => {
            if (activeSrcRef.current === src) activeSrcRef.current = null;
            resolve();
          };
          activeSrcRef.current = src;
          src.start();
        });
      })
      .catch(() => {
        /* 单句失败不阻断后续句子 */
      });
  }, []);

  // 开关关闭:停读并清空全部状态
  useEffect(() => {
    if (enabled) return;
    stop();
    pendingRef.current = '';
    consumedRef.current = new Map();
  }, [enabled, stop]);

  // run 开始:把历史消息全部标记为已消费(只朗读本次运行的增量,不读历史)
  useEffect(() => {
    if (!enabled || run?.status !== 'running') return;
    const cur = new Map<string, number>();
    for (const m of messages ?? []) {
      cur.set(m.id, textOf(m).length);
    }
    consumedRef.current = cur;
    pendingRef.current = '';
  }, [run?.status, enabled, messages]);

  // 文本增量 → 断句 → 入队;切换会话 → 打断(仅 run 进行中处理)
  useEffect(() => {
    if (!enabled || run?.status !== 'running') return;
    if (sessionId !== sessionRef.current) {
      sessionRef.current = sessionId;
      consumedRef.current = new Map();
      pendingRef.current = '';
      stop();
    }
    if (!sessionId || !messages) return;
    let pending = pendingRef.current;
    for (const m of messages) {
      const text = textOf(m);
      const consumed = consumedRef.current.get(m.id) ?? 0;
      if (text.length > consumed) {
        pending += text.slice(consumed);
        consumedRef.current.set(m.id, text.length);
      }
    }
    if (pending.length > MAX_PENDING_CHARS) {
      pending = pending.slice(-MAX_PENDING_CHARS);
    }
    pendingRef.current = pending;
    const { sentences, rest } = splitSentences(pending);
    pendingRef.current = rest;
    for (const s of sentences) void speak(s);
  }, [messages, sessionId, enabled, run?.status, speak, stop]);

  // run 结束:正常结束先补消费最终版文本再冲刷;出错/取消丢弃缓冲
  useEffect(() => {
    if (!enabled || run?.status !== 'done') return;
    if (run.error) {
      pendingRef.current = '';
      stop();
      return;
    }
    let pending = pendingRef.current;
    for (const m of messages ?? []) {
      const text = textOf(m);
      const consumed = consumedRef.current.get(m.id) ?? 0;
      if (text.length > consumed) {
        pending += text.slice(consumed);
        consumedRef.current.set(m.id, text.length);
      }
    }
    pendingRef.current = '';
    if (!pending) return;
    const { sentences } = splitSentences(pending + '\n');
    for (const s of sentences) void speak(s);
  }, [run, enabled, messages, speak, stop]);

  // 卸载:清理
  useEffect(() => {
    return () => {
      stop();
      void ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, [stop]);
}
```

- [x] **Step 4: AppShell 挂载**

`src/components/shell/AppShell.tsx`:
- 顶部 imports 加 `import { useSpeechOutput } from '../../hooks/useSpeechOutput';`
- `AppShellInner` 函数体开头(第 81 行 `const workspaceId = useActiveWorkspaceId();` 前)加 `useSpeechOutput();`

- [x] **Step 5: 运行测试验证**

Run: `npx vitest run src/hooks/useSpeechOutput.test.tsx` 与 `npm run tsc`
Expected: hook 测试 PASS;`tsc` 无类型错误。若测试因时序/查询缓存不稳定,把 `waitFor` 超时调大或先 `qc.setQueryData(['tts-status'], { enabled: true, ... })` 预置。

- [x] **Step 6: Commit**

```bash
git add src/hooks/useSpeechOutput.ts src/hooks/useSpeechOutput.test.tsx src/components/shell/AppShell.tsx
git commit -m "feat: 语音朗读 hook(流式断句合成/排队播放/打断)"
```

---

### Task 7: 设置界面 TtsSection

**Files:**
- Modify: `src/components/shell/SettingsDialog.tsx`

- [x] **Step 1: 写 TtsSection 组件**

`src/components/shell/SettingsDialog.tsx` 改动:

(a) 第 31 行 import 加 `setSpeechEnabled, setSpeechModel`:

```ts
import { listDirGrants, revokeDirGrant, getTranscribeStatus, setTranscribeModel, getSpeechStatus, setSpeechEnabled, setSpeechModel } from '../../lib/api';
```

(b) `AsrModelSection` 组件结束后(第 1099 行后)追加:

```tsx
/** ---------- 语音合成(TTS)设置区 ---------- */

/** 可选的本地语音合成模型(与后端 TtsModel 一致)。 */
const TTS_MODELS = [
  {
    id: 'piper-zh-xiaoya',
    label: 'Piper 小雅 · 中文女声',
    desc: 'piper 中文女声(int8),约 14MB,清晰自然',
  },
  {
    id: 'piper-zh-chaowen',
    label: 'Piper 超闻 · 中文男声',
    desc: 'piper 中文男声(int8),约 14MB',
  },
  {
    id: 'vits-zh-fanchen-c',
    label: 'VITS 凡尘-C · 高质量女声',
    desc: 'HF 高质量中文女声,约 113MB,音色更细腻',
  },
] as const;

/**
 * 语音朗读设置:开关 + 模型选择。开关经 POST /v1/speech/config 写入配置
 * `[tts] enabled`,模型经 POST /v1/speech/model 即时切换并写入 `[tts] model`,
 * 均跨重启保留;新模型首次使用时自动下载。
 */
function TtsSection({ open }: { open: boolean }) {
  const qc = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['tts-status'],
    queryFn: getSpeechStatus,
    enabled: open,
  });
  const [current, setCurrent] = useState<string>('piper-zh-xiaoya');
  const [error, setError] = useState('');
  const toggleEnabled = useMutation({
    mutationFn: (on: boolean) => setSpeechEnabled(on),
    onSuccess: () => {
      // 朗读 hook 监听同一查询,关闭后立即停读
      void qc.invalidateQueries({ queryKey: ['tts-status'] });
      setError('');
    },
    onError: (e) => setError(e instanceof Error ? e.message : '保存失败'),
  });
  const switchModel = useMutation({
    mutationFn: (model: string) => setSpeechModel(model),
    onSuccess: (_d, model) => {
      setCurrent(model);
      setError('');
    },
    onError: (e) => setError(e instanceof Error ? e.message : '切换失败'),
  });

  // 后端状态返回后同步当前模型(覆盖本地默认值)
  useEffect(() => {
    if (status?.model) setCurrent(status.model);
  }, [status?.model]);

  const desc = TTS_MODELS.find((m) => m.id === current)?.desc;
  const selectCls =
    'h-9 w-full rounded-lg border border-input-border bg-background px-2.5 text-[13px] text-foreground outline-none [color-scheme:dark] focus-visible:border-input-border-focused disabled:opacity-50';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <label className="text-[13px] font-medium text-foreground">语音朗读</label>
          <span className="text-[12px] text-foreground-subtle">
            打开后自动朗读 agent 的回复(流式按句朗读;发送新消息或切换会话即停)
          </span>
        </div>
        <Switch
          checked={status?.enabled ?? false}
          onCheckedChange={(on) => toggleEnabled.mutate(on)}
          disabled={toggleEnabled.isPending}
          aria-label="语音朗读"
        />
      </div>
      <select
        value={current}
        disabled={switchModel.isPending}
        onChange={(e) => switchModel.mutate(e.target.value)}
        className={selectCls}
        aria-label="选择语音朗读模型"
      >
        {TTS_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <div className="text-[12px] text-foreground-subtle">
        {desc}。切换即时生效并跨重启保留;新模型首次使用时自动下载,朗读时触发。
      </div>
      {error && <div className="text-[12px] text-destructive">{error}</div>}
    </div>
  );
}
```

(c) 第 276 行 `<AsrModelSection open={open} />` 后加:

```tsx
          {/* 语音合成(TTS)朗读 */}
          <TtsSection open={open} />
```

- [x] **Step 2: 验证**

Run: `npm run tsc` 与 `npm test`
Expected: 无类型错误;现有测试全部 PASS(若 SettingsDialog 有快照/渲染测试,确认未破坏)。

- [x] **Step 3: Commit**

```bash
git add src/components/shell/SettingsDialog.tsx
git commit -m "feat: 设置界面新增语音朗读开关与模型选择"
```

---

### Task 8: 文档 + 全量验证

**Files:**
- Modify: `AGENTS.md`

- [x] **Step 1: AGENTS.md 补 TTS 段落**

`AGENTS.md` 的「Architecture & data flow」中 ASR 相关描述后(或 gotchas 第 0 条 combo-cli 描述内 `[asr]` 附近)追加一段:

```markdown
- **TTS(语音朗读 agent 回复)**:与 ASR 对称的本地语音合成。配置
  `[tts] enabled`(开关,默认关)+ `[tts] model`(默认 `piper-zh-xiaoya`,可选
  `piper-zh-chaowen`/`vits-zh-fanchen-c`),端点
  `GET /v1/speech/status`、`POST /v1/speech/config`(开关)、
  `POST /v1/speech/model`(切模型)、`POST /v1/speech`(单句文本 → WAV,
  关闭时 400 `tts_disabled`,未就绪 503 `tts_not_ready`)。
  `tts.rs` 镜像 `asr.rs`:模型经 GitHub release 下载
  (`COMBO_TTS_MODEL_URL` 可覆盖),与 ASR 共用 `<数据目录>/models/<id>/`;
  sherpa-onnx `OfflineTts` 按 `model+tokens+lexicon+rule_fsts`
  (`phone.fst,date.fst,number.fst`)加载,fanchen-C 用 `sid=100`;
  合成结果封装 44 字节 WAV 头(PCM16)返回。前端 `useSpeechOutput`
  (挂 AppShellInner)订阅 agentStore 当前会话 assistant 文本增量,按句末
  标点/换行断句(代码块围栏内容跳过,`ttsSplit.ts` 纯函数、围栏状态跨增量
  保留),完整句子经 `synthesizeSpeech` 合成后 AudioContext FIFO 顺序播放;
  新发消息/切会话/关开关/run 出错即打断。设置界面 `TtsSection`(开关 + 模型)。
```

- [x] **Step 2: 全量验证**

Run:
```bash
cargo test -p combo-cli
npm run tsc
npm test
```
Expected: 全部 PASS。

- [x] **Step 3: 手动冒烟(已用真实 piper 模型执行)**

```bash
bash scripts/dev-backend.sh
# 另开终端:
# 1) 设置里打开「语音朗读」开关
# 2) 浏览器打开 http://localhost:5173,向 agent 发消息,确认有中文朗读输出
# 3) 发送新消息确认旧朗读被打断
```

- [x] **Step 4: Commit**

```bash
git add AGENTS.md crates/combo-cli/src/tts.rs
git commit -m "docs: AGENTS.md 补充 TTS 语音朗读说明"
```

---

## Progress

- 2026-08-18 Task 1 ✅ 完成:`tts.rs`(TtsModel)+ `config.rs`(`[tts]` TtsConfig/set_tts_enabled/set_tts_model/模板/roundtrip 测试)+ lib.rs 注册。`cargo test -p combo-cli tts` 2 个测试通过;commit `8dad52f`。dead_code 警告预期(Task 2/3 消费 download_url/archive_name/subdir/default_sid)。
- 2026-08-18 Task 2 ✅ 完成:`tts.rs` 补 TtsFiles 查找/f32_to_wav/Synthesizer/TtsService(下载/加载/切换/合成)。3 个测试通过(见 Decision Log:WAV 量化用 round 而非截断;Path 断言按 file_name 而非组件比较);commit `46bd791`。
- 2026-08-18 Task 3 ✅ 完成:`/v1/speech/{status,config,model,synthesize}` 端点 + serve 接线(asr.rs 的 Phase::name/err_response 改 pub(crate)、AppState.tts、router merge、integration test 两处字面量)。测试改为直接调用 handler(避免 tower ServiceExt 依赖与 build_router 私有问题);spawn_blocking 的 JoinError/anyhow 错误分支拆开(match 合并不同错误类型会编译失败)。全量 288 测试通过;commit `18b0c64`。
- 2026-08-18 Task 4 ✅ 完成:前端 API 层(client.ts `apiRequestBinary` + types.ts Speech 类型 + api/index.ts 四个封装)。`npm run tsc` 通过;commit `5e925b8`。
- 2026-08-18 Task 5 ✅ 完成:`ttsSplit.ts` 断句器 + 8 项单测(标点/换行/围栏跨增量/超长切分/空白过滤)。两处计划内测试预期修正(见 Decision Log);`SENTENCE_END` 补英文句号 `.`。commit `6c8f633`。
- 2026-08-18 Task 6 ✅ 完成:`useSpeechOutput` hook + 单测 + AppShell 挂载。排查中发现两个测试基建问题(见 Decision Log:restoreAllMocks 清 mockImplementation、FakeAudioContext 需异步触发 onended);hook 基线改为 runId 守卫(见 Surprises)。393 前端测试全过 + tsc 干净;commit `dacde2d`。
- 2026-08-18 Task 7 ✅ 完成:SettingsDialog `TtsSection`(开关 + 模型下拉,关开关经 invalidateQueries 联动朗读 hook 立即停读)。tsc + 393 测试全过;commit `b157dd9`。
- 2026-08-18 Task 8 ✅ 完成:AGENTS.md 补 TTS 段落 + 全量验证(cargo 288 + tsc + 前端 393 全绿)+ **真实模型冒烟**(piper-xiaoya int8 合成「你好,这是语音朗读测试。」→ 117,948 字节 WAV / 22050Hz / 约 2.7s,验证 rule_fsts 加载链路端到端可用)。commit `69668a6`。
- 2026-08-18 **Need verify 阶段修复**:①`synthesize` 首次调用前不加载模型(无 prepare 端点)→ 自动 `ensure_ready`;②`enabled` 每请求读磁盘导致测试依赖真实用户配置 → 改为运行时内存态(AppState 启动时从 `[tts] enabled` 加载,TtsService.set_enabled 同步)。端到端复验:HTTP 200 / 256,734 字节 RIFF WAV(约 5.8s 中文音频),已 afplay 试听;旧版 Combo.app 抢占 18236 端口需先退出。commit `d8eaec1`。

## Surprises & Discoveries

<!-- Material surprises discovered during implementation -->

## Surprises & Discoveries

<!-- Material surprises discovered during implementation -->

## Decision Log

- 2026-08-18 WAV 量化:`(s*32767.0) as i16` 截断会让 0.5 量化成 16383,改为 `(s.clamp(-1,1)*32767.0).round() as i16`(0.5→16384,-0.5→-16384,1.0→32767)。
- 2026-08-18 测试断言:`Path::ends_with(".onnx")` 按路径组件比较(末组件是 `zh_CN-*.onnx`),改为 `file_name().ends_with(".onnx")`。
- 2026-08-18 端点测试不建 router:`build_router` 私有且 Router::oneshot 需 tower::ServiceExt 依赖,改为直接调用 `synthesize(State, Json)` / `status(State)` handler(同模块内可见),避免新增 tower dev-dependency。
- 2026-08-18 synthesize 的 spawn_blocking match:`Ok(Err(e)) | Err(e)` 把 anyhow::Error 与 JoinError 绑定到同名 e 会类型冲突,拆成两个分支。
- 2026-08-18 断句器测试预期:标点边界先于换行触发,句子不含尾部换行(`'How are you?'` 在 `?` 处已切出,`\n` 单独成空候选被丢弃),修正两处断言。
- 2026-08-18 `SENTENCE_END` 补英文句号 `.`:设计文档列的是中文标点集合,但英文句子(如 `Fine.`)无 `.` 边界则永不切句,`.` 加入边界集(小数/URL 会有误切,朗读场景可接受)。
- 2026-08-18 测试基建:`src/test-setup.ts` 的 `beforeEach(vi.restoreAllMocks())` 会清掉 `vi.fn()` 之后用 `.mockImplementation()` 设置的实现(返回 undefined),但 `vi.fn(impl)` 构造器传入的实现不受影响——mock 实现必须走构造器。
- 2026-08-18 测试基建:FakeAudioContext 的 createBufferSource 若不在 start() 后异步触发 onended,朗读队列 Promise 永远 pending,后续句子不会合成;mock 需模拟真实播放结束。
- 2026-08-18 hook 测试的 fetchMock 调用断言需要 `as unknown as [string, { body: string }][]` 转型(vi.fn 单参数签名下 mock.calls 元组类型只有 url)。
- 2026-08-18 enabled 校验改为运行时内存态(原设计每请求读磁盘):测试环境会读到真实用户配置(enable 后端点测试失败),且启动后外部改配置不被感知——与 ASR 的模型处理(构造时读配置 + API 运行时切换)保持一致。

## Outcomes & Retrospective

- 8 个任务全部完成并逐个提交(8dad52f → 69668a6)。
- 验证:cargo test -p combo-cli 288 通过;npm run tsc 干净;npm test 393 通过;cargo build 0 warnings。
- 真实模型冒烟:piper-zh-xiaoya int8 合成「你好,这是语音朗读测试。」→ 117,948 字节 WAV / 22050Hz / 约 2.7s,rule_fsts 加载链路端到端可用。
- 待办(人工):运行 dev-backend + 前端,设置中打开「语音朗读」试听;模型下载需网络代理。
- 完整报告见 EXECUTION-REPORT.md。
