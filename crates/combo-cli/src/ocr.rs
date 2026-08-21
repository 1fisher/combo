//! macOS 本地 OCR:封装系统 Vision 框架的 `VNRecognizeTextRequest`。
//!
//! - 完全本地离线执行,无需联网、无需 API key、不落任何数据;
//! - 默认识别简体中文 + 英文(zh-Hans/en-US,需 macOS 13+;更早系统仅支持
//!   en-US/fr-FR/it-IT/de-DE/es-ES/pt-BR,传错语言 Vision 会报错并原样透出);
//! - 支持所有 ImageIO 可解码的位图格式:PNG/JPEG/HEIC/TIFF/BMP/GIF/WEBP;
//!   PDF 不支持(URL 输入会被 Vision 报 zero-dimensioned image);
//! - `performRequests` 是同步阻塞调用且可能耗时数百毫秒到数秒,
//!   调用方应在 `spawn_blocking` 中执行(见 tools.rs 的 ocr 工具)。
//!
//! 非 macOS 平台 `recognize_image_file` 直接返回错误,工具层据此提示
//! 不可用,保持跨平台可编译。

use std::path::Path;

/// OCR 选项。
#[derive(Debug, Clone)]
pub struct OcrOptions {
    /// 识别语言(BCP-47 代码,如 "zh-Hans"/"en-US"/"ja-JP"),按优先级排序。
    /// 为空时使用系统默认(仅 en-US)。
    pub languages: Vec<String>,
    /// 快速模式:牺牲精度换速度(适合大图粗扫)。
    pub fast: bool,
    /// 语言纠错:Vision 对识别结果做语言模型修正(自然语言更准,
    /// 但可能改写 URL/代码/编号等字面内容,默认关闭)。
    pub language_correction: bool,
}

impl Default for OcrOptions {
    fn default() -> Self {
        Self {
            languages: vec!["zh-Hans".into(), "en-US".into()],
            fast: false,
            language_correction: false,
        }
    }
}

/// Vision(URL 输入)可解码的图片扩展名。
pub const SUPPORTED_IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "heic", "tif", "tiff", "bmp", "gif", "webp",
];

/// 判断路径是否为 OCR 支持的图片格式(按扩展名)。
pub fn is_supported_image(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    SUPPORTED_IMAGE_EXTS.contains(&ext.as_str())
}

/// 对图片文件执行本地 OCR,按 Vision 返回的阅读顺序逐行返回识别文本。
///
/// 错误全部以中文文案返回(文件不存在/不支持的平台/Vision 错误)。
pub fn recognize_image_file(path: &Path, opts: &OcrOptions) -> anyhow::Result<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        recognize_on_macos(path, opts)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, opts);
        anyhow::bail!("OCR 仅在 macOS 上可用(基于系统 Vision 框架)")
    }
}

// ============================= macOS 实现 =============================

/// macOS Vision 实现(已用真实图片验证:中英混排截图识别正确)。
#[cfg(target_os = "macos")]
fn recognize_on_macos(path: &Path, opts: &OcrOptions) -> anyhow::Result<Vec<String>> {
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
        VNRequestTextRecognitionLevel,
    };

    if !path.exists() {
        anyhow::bail!("图片不存在: {}", path.display());
    }
    if path.is_dir() {
        anyhow::bail!("路径是目录,不是图片: {}", path.display());
    }
    // Vision 的 NSURL 输入需要绝对路径
    let abs = std::fs::canonicalize(path)
        .map_err(|e| anyhow::anyhow!("解析图片路径失败: {e}"))?;
    let abs_str = abs
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("图片路径包含非法 UTF-8 字符"))?;

    unsafe {
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(if opts.fast {
            VNRequestTextRecognitionLevel::Fast
        } else {
            VNRequestTextRecognitionLevel::Accurate
        });
        if !opts.languages.is_empty() {
            let langs: Vec<Retained<NSString>> = opts
                .languages
                .iter()
                .map(|s| NSString::from_str(s))
                .collect();
            let refs: Vec<&NSString> = langs.iter().map(|s| &**s).collect();
            request.setRecognitionLanguages(&NSArray::from_slice(&refs));
        }
        request.setUsesLanguageCorrection(opts.language_correction);

        let url = NSURL::fileURLWithPath(&NSString::from_str(abs_str));
        // SAFETY: options 传空字典,键类型 VNImageOption 正确
        let handler = VNImageRequestHandler::initWithURL_options(
            VNImageRequestHandler::alloc(),
            &url,
            &NSDictionary::new(),
        );

        // SAFETY: VNRecognizeTextRequest 继承自 VNRequest(extern_class! 声明),
        // 向上转型到父类是类型安全的
        let requests =
            NSArray::from_retained_slice(&[Retained::cast_unchecked::<VNRequest>(request.clone())]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| anyhow::anyhow!("Vision 识别失败: {}", e.localizedDescription()))?;

        let results = request.results().unwrap_or_else(NSArray::array);
        let mut lines = Vec::with_capacity(results.len());
        for obs in results.iter() {
            let Some(text_obs) = obs.downcast_ref::<VNRecognizedTextObservation>() else {
                continue;
            };
            // topCandidates(1) 按置信度返回最优候选
            if let Some(cand) = text_obs.topCandidates(1).iter().next() {
                let text = cand.string().to_string();
                if !text.trim().is_empty() {
                    lines.push(text);
                }
            }
        }
        Ok(lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_image_exts() {
        assert!(is_supported_image(Path::new("shot.png")));
        assert!(is_supported_image(Path::new("photo.JPG"))); // 大小写不敏感
        assert!(is_supported_image(Path::new("a/b/img.heic")));
        assert!(!is_supported_image(Path::new("doc.pdf"))); // PDF 不被 Vision URL 输入支持
        assert!(!is_supported_image(Path::new("readme.md")));
        assert!(!is_supported_image(Path::new("noext")));
    }

    #[test]
    fn missing_file_errors() {
        let err = recognize_image_file(Path::new("/nonexistent/xx.png"), &OcrOptions::default())
            .unwrap_err()
            .to_string();
        assert!(err.contains("不存在") || err.contains("macOS"), "unexpected: {err}");
    }

    /// 300x80 白底黑字 PNG,内容为「HELLO 42」(Swift/AppKit 程序化生成),
    /// 用于锁定 macOS Vision OCR 全链路回归。
    #[cfg(target_os = "macos")]
    const FIXTURE_HELLO_PNG_B64: &str = concat!(
        "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",
    );

    #[cfg(target_os = "macos")]
    #[test]
    fn ocr_recognizes_real_png() {
        let png = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            FIXTURE_HELLO_PNG_B64,
        )
        .expect("fixture base64 解码失败");
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("hello.png");
        std::fs::write(&img, png).unwrap();

        let lines = recognize_image_file(&img, &OcrOptions::default()).expect("OCR 应成功");
        let joined = lines.join("\n");
        assert!(
            joined.contains("HELLO"),
            "应识别出 HELLO,实际: {joined:?}"
        );
        assert!(
            joined.contains("42"),
            "应识别出 42,实际: {joined:?}"
        );
    }
}
