//! 系统托盘(macOS / Windows):
//! - 右键托盘图标弹出菜单,提供主要功能:新建任务、退出
//! - 左键点击托盘图标切换主窗口显隐(不弹菜单)
//! - 关闭主窗口改为「隐藏到托盘」,真正退出走托盘菜单「退出 Combo」

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// 托盘「新建任务」事件:后端先唤起主窗口再 emit,前端收到后新建会话
pub const EVENT_TRAY_NEW_TASK: &str = "tray-new-task";

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
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let new_task = MenuItem::with_id(app, "new-task", "新建任务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Combo", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&new_task, &separator, &quit])?;

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
            _ => {}
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

    // 托盘图标:优先用内嵌默认窗口图标,缺失时回退打包的 32x32.png
    let icon = app
        .default_window_icon()
        .cloned()
        .or_else(|| tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).ok());
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
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
