//! 系统托盘(macOS / Windows):
//! - 右键托盘图标弹出菜单,提供主要功能:新建任务、退出
//! - 左键点击托盘图标切换主窗口显隐(不弹菜单)
//! - 关闭主窗口改为「隐藏到托盘」,真正退出走托盘菜单「退出 Combo」
//! - 忙碌动画:任一项目有任务在执行时,图标在静态底图(黑色圆角方块,
//!   与空闲图标完全一致)上叠加**白色**「combo」字母逐个展示动画——
//!   字母从右缘幕后滑入中心(减速),落定后果冻般压扁/回弹(squash &
//!   stretch 衰减振荡),静止停顿一会儿,再加速滑出左缘,轮到下一个
//!   字母;任务全部结束后恢复静态图标

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

/// 单个字母一个完整展示周期的阶段帧数:
/// 进入(从右缘幕后减速滑入中心)→ 果冻(中心 squash & stretch 衰减振荡)
/// → 停顿(静止展示)→ 移出(从静止加速滑出左缘)
const ENTER_FRAMES: usize = 9;
const JELLY_FRAMES: usize = 12;
const HOLD_FRAMES: usize = 5;
const EXIT_FRAMES: usize = 8;
/// 每字母完整周期(帧)
const LETTER_FRAMES: usize = ENTER_FRAMES + JELLY_FRAMES + HOLD_FRAMES + EXIT_FRAMES;
/// 一次完整循环的总帧数(「combo」五个字母依次展示,末字母出场后
/// 无缝衔接首字母入场——两帧都是纯底图,接缝平滑)
const BUSY_FRAMES: usize = LETTER_FRAMES * COMBO_GLYPHS.len();
/// 忙碌时帧间隔(≈12.5fps;每字母约 2.7s,整轮「combo」约 13.6s)
const BUSY_FRAME_MS: u64 = 80;
/// 空闲时轮询 run 状态的间隔
const IDLE_POLL_MS: u64 = 400;

/// 「combo」五个字母的像素字模:每字形 5 行高,行内比特 MSB 为最左列
/// (m 为 5 列宽,其余 3 列宽)
const COMBO_GLYPHS: [(u32, [u8; 5]); 5] = [
    (3, [0b111, 0b100, 0b100, 0b100, 0b111]),           // c
    (3, [0b111, 0b101, 0b101, 0b101, 0b111]),           // o
    (5, [0b10001, 0b11011, 0b10101, 0b10001, 0b10001]), // m
    (3, [0b100, 0b100, 0b110, 0b101, 0b110]),           // b
    (3, [0b111, 0b101, 0b101, 0b101, 0b111]),           // o
];

/// 字母颜色:白色。忙碌帧以静态原图(黑色圆角方块)为底,白色字母
/// 绘制在方块内——与空闲图标配色统一(黑底白字),浅色/深色菜单栏
/// 下都自带对比、清晰可见;因此忙碌帧与空闲帧同为**非 template**
/// 彩色图直接渲染。
const LETTER_RGB: [u8; 3] = [255, 255, 255];

/// 预生成的托盘图标:空闲(原图)+ 忙碌动画帧序列。
struct TrayIcons {
    idle: tauri::image::Image<'static>,
    busy: Vec<tauri::image::Image<'static>>,
}

/// 程序化生成忙碌动画帧:
/// **每帧底图 = 静态图去掉白色 C 字形**(白色连同抗锯齿灰边一并涂黑,
/// 只留黑色圆角方块)——动画字母经过中心时不与静态字形叠加成杂乱的
/// 复合形状,黑底白字配色仍与空闲图标完全统一。白色「combo」字母
/// **逐个**展示:从方块右缘「幕后」滑入(绘制裁剪在方块内,缘外部分
/// 不画,呈现从幕后走出),减速停在中心;落定瞬间起果冻式 squash &
/// stretch(先压扁变宽变矮,再回弹拉高变窄,振幅指数衰减,以字母中心
/// 为锚);静止停顿一会儿;再从静止加速滑出左缘,轮到下一个字母。
/// 字母字号随水平位置缩放:中心为满字号(高 ≈ 画布高一半),越靠边缘
/// 越小(缩至 0.6 倍),形成「滑入渐大、滑出渐小」的景深。
/// (几何参数以 44px 基准图调校,按实际宽度等比缩放)
fn build_tray_icons() -> Option<TrayIcons> {
    use image::GenericImageView;

    let base = image::load_from_memory(include_bytes!("../icons/tray-icon.png")).ok()?;
    let (w, h) = base.dimensions();
    let idle_rgba = base.to_rgba8();
    let idle = tauri::image::Image::new_owned(idle_rgba.as_raw().clone(), w, h);

    // 忙碌帧底图:静态图中的白色 C 字形连同抗锯齿灰边涂黑(亮度阈值
    // 60 只命中字形区域,黑色方块内部本就是近黑像素不受影响)
    let mut busy_base = idle_rgba.clone();
    for p in busy_base.pixels_mut() {
        if p[3] != 0 && u32::from(p[0]) + u32::from(p[1]) + u32::from(p[2]) > 60 {
            *p = image::Rgba([0, 0, 0, 255]);
        }
    }
    let busy = render_busy_frames(busy_base.as_raw(), w, h);
    Some(TrayIcons { idle, busy })
}

/// 渲染忙碌动画帧(几何/节奏见 `letter_pose`):`base` 为帧底 RGBA
/// (静态图去掉字形后的纯黑圆角方块)。
fn render_busy_frames(base: &[u8], w: u32, h: u32) -> Vec<tauri::image::Image<'static>> {
    // 几何/节奏参数(44px 基准,按实际宽度等比缩放)
    let scale = w as f32 / 44.0;
    let center = w as f32 * 0.5;
    // 满字号单元:m 宽 5 格 ≈ 画布宽一半,字母高 5 格 = 画布高一半
    let cell = w as f32 / 10.0;
    // 画布边缘字号(相对满字号)
    let min_scale = 0.6;
    // 字母可见裁剪区(黑色方块内侧;圆角在四角,字母垂直居中不会触角)
    let pad = 3.0 * scale;
    let clip_x0 = pad;
    let clip_x1 = w as f32 - pad;

    let mut frames = Vec::with_capacity(BUSY_FRAMES);
    for &(gw, rows) in COMBO_GLYPHS.iter() {
        let glyph_w = gw as f32 * cell;
        for k in 0..LETTER_FRAMES {
            // 每帧从底图出发,叠加当前字母姿态
            let mut frame = base.to_vec();
            let (cx, (jx, jy)) = letter_pose(k, glyph_w, center, clip_x0, clip_x1);
            // 字号随水平位置缩放:字母中心越靠画布边缘越小(景深),
            // 与位置插值同步,滑入自然渐大、滑出自然渐小
            let t = ((cx - center) / center).abs().min(1.0);
            let s = 1.0 - (1.0 - min_scale) * t;
            draw_glyph(
                &mut frame,
                w,
                h,
                gw,
                &rows,
                cx,
                h as f32 * 0.5,
                cell * s * jx,
                cell * s * jy,
                clip_x0,
                clip_x1,
            );
            frames.push(tauri::image::Image::new_owned(frame, w, h));
        }
    }
    frames
}

/// 计算展示周期第 k 帧的字母姿态:中心 x 与果冻形变 (jx, jy)。
/// - 进入:从裁剪区右缘外 ease-out 减速滑向中心,末速为零——与果冻
///   落地的压扁帧无缝衔接(字母「落定」触发果冻);
/// - 果冻:中心处衰减振荡 `osc = e^(−λt)·cos(2π·1.5t)`,jx = 1+0.32·osc
///   (先压扁变宽)、jy = 1−0.26·osc(变矮),12 帧内 1.5 个来回,
///   振幅收敛到 ±3% 以内过渡到停顿;
/// - 停顿:满字号静止居中;
/// - 移出:从静止 ease-in 加速滑出裁剪区左缘(初速为零,与停顿衔接平滑)。
fn letter_pose(
    k: usize,
    glyph_w: f32,
    center: f32,
    clip_x0: f32,
    clip_x1: f32,
) -> (f32, (f32, f32)) {
    let start = clip_x1 + glyph_w * 0.5 + 1.0; // 完全在裁剪区外(不可见)
    let end = clip_x0 - glyph_w * 0.5 - 1.0;
    if k < ENTER_FRAMES {
        let u = k as f32 / ENTER_FRAMES as f32;
        let e = 1.0 - (1.0 - u) * (1.0 - u); // ease-out
        (start + (center - start) * e, (1.0, 1.0))
    } else if k < ENTER_FRAMES + JELLY_FRAMES {
        let t = (k - ENTER_FRAMES) as f32 / JELLY_FRAMES as f32;
        let osc = (-2.5 * t).exp() * (std::f32::consts::TAU * 1.5 * t).cos();
        (center, (1.0 + 0.32 * osc, 1.0 - 0.26 * osc))
    } else if k < ENTER_FRAMES + JELLY_FRAMES + HOLD_FRAMES {
        (center, (1.0, 1.0))
    } else {
        // +1 使末帧恰好完全移出裁剪区(纯底图,与下一字母首帧平滑衔接);
        // 首帧 e ≈ 0.016,从静止微启,与停顿结尾速度为零衔接平滑
        let u = (k - ENTER_FRAMES - JELLY_FRAMES - HOLD_FRAMES + 1) as f32 / EXIT_FRAMES as f32;
        let e = u * u; // ease-in
        (center + (end - center) * e, (1.0, 1.0))
    }
}

/// 把一个字模以 (cx, cy) 为中心画到 RGBA 缓冲:每列单元宽 cell_w、每行
/// 单元高 cell_h(宽高独立缩放,实现果冻的压扁/拉伸,以字母中心为锚);
/// x 方向限制在 [clip_x0, clip_x1](黑色方块内)——字母从缘外滑入/滑出
/// 时超出部分不绘制,呈现「从幕后走出/走入」效果。相邻单元边界取整
/// 衔接(列间无缝、重叠无害);越界像素裁剪,完全在裁剪区外的单元直接
/// 跳过(避免 clamp 在边缘产生幻影像素)。
#[allow(clippy::too_many_arguments)]
fn draw_glyph(
    buf: &mut [u8],
    w: u32,
    h: u32,
    gw: u32,
    rows: &[u8; 5],
    cx: f32,
    cy: f32,
    cell_w: f32,
    cell_h: f32,
    clip_x0: f32,
    clip_x1: f32,
) {
    let (wi, hi) = (w as i32, h as i32);
    let (cx0, cx1) = (clip_x0 as i32, clip_x1 as i32);
    let left = cx - gw as f32 * cell_w * 0.5;
    let top = cy - 5.0 * cell_h * 0.5;
    for (r, row) in rows.iter().enumerate() {
        for c in 0..gw {
            if row & (1 << (gw - 1 - c)) == 0 {
                continue;
            }
            let rx0 = (left + c as f32 * cell_w).round() as i32;
            let rx1 = (left + (c as f32 + 1.0) * cell_w).round() as i32;
            let ry0 = (top + r as f32 * cell_h).round() as i32;
            let ry1 = (top + (r as f32 + 1.0) * cell_h).round() as i32;
            if rx1 <= cx0 || rx0 >= cx1 {
                continue;
            }
            let x0 = rx0.max(cx0).max(0);
            let x1 = rx1.min(cx1).min(wi);
            let y0 = ry0.max(0);
            let y1 = ry1.min(hi);
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
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
/// 忙碌帧与空闲帧同为**非 template** 彩色图直接渲染:忙碌帧底图就是
/// 原静态图(黑色圆角方块),白色字母叠绘其上——配色与空闲图标统一,
/// 浅色/深色菜单栏下黑底白字都自带对比。`set_icon_with_as_template`
/// 原子设置图标与标记,避免分两次调用造成图标渲染两遍的可见闪烁。
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
            let _ = tray
                .set_icon_with_as_template(Some(icons.busy[frame % BUSY_FRAMES].clone()), false);
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

    fn is_letter(p: [u8; 4]) -> bool {
        p[3] == 255 && p[..3] == LETTER_RGB[..]
    }

    /// 白色字母像素的包围盒(None = 帧内无字母,纯底图)
    fn white_span(f: &tauri::image::Image) -> Option<(u32, u32, u32, u32)> {
        let (mut x0, mut x1, mut y0, mut y1) = (u32::MAX, 0u32, u32::MAX, 0u32);
        let mut found = false;
        for y in 0..f.height() {
            for x in 0..f.width() {
                if is_letter(px(f, x, y)) {
                    found = true;
                    x0 = x0.min(x);
                    x1 = x1.max(x);
                    y0 = y0.min(y);
                    y1 = y1.max(y);
                }
            }
        }
        found.then(|| (x0, x1, y0, y1))
    }

    /// 白色像素的 x 方向质心
    fn white_centroid_x(f: &tauri::image::Image) -> Option<f32> {
        let (mut sum, mut n) = (0u64, 0u64);
        for y in 0..f.height() {
            for x in 0..f.width() {
                if is_letter(px(f, x, y)) {
                    sum += x as u64;
                    n += 1;
                }
            }
        }
        (n > 0).then(|| sum as f32 / n as f32)
    }

    /// 帧生成正确性:正式帧底图与静态图一致(黑色圆角方块 + 白色字母,
    /// 配色统一);透明底参考帧验证字母几何——每字母周期「纯底图入场 →
    /// 左移滑入 → 中心果冻压扁/回弹 → 满字号居中停顿 → 左移滑出 →
    /// 纯底图收尾」。
    #[test]
    fn busy_frames_generated_correctly() {
        let icons = build_tray_icons().expect("build_tray_icons");
        assert_eq!(icons.busy.len(), BUSY_FRAMES);
        assert_eq!(icons.busy.len(), LETTER_FRAMES * COMBO_GLYPHS.len());
        assert_eq!(icons.idle.width(), 44);
        assert_eq!(icons.idle.height(), 44);

        // 字母为白色(绘制在黑色方块上,与静态图标配色统一)
        assert_eq!(LETTER_RGB, [255, 255, 255]);

        // 底图与静态图统一:每帧在字母活动区外的采样点(顶部中央)
        // 与空闲帧像素一致——黑色圆角方块、不透明;静态图中的白色 C
        // 字形连同灰边已涂黑(首帧 = 纯底图,无任何白色像素)
        for f in &icons.busy {
            let p = px(f, 22, 3);
            assert_eq!(p, px(&icons.idle, 22, 3), "底图方块应与静态图一致");
            assert_eq!(p[3], 255, "方块背景应不透明");
            assert_eq!(&p[..3], &[0u8, 0, 0][..], "方块背景应为黑色");
        }
        assert!(
            white_span(&icons.busy[0]).is_none(),
            "首帧应为纯黑底图(静态 C 字形已涂黑)"
        );

        // 字母几何断言(正式帧已无静态字形干扰,白色像素即字母本体)
        let frames = &icons.busy[..];
        assert_eq!(frames.len(), BUSY_FRAMES);

        // 每字母周期首帧:字母完全在裁剪区右缘外 → 无字母像素;
        // 入场第 1 帧字母已从右缘显露一截
        for li in 0..COMBO_GLYPHS.len() {
            assert!(
                white_span(&frames[li * LETTER_FRAMES]).is_none(),
                "字母 {li} 周期首帧应无字母(纯底图)"
            );
        }
        assert!(
            white_span(&frames[1]).is_some(),
            "入场第 1 帧应有字母从右缘显露"
        );

        // 字母只在方块内绘制(bbox 限制在裁剪区内)
        for f in frames {
            if let Some((x0, x1, _, _)) = white_span(f) {
                assert!(x0 >= 3 && x1 <= 41, "字母应绘制在方块内({x0}..{x1})");
            }
        }

        // 以 m(最宽字母,索引 2)检验展示几何
        let m_off = 2 * LETTER_FRAMES;
        let hold_k = m_off + ENTER_FRAMES + JELLY_FRAMES + HOLD_FRAMES / 2;
        let (hx0, hx1, hy0, hy1) = white_span(&frames[hold_k]).expect("停顿帧应有字母");
        // 停顿:满字号(高 ≈ 5·cell = 画布高一半)且水平居中
        assert_eq!(hy1 - hy0 + 1, 22, "停顿帧满字高应 ≈ 22px");
        assert_eq!(hy0, 11, "字母应垂直居中");
        assert!(
            (hx0 as i32 - 11).abs() <= 1 && (hx1 as i32 - 32).abs() <= 1,
            "停顿帧应水平居中({hx0}..{hx1})"
        );

        // 果冻:落定首帧明显压扁(更宽更矮),回弹中段拉高变窄
        let (jx0, jx1, jy0, jy1) =
            white_span(&frames[m_off + ENTER_FRAMES]).expect("果冻首帧应有字母");
        let (hw, hh) = (hx1 - hx0 + 1, hy1 - hy0 + 1);
        assert!(
            jx1 - jx0 + 1 >= hw + 4,
            "果冻首帧应压扁变宽({} vs {hw})",
            jx1 - jx0 + 1
        );
        assert!(
            jy1 - jy0 + 1 + 4 <= hh,
            "果冻首帧应压扁变矮({} vs {hh})",
            jy1 - jy0 + 1
        );
        let (_, _, my0, my1) =
            white_span(&frames[m_off + ENTER_FRAMES + 4]).expect("果冻回弹帧应有字母");
        assert!(
            my1 - my0 + 1 > hh,
            "果冻回弹帧应拉高({} vs {hh})",
            my1 - my0 + 1
        );

        // 进入阶段:白色质心持续左移(裁剪窗口固定,裁剪不影响单调性)
        let mut prev = white_centroid_x(&frames[1]).expect("入场第 1 帧质心");
        for k in 2..ENTER_FRAMES {
            let cur = white_centroid_x(&frames[k]).expect("入场帧质心");
            assert!(cur < prev, "入场阶段字母应持续左移(k={k})");
            prev = cur;
        }
        // 出场阶段:同样持续左移,末帧完全移出(无字母像素)
        let off = ENTER_FRAMES + JELLY_FRAMES + HOLD_FRAMES;
        let mut prev = white_centroid_x(&frames[off]).expect("出场首帧质心");
        for k in off + 1..LETTER_FRAMES - 1 {
            let cur = white_centroid_x(&frames[k]).expect("出场帧质心");
            assert!(cur < prev, "出场阶段字母应持续左移(k={k})");
            prev = cur;
        }
        assert!(
            white_span(&frames[LETTER_FRAMES - 1]).is_none(),
            "出场末帧应无字母(纯底图,与下一字母首帧平滑衔接)"
        );
    }

    fn off_frames() -> usize {
        ENTER_FRAMES + JELLY_FRAMES + HOLD_FRAMES
    }

    /// 调试用:ASCII 目检动画帧(`cargo test dump_busy -- --nocapture` 查看),
    /// 采样首字母的入场与 m 字母的果冻/停顿/出场,确认字模形状、
    /// 果冻压扁/回弹波形与黑底白字配色。
    #[test]
    fn dump_busy_frames_ascii() {
        let icons = build_tray_icons().expect("build_tray_icons");
        let m_off = 2 * LETTER_FRAMES;
        let samples = [
            (0usize, "字母c 周期首帧(纯底图)"),
            (1, "入场 1"),
            (4, "入场中"),
            (8, "入场末(减速)"),
            (9, "果冻落定(压扁)"),
            (11, "果冻回正"),
            (13, "果冻回弹(拉高)"),
            (17, "果冻尾"),
            (23, "停顿(满字号居中)"),
            (m_off + ENTER_FRAMES, "m 果冻落定(压扁)"),
            (m_off + ENTER_FRAMES + 4, "m 果冻回弹(拉高)"),
            (m_off + ENTER_FRAMES + JELLY_FRAMES + 2, "m 停顿"),
            (m_off + off_frames(), "m 出场首帧"),
            (m_off + LETTER_FRAMES - 1, "m 出场末帧(纯底图)"),
        ];
        for (k, label) in samples {
            let f = &icons.busy[k];
            println!("--- frame {k}({label}) ---");
            for y in 0..f.height() {
                let mut line = String::new();
                for x in 0..f.width() {
                    let p = px(f, x, y);
                    if is_letter(p) {
                        line.push_str("██");
                    } else if p[3] > 200 {
                        line.push_str("··"); // 黑色方块
                    } else {
                        line.push_str("  ");
                    }
                }
                println!("{line}");
            }
        }
    }
}
