/*
 * Combo 启动画面(加载动画)。
 *
 * 运行在 React bundle 之前(index.html 以普通 <script> 引入,先于 type=module
 * 的 main.tsx 执行),负责:
 *   1. 粒子合并动画 —— 从真实图标(public/combo-icon.png)采样像素生成粒子
 *      目标点与颜色,粒子从四周沿弧线飞向目标,「前端加载进度」驱动合并程度:
 *      进度 0% 粒子散布四周 → 100% 完全凝聚成 Combo 图标;
 *   2. 加载进度 —— 真实信号(DOMContentLoaded / load / combo:app-ready)加权
 *      + 缓动模拟推进(上限 92%),React 挂载完成(ready)后冲到 100%;
 *   3. 收尾 —— 粒子淡出、清晰原图淡入,图标下方浮现流光 "combo" 单词
 *      (CSS 见 index.html 内嵌样式),停留片刻后整体淡出并移除 DOM。
 *
 * 约定:main.tsx 在应用首帧绘制后派发 window 事件 `combo:app-ready`。
 * 兜底:图标加载失败时程序化绘制圆角方块 + "C" 采样;ready 信号 10s 未到
 * 则自动收尾,避免脚本异常时永久卡在启动画面。
 */
(function () {
  'use strict';

  var root = document.getElementById('combo-splash');
  if (!root) return;

  var canvas = document.getElementById('combo-splash-canvas');
  var barFill = document.getElementById('combo-splash-bar-fill');
  var percentEl = document.getElementById('combo-splash-percent');
  var ctx = canvas.getContext('2d');

  // —— 节奏参数(毫秒)——
  var SPLASH_MIN_MS = 2300; // 最短总展示:避免一闪而过
  var ASSEMBLE_ICON_MS = 520; // 完成后原图淡入时长
  var ASSEMBLE_HOLD_MS = 1250; // 流光单词停留时长
  var FADE_OUT_MS = 550; // 整体淡出时长(与 CSS transition 对齐)
  var READY_TIMEOUT_MS = 10000; // app-ready 兜底超时

  var reducedMotion = false;
  try {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {
    /* 忽略 */
  }

  var t0 = performance.now();
  var readyAt = 0; // combo:app-ready 到达时刻;0 表示未到
  var assembledAt = 0; // 进入收尾阶段(进度冲 100)的时刻
  var removed = false;

  // 进度状态:display 向 target 缓动逼近;target 由真实信号 + 模拟曲线共同决定
  var display = 0;
  var target = 0.1;
  var domReadyBoost = 0;
  var loadBoost = 0;

  // —— 粒子数据 ——
  var SAMPLE = 80; // 采样网格边长(逻辑像素,与显示大小解耦,按比例映射)
  var STEP = 2; // 采样步长:~1600 粒子,点阵质感清晰又不失个体感
  var particles = null; // {sx,sy(散布起点), tx,ty(目标), cx,cy(贝塞尔控制点), r,g,b, stagger}
  var iconImg = null;
  var iconAlpha = 0; // 收尾时原图淡入的不透明度

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  function easeOutCubic(t) {
    var u = 1 - t;
    return 1 - u * u * u;
  }

  // —— 图标采样:img 可用时读像素;失败则程序化绘制同构图形兜底 ——
  function buildSampleSource() {
    var off = document.createElement('canvas');
    off.width = SAMPLE;
    off.height = SAMPLE;
    var octx = off.getContext('2d');
    if (iconImg) {
      octx.drawImage(iconImg, 0, 0, SAMPLE, SAMPLE);
    } else {
      // 兜底:与真实图标同构 —— 蓝紫对角渐变圆角方块 + 白色 "C"
      var grad = octx.createLinearGradient(0, 0, SAMPLE, SAMPLE);
      grad.addColorStop(0, '#5494ff');
      grad.addColorStop(1, '#6060f7');
      octx.fillStyle = grad;
      var r = SAMPLE * 0.22;
      octx.beginPath();
      octx.moveTo(r, 0);
      octx.arcTo(SAMPLE, 0, SAMPLE, SAMPLE, r);
      octx.arcTo(SAMPLE, SAMPLE, 0, SAMPLE, r);
      octx.arcTo(0, SAMPLE, 0, 0, r);
      octx.arcTo(0, 0, SAMPLE, 0, r);
      octx.closePath();
      octx.fill();
      octx.fillStyle = '#ffffff';
      octx.font = '700 ' + Math.round(SAMPLE * 0.62) + 'px system-ui, sans-serif';
      octx.textAlign = 'center';
      octx.textBaseline = 'middle';
      octx.fillText('C', SAMPLE / 2, SAMPLE / 2 + SAMPLE * 0.03);
    }
    return octx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  }

  function initParticles(cssSize) {
    var data = buildSampleSource();
    var list = [];
    var scale = cssSize / SAMPLE;
    var cx = cssSize / 2;
    var cy = cssSize / 2;
    for (var y = 0; y < SAMPLE; y += STEP) {
      for (var x = 0; x < SAMPLE; x += STEP) {
        var i = (y * SAMPLE + x) * 4;
        var a = data[i + 3];
        if (a < 140) continue; // 跳过透明像素(圆角外)
        // 散布起点:画布外圈随机角度,半径 0.8~1.6 倍画布尺寸
        var angle = Math.random() * Math.PI * 2;
        var dist = cssSize * (0.8 + Math.random() * 0.8);
        var sx = cx + Math.cos(angle) * dist;
        var sy = cy + Math.sin(angle) * dist;
        var tx = (x + STEP / 2) * scale;
        var ty = (y + STEP / 2) * scale;
        // 贝塞尔控制点:中点向垂直方向随机偏移,飞行轨迹带弧度
        var mx = (sx + tx) / 2;
        var my = (sy + ty) / 2;
        var dx = tx - sx;
        var dy = ty - sy;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var bend = (Math.random() - 0.5) * cssSize * 0.55;
        list.push({
          sx: sx,
          sy: sy,
          tx: tx,
          ty: ty,
          cx: mx + (-dy / len) * bend,
          cy: my + (dx / len) * bend,
          r: data[i],
          g: data[i + 1],
          b: data[i + 2],
          stagger: Math.random(), // 每粒子起飞延迟系数,营造先后汇聚层次
          phase: Math.random() * Math.PI * 2, // 到位后呼吸相位
        });
      }
    }
    particles = list;
  }

  var cssSize = 0;
  function resize() {
    cssSize = canvas.clientWidth || 160;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssSize * dpr);
    canvas.height = Math.round(cssSize * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initParticles(cssSize);
  }

  // 二次贝塞尔插值
  function bezier(p0, p1, p2, t) {
    var it = 1 - t;
    return it * it * p0 + 2 * it * t * p1 + t * t * p2;
  }

  function draw(now) {
    if (assembledAt > 0 || reducedMotion) {
      // 收尾/弱动效阶段:完全清屏,保证原图清晰浮现
      ctx.clearRect(0, 0, cssSize, cssSize);
    } else {
      // 加载阶段:半透明覆盖制造运动拖尾(颜色与 splash 背景一致)
      ctx.fillStyle = 'rgba(16, 17, 22, 0.38)';
      ctx.fillRect(0, 0, cssSize, cssSize);
    }
    if (!particles) return;

    var p = clamp01(display);
    var t = now / 1000;

    // 收尾阶段:清晰原图淡入
    if (assembledAt > 0) {
      iconAlpha = clamp01((now - assembledAt) / ASSEMBLE_ICON_MS);
    }

    for (var i = 0; i < particles.length; i++) {
      var pt = particles[i];
      // 进度 → 单粒子行程:整体进度 * 1.15 再减去随机延迟,保证 display=1 时全部到位
      var e = easeOutCubic(clamp01(p * 1.15 - pt.stagger * 0.15));
      var x = bezier(pt.sx, pt.cx, pt.tx, e);
      var y = bezier(pt.sy, pt.cy, pt.ty, e);
      var alpha = 0.55 + 0.45 * e; // 飞行中略透明,到位后饱满
      if (e >= 1) {
        // 到位呼吸:轻微亮度波动 + 亚像素抖动,避免凝聚后完全静止死板
        var w = 0.5 + 0.5 * Math.sin(t * 2.2 + pt.phase);
        alpha = 0.86 + 0.14 * w;
        x += Math.sin(t * 1.7 + pt.phase) * 0.35;
        y += Math.cos(t * 1.9 + pt.phase) * 0.35;
      }
      if (assembledAt > 0) {
        alpha *= 1 - iconAlpha; // 原图浮现后粒子同步让位
      }
      if (alpha <= 0.01) continue;
      if (reducedMotion) {
        x = pt.tx;
        y = pt.ty;
      }
      // 飞行中粒子略大,到位后收细,增强「凝聚」的收束感
      var radius = 1.7 + 0.5 * (1 - e);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgb(' + pt.r + ',' + pt.g + ',' + pt.b + ')';
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (iconImg && iconAlpha > 0) {
      ctx.globalAlpha = iconAlpha;
      ctx.drawImage(iconImg, 0, 0, cssSize, cssSize);
      ctx.globalAlpha = 1;
    }
  }

  function updateProgress(now) {
    if (readyAt > 0) {
      target = 1; // ready:冲满
    } else {
      // 模拟推进:先快后慢逼近 92%,等待真实 ready 信号
      var elapsed = now - t0;
      var sim = 0.42 + 0.5 * (1 - Math.exp(-elapsed / 1400));
      target = Math.min(0.92, Math.max(sim, domReadyBoost, loadBoost));
    }
    // display 缓动逼近 target:ready 后加速收敛
    var speed = readyAt > 0 ? 0.16 : 0.07;
    display += (target - display) * speed;
    if (display > 0.995 && readyAt > 0) display = 1;

    var pct = Math.round(clamp01(display) * 100);
    if (barFill) barFill.style.width = pct + '%';
    if (percentEl) percentEl.textContent = pct + '%';
  }

  function finish() {
    if (removed) return;
    removed = true;
    root.classList.add('is-done');
    // transitionend 在异常情况下可能不来,固定超时兜底移除
    setTimeout(function () {
      if (root.parentNode) root.parentNode.removeChild(root);
    }, FADE_OUT_MS + 300);
  }

  function enterAssemble(now) {
    if (assembledAt > 0) return;
    assembledAt = now;
    // CSS:进度区淡出、流光 combo 单词浮现
    root.classList.add('is-assembled');
    // 停留展示后整体淡出;同时保证最短总展示时长
    var fadeAt = Math.max(assembledAt + ASSEMBLE_HOLD_MS, t0 + SPLASH_MIN_MS);
    setTimeout(finish, Math.max(0, fadeAt - performance.now()) + ASSEMBLE_ICON_MS * 0.4);
  }

  function onAppReady() {
    if (readyAt > 0) return; // 幂等:StrictMode 下 useEffect 会触发两次
    readyAt = performance.now();
  }

  // —— 事件接线 ——
  window.addEventListener('combo:app-ready', onAppReady);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      domReadyBoost = Math.max(domReadyBoost, 0.55);
    });
  } else {
    domReadyBoost = 0.55;
  }
  window.addEventListener('load', function () {
    loadBoost = Math.max(loadBoost, 0.8);
  });
  window.addEventListener('resize', resize);

  // ready 信号兜底:JS 异常导致 app-ready 不来时自动收尾
  setTimeout(function () {
    if (readyAt === 0) onAppReady();
  }, READY_TIMEOUT_MS);

  // —— 图标加载 → 初始化 → 主循环 ——
  var img = new Image();
  img.onload = function () {
    iconImg = img;
    resize();
    start();
  };
  img.onerror = function () {
    iconImg = null; // 采样源退化为程序化绘制
    resize();
    start();
  };
  img.src = '/combo-icon.png';

  var started = false;
  function start() {
    if (started) return;
    started = true;
    if (reducedMotion) {
      // 弱动效:跳过飞行,直接进入完成态
      display = 1;
      iconAlpha = 1;
    }
    requestAnimationFrame(function loop(now) {
      if (removed) return; // 淡出后停止绘制
      updateProgress(now);
      if (readyAt > 0 && display > 0.985) enterAssemble(now);
      draw(now);
      requestAnimationFrame(loop);
    });
  }

  // 图标请求超时(极弱网)也照常启动,采样走兜底路径
  setTimeout(function () {
    if (!started) start();
  }, 1500);
})();
