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
