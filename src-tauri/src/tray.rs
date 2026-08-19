//! 系统托盘(macOS / Windows):
//! - 右键托盘图标弹出菜单,提供主要功能:新建任务、退出
//! - 左键点击托盘图标切换主窗口显隐(不弹菜单)
//! - 关闭主窗口改为「隐藏到托盘」,真正退出走托盘菜单「退出 Combo」
//! - 忙碌动画:任一项目有任务在执行时,图标切换为琥珀色方块 + 白色
//!   旋转扫光圆环(经典 spinner),任务全部结束后恢复静态图标

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
/// 标准项(⌘C/⌘V/⌘Q/全屏等不受影响),仅去掉「关闭窗口」——主窗口关闭本就被
/// 拦截为隐藏到托盘,真正退出走托盘菜单,行为不受影响。
/// 注意「编辑」菜单不放 select_all:预定义「全选」自带 ⌘A 会同样截获按键,
/// 而 ⌘A 已分配给「自动化」视图(输入框/CodeMirror 内的全选由 web 层自己处理)。
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
    let view_auto = MenuItem::with_id(app, "view-automation", "自动化", true, Some("CmdOrCtrl+A"))?;
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

/// 动画帧数(一整圈扫光的采样数)
const BUSY_FRAMES: usize = 16;
/// 忙碌时帧间隔(≈12.5fps,扫光一圈约 1.3s)
const BUSY_FRAME_MS: u64 = 80;
/// 空闲时轮询 run 状态的间隔
const IDLE_POLL_MS: u64 = 400;

/// 预生成的托盘图标:空闲(原图)+ 忙碌动画帧序列。
struct TrayIcons {
    idle: tauri::image::Image<'static>,
    busy: Vec<tauri::image::Image<'static>>,
}

/// 程序化生成忙碌动画帧:
/// 以静态图标的圆角方块轮廓(alpha)为底,方块重涂为琥珀色并随帧呼吸脉动,
/// 原白色「C」替换为白色圆环,环上亮度沿角度分布——头部最亮、尾迹逆时针渐隐,
/// 头部随帧顺时针推进,形成经典 spinner;明/暗两种菜单栏背景下对比度均足够。
/// (几何参数以 44px 基准图调校,按实际宽度等比缩放)
fn build_tray_icons() -> Option<TrayIcons> {
    use image::GenericImageView;

    const TAU: f32 = std::f32::consts::TAU;
    const FRAC_PI_2: f32 = std::f32::consts::FRAC_PI_2;

    let base = image::load_from_memory(include_bytes!("../icons/tray-icon.png")).ok()?;
    let (w, h) = base.dimensions();
    let rgba = base.to_rgba8().into_raw();
    let idle = tauri::image::Image::new_owned(rgba.clone(), w, h);

    let (wf, hf) = (w as f32, h as f32);
    let (cx, cy) = (wf / 2.0, hf / 2.0);
    let radius = wf * (10.0 / 44.0); // 圆环中心线半径
    let half_thick = wf * (2.6 / 44.0); // 圆环半厚度(≈C 字形笔画宽度)
    let aa = (wf * (1.0 / 44.0)).max(0.5); // 径向抗锯齿宽度
    // 方块脉动的两个琥珀色端点(暗 ↔ 亮)
    const SQ_DIM: [f32; 3] = [140.0, 60.0, 12.0];
    const SQ_BRIGHT: [f32; 3] = [232.0, 128.0, 10.0];

    let mut busy = Vec::with_capacity(BUSY_FRAMES);
    for k in 0..BUSY_FRAMES {
        let t = k as f32 / BUSY_FRAMES as f32;
        let theta = t * TAU - FRAC_PI_2; // 扫光头部角度
        let pulse = 0.5 - 0.5 * (t * TAU).cos(); // 方块每圈呼吸一次
        let square = [
            SQ_DIM[0] + (SQ_BRIGHT[0] - SQ_DIM[0]) * pulse,
            SQ_DIM[1] + (SQ_BRIGHT[1] - SQ_DIM[1]) * pulse,
            SQ_DIM[2] + (SQ_BRIGHT[2] - SQ_DIM[2]) * pulse,
        ];
        let frame = rgba
            .chunks_exact(4)
            .enumerate()
            .flat_map(|(i, px)| {
                let a = px[3];
                if a == 0 {
                    return [px[0], px[1], px[2], a];
                }
                let (x, y) = ((i % w as usize) as f32, (i / w as usize) as f32);
                let (dx, dy) = (x + 0.5 - cx, y + 0.5 - cy);
                let dist = dx.hypot(dy);
                let ring_w =
                    (((half_thick + aa) - (dist - radius).abs()) / (2.0 * aa)).clamp(0.0, 1.0);
                // 尾迹亮度:头部(d=0)最亮,逆时针一周渐隐至 0.15
                let d = (theta - dy.atan2(dx)).rem_euclid(TAU);
                let head = 255.0 * ring_w * (0.15 + 0.85 * (1.0 - d / TAU).powf(1.3));
                [
                    (square[0] * (1.0 - ring_w) + head).round().min(255.0) as u8,
                    (square[1] * (1.0 - ring_w) + head).round().min(255.0) as u8,
                    (square[2] * (1.0 - ring_w) + head).round().min(255.0) as u8,
                    a,
                ]
            })
            .collect::<Vec<u8>>();
        busy.push(tauri::image::Image::new_owned(frame, w, h));
    }
    Some(TrayIcons { idle, busy })
}

/// 托盘忙碌动画主循环:轮询内嵌 serve 的全局运行态(RunState),
/// 任一项目(含自动化任务)的 run 进行中时循环播放动画帧,
/// 全部结束后恢复静态图标。图标更新经 tauri/tray-icon 内部派发到
/// 主线程执行,可在后台任务中安全调用。
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
            let _ = tray.set_icon(Some(icons.busy[frame % BUSY_FRAMES].clone()));
            frame = frame.wrapping_add(1);
            tokio::time::sleep(Duration::from_millis(BUSY_FRAME_MS)).await;
        } else {
            if showing_busy {
                let _ = tray.set_icon(Some(icons.idle.clone()));
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

    /// 帧生成正确性:空闲帧为原图;动画帧保持圆角方块 alpha 轮廓,
    /// 中心显示随帧脉动的琥珀方块色,白色扫光头部顺时针旋转。
    #[test]
    fn busy_frames_generated_correctly() {
        let icons = build_tray_icons().expect("build_tray_icons");
        assert_eq!(icons.busy.len(), BUSY_FRAMES);
        assert_eq!(icons.idle.width(), 44);
        assert_eq!(icons.idle.height(), 44);

        // alpha 轮廓(圆角方块)在所有动画帧中保持不变
        let idle_alpha = icons.idle.rgba().to_vec();
        for f in &icons.busy {
            for (a, b) in idle_alpha
                .iter()
                .skip(3)
                .step_by(4)
                .zip(f.rgba().iter().skip(3).step_by(4))
            {
                assert_eq!(a, b);
            }
        }

        // 中心(圆环内)为琥珀方块色:呼吸脉动 k=0 暗 / k=8 亮(取值精确无混叠)
        assert_eq!(px(&icons.busy[0], 22, 22), [140, 60, 12, 255]);
        assert_eq!(px(&icons.busy[8], 22, 22), [232, 128, 10, 255]);

        // 扫光头部随帧顺时针推进:k=0 在顶部、k=8 在底部,离头处亮度回落
        assert!(px(&icons.busy[0], 20, 12)[0] > 200, "k=0 头部应位于顶部");
        assert!(px(&icons.busy[0], 23, 31)[0] < 160);
        assert!(px(&icons.busy[8], 23, 31)[0] > 200, "k=8 头部应位于底部");
        assert!(px(&icons.busy[8], 20, 12)[0] < 160);
    }
}
