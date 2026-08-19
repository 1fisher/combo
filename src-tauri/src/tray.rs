//! 系统托盘(macOS / Windows):
//! - 右键托盘图标弹出菜单,提供主要功能:新建任务、退出
//! - 左键点击托盘图标切换主窗口显隐(不弹菜单)
//! - 关闭主窗口改为「隐藏到托盘」,真正退出走托盘菜单「退出 Combo」

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
