//! 系统托盘(macOS / Windows):
//! - 右键托盘图标弹出菜单,提供主要功能:新建任务、退出
//! - 左键点击托盘图标切换主窗口显隐(不弹菜单)
//! - 关闭主窗口改为「隐藏到托盘」,真正退出走托盘菜单「退出 Combo」
//! - 忙碌动画:任一项目有任务在执行时,图标切换为无背景的「combo」字母
//!   弹跳动画(五个黑色像素字母边弹跳边从右往左穿行,中间大边缘小),
//!   任务全部结束后恢复静态图标

use combo_cli::serve::AppState;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// 托盘「新建任务」事件:后端先唤起主窗口再 emit,前端收到后新建会话
pub const EVENT_TRAY_NEW_TASK: &str = "tray-new-task";

/// 托盘「打开视图」事件:payload 为视图名(automation/search/skills/mcp/stats/graph),
/// 前端收到后切换到对应全页视图
pub const EVENT_TRAY_OPEN_VIEW: &str = "tray-open-view";

/// macOS:用自建菜单替换 Tauri 默认应用菜单。
/// 默认菜单「文件 > 关闭窗口 (⌘W)」会在原生层截获 ⌘W(触发窗口关闭→隐藏到托盘),
/// 前端「⌘W 关闭当前文件」就永远收不到按键;自建菜单保留 App/编辑/显示/窗口
/// 标准项(⌘A/⌘C/⌘V/⌘Q/全屏等不受影响),仅去掉「关闭窗口」——主窗口关闭本就被
/// 拦截为隐藏到托盘,真正退出走托盘菜单,行为不受影响。
/// 注意「编辑」菜单**必须**保留 select_all(全选 ⌘A):macOS 上 WKWebView
/// textarea/CodeMirror 的 ⌘A 全选依赖 AppKit responder chain 的 `selectAll:`
/// 动作——主菜单没有该加速键项时按键只会变成普通 keydown 到达 web 层,
/// 什么也不发生(⌘A 在 Composer/编辑器内完全失效,已实测复现);加上后
/// DOM keydown 仍照常派发给 web 层(defaultPrevented=false),前端快捷键
/// 默认 ⌘⇧A 切换「自动化」视图不受影响。
#[cfg(target_os = "macos")]
pub fn init_app_menu(app: &AppHandle) {
    use tauri::menu::{MenuBuilder, SubmenuBuilder};

    let result = (|| -> tauri::Result<()> {
        let app_menu = SubmenuBuilder::new(app, "Combo")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let edit_menu = SubmenuBuilder::new(app, "编辑")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        let view_menu = SubmenuBuilder::new(app, "显示").fullscreen().build()?;
        let window_menu = SubmenuBuilder::new(app, "窗口").minimize().maximize().build()?;
        let menu = MenuBuilder::new(app)
            .item(&app_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .build()?;
        // set_menu 返回被替换的旧菜单(Option<Menu>),此处不需要,映射为 ()
        app.set_menu(menu).map(|_| ())
    })();
    // 构建失败保持 Tauri 默认菜单,仅记录(⌘W 退化为隐藏窗口)
    if let Err(e) = result {
        eprintln!("自建应用菜单失败,保持默认菜单: {e:?}");
    }
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("main")
}

/// 显示并聚焦主窗口(还原最小化)
pub fn show_main_window(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 初始化系统托盘,并把主窗口的「关闭」改为隐藏到托盘。
/// 菜单项的 accelerator(快捷键)与前端 WorkspaceSidebar::SHORTCUT_TO_VIEW
/// 保持一致——托盘菜单只负责显示与点击触发,快捷键本身由前端 webview 处理。
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let new_task = MenuItem::with_id(app, "new-task", "新建任务", true, Some("CmdOrCtrl+N"))?;
    let sep_head = PredefinedMenuItem::separator(app)?;
    // accelerator 仅作显示(与前端 shortcuts.ts 默认绑定保持一致:自动化 ⌘/Ctrl+Shift+A;
    // c1bf63a 后前端默认键已从 ⌘A 改为 ⌘⇧A 避开全选冲突,托盘显示同步跟进)
    let view_auto = MenuItem::with_id(app, "view-automation", "自动化", true, Some("CmdOrCtrl+Shift+A"))?;
    let view_search = MenuItem::with_id(app, "view-search", "搜索", true, Some("CmdOrCtrl+K"))?;
    let view_skills = MenuItem::with_id(app, "view-skills", "技能", true, Some("CmdOrCtrl+Shift+S"))?;
    let view_mcp = MenuItem::with_id(app, "view-mcp", "MCP 工具", true, Some("CmdOrCtrl+Shift+M"))?;
    let view_stats = MenuItem::with_id(app, "view-stats", "统计", true, Some("CmdOrCtrl+Shift+D"))?;
    let view_graph = MenuItem::with_id(app, "view-graph", "图谱", true, Some("CmdOrCtrl+Shift+G"))?;
    let sep_tail = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &new_task,
            &sep_head,
            &view_auto,
            &view_search,
            &view_skills,
            &view_mcp,
            &view_stats,
            &view_graph,
            &sep_tail,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Combo")
        .menu(&menu)
        // 左键不弹菜单(由点击事件切换窗口显隐),右键弹菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "new-task" => {
                show_main_window(app);
                let _ = app.emit(EVENT_TRAY_NEW_TASK, ());
            }
            "quit" => app.exit(0),
            id => {
                // view-<name>:打开对应全页视图(唤起窗口 + 通知前端切换)
                if let Some(view) = id.strip_prefix("view-") {
                    show_main_window(app);
                    let _ = app.emit(EVENT_TRAY_OPEN_VIEW, view);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = main_window(app) {
                    // 窗口可见且聚焦时点击托盘 → 隐藏;否则唤起
                    if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        show_main_window(app);
                    }
                }
            }
        });

    // 托盘图标:黑色圆角方块 + 白色 C 字形(icons/tray-icon.png),
    // 与菜单栏其他应用的深色托盘图标风格一致
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
    builder = builder.icon(icon);
    builder.build(app)?;

    // 关闭主窗口 → 隐藏到托盘;真正退出走托盘菜单「退出 Combo」
    if let Some(win) = main_window(app) {
        let win_for_close = win.clone();
        win.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win_for_close.hide();
            }
        });
    }

    Ok(())
}

// ---------- 忙碌动画 ----------

/// 一次完整穿行的帧数(单词从画布左缘外滑入到右缘外滑出)
const BUSY_FRAMES: usize = 24;
/// 忙碌时帧间隔(≈12.5fps,「combo」穿行一轮约 1.9s)
const BUSY_FRAME_MS: u64 = 80;
/// 空闲时轮询 run 状态的间隔
const IDLE_POLL_MS: u64 = 400;

/// 「combo」五个字母的像素字模:每字形 5 行高,行内比特 MSB 为最左列
/// (m 为 5 列宽,其余 3 列宽;字母间以 1 列字模间隔)
const COMBO_GLYPHS: [(u32, [u8; 5]); 5] = [
    (3, [0b111, 0b100, 0b100, 0b100, 0b111]),          // c
    (3, [0b111, 0b101, 0b101, 0b101, 0b111]),          // o
    (5, [0b10001, 0b11011, 0b10101, 0b10001, 0b10001]), // m
    (3, [0b100, 0b100, 0b110, 0b101, 0b110]),          // b
    (3, [0b111, 0b101, 0b101, 0b101, 0b111]),          // o
];

/// 字母颜色:黑色。
/// macOS 下忙碌帧以 template 模式渲染(RGB 被忽略,系统自动用菜单栏
/// 前景色——浅色栏黑、深色栏白);此颜色仅在 Windows/Linux 回退路径
/// (set_icon 直接渲染 RGB)下生效。
const LETTER_RGB: [u8; 3] = [0, 0, 0];

/// 预生成的托盘图标:空闲(原图)+ 忙碌动画帧序列。
struct TrayIcons {
    idle: tauri::image::Image<'static>,
    busy: Vec<tauri::image::Image<'static>>,
}

/// 程序化生成忙碌动画帧:
/// **无背景**(整帧透明),「combo」五个黑色像素字母从画布右缘外滑入、
/// 弹跳着向左前进、左缘外滑出,循环往复;相邻字母相位逐个错开,弹跳波
/// 自左向右传播。字母字号随水平位置缩放:画布中间为满字号(两个 3 列
/// 字母 + 字间隔占满画布宽、高 ≈ 5/7 画布高),越靠边缘越小(边缘及
/// 画布外为满字号的 0.5 倍),以字母中心为锚线性过渡、始终垂直居中。
/// 弹跳为抛物线(静止为 0、峰值 amp)。24 帧与弹跳周期 6 帧整除,
/// 循环无缝衔接。(几何参数以 44px 基准图调校,按实际宽度等比缩放)
fn build_tray_icons() -> Option<TrayIcons> {
    use image::GenericImageView;

    let base = image::load_from_memory(include_bytes!("../icons/tray-icon.png")).ok()?;
    let (w, h) = base.dimensions();
    let idle = tauri::image::Image::new_owned(base.to_rgba8().into_raw(), w, h);

    // 几何/节奏参数(44px 基准,按实际宽度等比缩放)
    let scale = w as f32 / 44.0;
    // 满字号:两个 3 列字母 + 1 列字间隔 = 7 单元恰好占满画布宽;
    // 满字高 5 单元 ≈ 画布高的 71%(画布中间的字母用满字号,
    // 越靠边缘越小,边缘及画布外缩至 0.5 倍)
    let cell = w as f32 / 7.0;
    let word_cells: f32 = COMBO_GLYPHS.iter().map(|&(gw, _)| gw as f32 + 1.0).sum(); // 22(含间隔)
    let word_w = word_cells * cell;        // ≈ 138px,远大于画布宽,同屏约可见 2~3 个字母
    let travel = word_w + w as f32;        // 从完全滑入到完全滑出的总行程
    let speed = travel / BUSY_FRAMES as f32;
    let amp = 5.5 * scale;                 // 弹跳高度(顶部留 ~1px 余量,不裁剪)
    let hop_period = 6.0;                  // 单字母弹跳周期(帧)
    let stagger = 1.0;                     // 相邻字母相位错开(帧)→ 弹跳波自左向右传播
    // 初始相位微调:让主字母 m(单词正中)在循环中点(k = BUSY_FRAMES/2)
    // 恰好经过画布中心——离散帧上呈现完整的「边缘小 → 中心满字号 →
    // 边缘小」对称缩放周期(不调相位时字母过心时刻落在两帧之间,
    // 峰值字号只能达到约 0.93 倍)
    let lead_off: f32 = COMBO_GLYPHS.iter().take(2).map(|&(gw, _)| gw as f32 + 1.0).sum();
    let lead_center = (lead_off + COMBO_GLYPHS[2].0 as f32 * 0.5) * cell;
    let phase0 = speed * (BUSY_FRAMES as f32 * 0.5) - w as f32 * 0.5 - lead_center;

    let mut busy = Vec::with_capacity(BUSY_FRAMES);
    let half_w = w as f32 * 0.5;
    for k in 0..BUSY_FRAMES {
        let kf = k as f32;
        let mut frame = vec![0u8; w as usize * h as usize * 4];
        // 反向穿行:单词左缘随帧左移;k=0 完全在画布右外(接缝空白帧)
        let mut x = w as f32 + phase0 - speed * kf;
        for (i, &(gw, rows)) in COMBO_GLYPHS.iter().enumerate() {
            let f = ((kf - i as f32 * stagger) % hop_period).rem_euclid(hop_period) / hop_period;
            let dy = -amp * 4.0 * f * (1.0 - f); // 抛物线弹跳
            // 字号随水平位置缩放:字母中心在画布中间为 1.0、边缘(及
            // 画布外)线性收窄到 0.5;以字母中心为锚、宽高同步缩放,
            // 垂直始终居中——形成「边缘滑入的小字母边左移边放大,
            // 过中心后再缩小滑出」的景深效果
            let gw_f = gw as f32;
            let cx = x + gw_f * cell * 0.5; // 字母中心(未缩放排布)
            let t = ((cx - half_w) / half_w).abs().min(1.0); // 中间 0 → 边缘 1
            let s = 1.0 - 0.5 * t;
            let left = cx - gw_f * cell * s * 0.5;
            let top = h as f32 * 0.5 - 5.0 * cell * s * 0.5 + dy;
            draw_glyph(&mut frame, w, h, gw, &rows, left, top, cell * s);
            x += (gw_f + 1.0) * cell;
        }
        busy.push(tauri::image::Image::new_owned(frame, w, h));
    }
    Some(TrayIcons { idle, busy })
}

/// 把一个字模画到 RGBA 缓冲的 (x, y_top) 处:每个字模单元映射为 cell×cell
/// 像素块,相邻单元边界取整衔接(列间无缝、重叠无害);越界像素裁剪,
/// 完全在画布外的单元直接跳过(避免 clamp 在边缘产生幻影像素)。
fn draw_glyph(
    buf: &mut [u8],
    w: u32,
    h: u32,
    gw: u32,
    rows: &[u8; 5],
    x: f32,
    y_top: f32,
    cell: f32,
) {
    let (wi, hi) = (w as i32, h as i32);
    for (r, row) in rows.iter().enumerate() {
        for c in 0..gw {
            if row & (1 << (gw - 1 - c)) == 0 {
                continue;
            }
            let rx0 = (x + c as f32 * cell).round() as i32;
            let rx1 = (x + (c as f32 + 1.0) * cell).round() as i32;
            let ry0 = (y_top + r as f32 * cell).round() as i32;
            let ry1 = (y_top + (r as f32 + 1.0) * cell).round() as i32;
            if rx1 <= 0 || ry1 <= 0 || rx0 >= wi || ry0 >= hi {
                continue;
            }
            let x0 = rx0.max(0);
            let x1 = rx1.clamp(x0 + 1, wi);
            let y0 = ry0.max(0);
            let y1 = ry1.clamp(y0 + 1, hi);
            for yy in y0..y1 {
                for xx in x0..x1 {
                    let i = (yy as usize * w as usize + xx as usize) * 4;
                    buf[i] = LETTER_RGB[0];
                    buf[i + 1] = LETTER_RGB[1];
                    buf[i + 2] = LETTER_RGB[2];
                    buf[i + 3] = 255;
                }
            }
        }
    }
}

/// 托盘忙碌动画主循环:轮询内嵌 serve 的全局运行态(RunState),
/// 任一项目(含自动化任务)的 run 进行中时循环播放动画帧,
/// 全部结束后恢复静态图标。图标更新经 tauri/tray-icon 内部派发到
/// 主线程执行,可在后台任务中安全调用。
///
/// 忙碌帧以 **template 模式**设置(macOS 忽略 RGB、按 alpha 剪影渲染为
/// 菜单栏前景色):浅色菜单栏下自动为黑色字母、深色菜单栏下自动为白色
/// 字母;`set_icon_with_as_template` 原子设置图标与标记,避免分两次
/// 调用造成图标渲染两遍的可见闪烁。恢复静态原图时切回非 template
/// (原图是黑色方块+白色 C 的彩色图,template 会把它压成单色剪影)。
pub async fn watch_busy(app: AppHandle, state: AppState) {
    let Some(tray) = app.tray_by_id("main") else {
        return; // 托盘不可用(初始化失败或无托盘环境)
    };
    let Some(icons) = build_tray_icons() else {
        eprintln!("托盘忙碌动画帧生成失败,保持静态图标");
        return;
    };
    let mut frame = 0usize;
    let mut showing_busy = false;
    loop {
        if state.runs.any_busy() {
            if !showing_busy {
                showing_busy = true;
                let _ = tray.set_tooltip(Some("Combo — 任务执行中"));
            }
            let _ = tray.set_icon_with_as_template(
                Some(icons.busy[frame % BUSY_FRAMES].clone()),
                true,
            );
            frame = frame.wrapping_add(1);
            tokio::time::sleep(Duration::from_millis(BUSY_FRAME_MS)).await;
        } else {
            if showing_busy {
                let _ = tray.set_icon_with_as_template(Some(icons.idle.clone()), false);
                let _ = tray.set_tooltip(Some("Combo"));
                showing_busy = false;
            }
            tokio::time::sleep(Duration::from_millis(IDLE_POLL_MS)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(img: &tauri::image::Image, x: u32, y: u32) -> [u8; 4] {
        let w = img.width() as usize;
        let i = ((y as usize) * w + x as usize) * 4;
        let d = img.rgba();
        [d[i], d[i + 1], d[i + 2], d[i + 3]]
    }

    /// 帧生成正确性:无背景(整帧要么透明要么黑色字母)、中间满字号
    /// (两字母占满画布宽)、边缘缩至 0.5 倍、单词自右向左穿行、
    /// 字母上下弹跳、循环接缝处为空白帧。
    #[test]
    fn busy_frames_generated_correctly() {
        let icons = build_tray_icons().expect("build_tray_icons");
        assert_eq!(icons.busy.len(), BUSY_FRAMES);
        assert_eq!(icons.idle.width(), 44);
        assert_eq!(icons.idle.height(), 44);

        // 无背景:所有像素要么完全透明,要么为不透明字母色
        for f in &icons.busy {
            for px in f.rgba().chunks_exact(4) {
                if px[3] == 0 {
                    assert!(px[0] == 0 && px[1] == 0 && px[2] == 0, "透明像素不应带颜色");
                } else {
                    assert_eq!(px[3], 255);
                    assert_eq!(&px[..3], &LETTER_RGB[..], "非透明像素应为字母色");
                }
            }
        }

        // 字母为黑色(用户要求:文字黑色)
        assert_eq!(LETTER_RGB, [0, 0, 0]);

        // 字号:两个 3 列字母 + 字间隔 = 7 单元占满画布宽,字母高 ≈ 5/7 画布高
        let span = |f: &tauri::image::Image| -> (u32, u32, u32, u32) {
            let (mut x0, mut x1, mut y0, mut y1) = (u32::MAX, 0u32, u32::MAX, 0u32);
            for y in 0..f.height() {
                for x in 0..f.width() {
                    if px(f, x, y)[3] != 0 {
                        x0 = x0.min(x);
                        x1 = x1.max(x);
                        y0 = y0.min(y);
                        y1 = y1.max(y);
                    }
                }
            }
            (x0, x1, y0, y1)
        };
        // 字号随水平位置缩放:帧 12 时 m 恰好在画布正中,应为满字号
        // (高 ≈ 5/7 画布高 = 31px);帧 2 时字母刚从右缘滑入,应缩至
        // 满字号的约 0.5 倍(高 ≈16px)
        let (_, _, y0, y1) = span(&icons.busy[12]);
        assert!(
            y1 - y0 + 1 >= 30,
            "画布中间的字母应保持满字号(高 ≈31px,实测 {y0}..{y1})"
        );
        let (x0, x1, ey0, ey1) = span(&icons.busy[2]);
        assert!(x1 >= x0, "帧 2 应有字母刚滑入画布");
        assert!(
            ey1 - ey0 + 1 <= 20,
            "画布边缘的字母应缩至满字号的约 0.5 倍(高 ≈16px,实测 {ey0}..{ey1})"
        );

        // k=0 单词完全在画布右缘外 → 空白帧(穿行循环的接缝)
        assert!(icons.busy[0].rgba().iter().all(|&b| b == 0));

        // 自右向左:相邻帧的列轮廓最佳对齐位移应为负(单词持续左移)。
        // 不用可见质心——单词远宽于画布时,字母间隙会使可见质心非单调回摆。
        let column_profile = |f: &tauri::image::Image| -> Vec<u32> {
            let mut p = vec![0u32; f.width() as usize];
            for (i, px) in f.rgba().chunks_exact(4).enumerate() {
                if px[3] != 0 {
                    p[i % f.width() as usize] += 1;
                }
            }
            p
        };
        let dot_at = |a: &[u32], b: &[u32], s: i32| -> u64 {
            (0..a.len() as i32)
                .map(|x| {
                    let t = x + s;
                    if t >= 0 && (t as usize) < b.len() {
                        a[x as usize] as u64 * b[t as usize] as u64
                    } else {
                        0
                    }
                })
                .sum()
        };
        for k in [6usize, 12, 18] {
            let a = column_profile(&icons.busy[k]);
            let b = column_profile(&icons.busy[k + 1]);
            let best_neg = (-14..=-1).map(|s| dot_at(&a, &b, s)).max().unwrap();
            let best_nonneg = (0..=6).map(|s| dot_at(&a, &b, s)).max().unwrap();
            assert!(
                best_neg > best_nonneg,
                "帧 {k}→{} 的最佳对齐应为负位移(左移),负 {best_neg} vs 非负 {best_nonneg}",
                k + 1
            );
        }

        // 弹跳:字母最高点在帧间明显起伏(抛物线弹跳叠加字号缩放;
        // 跳过空白接缝帧)
        let topmost = |f: &tauri::image::Image| -> u32 {
            (0..f.height())
                .find(|&y| (0..f.width()).any(|x| px(f, x, y)[3] != 0))
                .unwrap_or(f.height())
        };
        let tops: Vec<u32> = icons.busy.iter().skip(1).map(|f| topmost(f)).collect();
        let (mn, mx) = (tops.iter().min().unwrap(), tops.iter().max().unwrap());
        assert!(mx - mn >= 4, "字母弹跳应有明显幅度({mn}..{mx})");
    }

    /// 调试用:ASCII 目检动画帧(`cargo test dump_busy -- --nocapture` 查看),
    /// 采样入场/中段/出场的 7 帧,确认字模形状与弹跳波形。
    #[test]
    fn dump_busy_frames_ascii() {
        let icons = build_tray_icons().expect("build_tray_icons");
        for k in [3usize, 6, 9, 12, 15, 18, 21] {
            let f = &icons.busy[k];
            println!("--- frame {k} ---");
            for y in 0..f.height() {
                let mut line = String::new();
                for x in 0..f.width() {
                    line.push_str(if px(f, x, y)[3] != 0 { "██" } else { "  " });
                }
                println!("{line}");
            }
        }
    }
}

