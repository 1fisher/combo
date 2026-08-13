// Liquid 流体的 Web Worker 渲染端。
// 整个 WebGL2 流体模拟与渲染循环都跑在独立线程,与主线程的 React 渲染
// (SSE 消息流式更新等)完全解耦:主线程再忙也不会抢占这里的定时循环。
// 主线程只负责:指针/尺寸/可见性/偏好事件转发,以及(Chromium 实验特性
// layoutsubtree 可用时)节流到 ~15fps 的内容快照捕获,其余一概不管。

export interface LiquidOptions {
  /** Resolution of the simulation grid. */
  simResolution?: number;
  /** Resolution of the fluid trail texture. */
  dyeResolution?: number;
  /** How much the trail persists each frame (closer to 1 lasts longer). */
  densityDissipation?: number;
  /** How much motion persists each frame (closer to 1 lasts longer). */
  velocityDissipation?: number;
  /** How much pressure carries over between frames. */
  pressure?: number;
  /** Pressure solver iterations. */
  pressureIterations?: number;
  /** Rotational force added back into the flow. */
  curl?: number;
  /** Radius of the pointer splat. */
  radius?: number;
  /** 触发特效所需的最小指针速率(像素/毫秒)。正常移动速度低于该值不产生特效,快速晃动超过该值时激活;激活后在指针停顿前持续喷射。 */
  minVelocity?: number;
  /** Force multiplier applied on pointer movement. */
  force?: number;
  /** Strength of the color tint left by the flow. */
  intensity?: number;
  /** How strongly the flow warps the content. */
  distortion?: number;
  /** How much of the fluid color blends over the content. */
  blend?: number;
  /** Trail color as [r, g, b] in 0-1 range. Ignored when rainbow is on. */
  color?: [number, number, number];
  /** Color the trail from the flow direction instead of a fixed color. */
  rainbow?: boolean;
}

export type LiquidWorkerRequest =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      options: LiquidOptions;
      /** 输出画布像素尺寸(含 dpr)。 */
      width: number;
      height: number;
      /** 输出画布 CSS 尺寸。 */
      cssWidth: number;
      cssHeight: number;
      contentSupported: boolean;
    }
  | {
      type: "pointer";
      pointerId: number;
      /** CSS 像素坐标,相对输出画布左上角。 */
      x: number;
      y: number;
      time: number;
    }
  | {
      type: "pointerLeave";
      pointerId: number;
    }
  | {
      type: "splat";
      x: number;
      y: number;
      dx: number;
      dy: number;
    }
  | {
      type: "resize";
      /** 输出画布像素尺寸(含 dpr)。 */
      width: number;
      height: number;
      /** 输出画布 CSS 尺寸。 */
      cssWidth: number;
      cssHeight: number;
    }
  | {
      type: "content";
      bitmap: ImageBitmap;
    }
  | {
      type: "visibility";
      visible: boolean;
    }
  | {
      type: "motion";
      reduced: boolean;
    }
  | {
      type: "setOptions";
      options: LiquidOptions;
    }
  | {
      type: "destroy";
    };

export type LiquidWorkerResponse = {
  type: "ready";
  ok: boolean;
};

const DEFAULTS: Required<LiquidOptions> = {
  simResolution: 128,
  dyeResolution: 512,
  densityDissipation: 0.96,
  velocityDissipation: 1,
  pressure: 0.8,
  pressureIterations: 4,
  curl: 1.9,
  radius: 0.3,
  minVelocity: 1.5,
  force: 1.1,
  intensity: 2,
  distortion: 0.4,
  blend: 5,
  color: [0.145, 0.239, 0.867],
  rainbow: false,
};

const DT = 1 / 60;

/** 指针停顿超过该时长后,重新进入未激活状态:需要再次加速超过 minVelocity 才会产生特效。 */
const RESTART_MS = 300;

/** 速度平滑系数(指数移动平均),值越大越平滑,避免单帧跳变误触发。 */
const SPEED_SMOOTHING = 0.5;

function srgbToLinear(value: number): number {
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
uniform vec2 texelSize;
void main () {
  vUv = aPos * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_DISPLAY = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uContent;
uniform sampler2D uFluid;
uniform vec3 uColor;
uniform float uDistortion;
uniform float uIntensity;
uniform float uBlend;
uniform float uRainbow;
uniform float uHasContent;
vec3 toLinear (vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 toSrgb (vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main () {
  vec3 fluid = texture(uFluid, vUv).rgb;
  if (uHasContent < 0.5) {
    float mag = length(fluid);
    vec3 tint = uRainbow == 1.0
      ? clamp(fluid / max(mag, 1e-3), 0.0, 1.0)
      : uColor;
    float overlay = (1.0 - exp(-mag * uIntensity * 0.5)) * 0.82;
    outColor = vec4(toSrgb(clamp(tint, 0.0, 1.0)) * overlay, overlay);
    return;
  }
  vec2 uv = vUv - fluid.rg * uDistortion * 0.001;
  vec4 content = texture(uContent, vec2(uv.x, 1.0 - uv.y));
  content.rgb = toLinear(content.rgb);
  vec3 tint = uRainbow == 1.0 ? fluid : uColor * length(fluid);
  vec4 fluidColor = vec4(tint, 1.0);
  vec4 blended = mix(content, fluidColor, uBlend * 0.01 * clamp(length(fluid), 0.0, 1.0));
  vec4 final = mix(blended, vec4(0.0), 1.0 - content.a);
  outColor = vec4(toSrgb(clamp(final.rgb, 0.0, 1.0)), final.a);
}`;

const FRAG_SPLAT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec3 uColor;
uniform vec2 uPoint;
uniform float uRadius;
void main () {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
  vec3 base = texture(uTarget, vUv).xyz;
  outColor = vec4(base + splat, 1.0);
}`;

const FRAG_ADVECT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float uDt;
uniform float uDissipation;
void main () {
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * texelSize;
  outColor = uDissipation * texture(uSource, coord);
  outColor.a = 1.0;
}`;

const FRAG_CLEAR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTexture;
uniform float uValue;
void main () {
  outColor = uValue * texture(uTexture, vUv);
}`;

const FRAG_DIVERGENCE = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; }
  if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; }
  if (vB.y < 0.0) { B = -C.y; }
  float div = 0.5 * (R - L + T - B);
  outColor = vec4(div, 0.0, 0.0, 1.0);
}`;

const FRAG_CURL = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  float vorticity = R - L - T + B;
  outColor = vec4(vorticity, 0.0, 0.0, 1.0);
}`;

const FRAG_VORTICITY = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uCurlStrength;
uniform float uDt;
void main () {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = vec2(abs(T) - abs(B), abs(R) - abs(L)) * 0.5;
  force /= length(force) + 1.0;
  force *= uCurlStrength * C;
  force.y *= -1.0;
  vec2 velocity = texture(uVelocity, vUv).xy;
  outColor = vec4(velocity + force * uDt, 0.0, 1.0);
}`;

const FRAG_PRESSURE = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  outColor = vec4(pressure, 0.0, 0.0, 1.0);
}`;

const FRAG_GRADIENT = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 outColor;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main () {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 velocity = texture(uVelocity, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  outColor = vec4(velocity, 0.0, 1.0);
}`;

interface Target {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

interface DoubleTarget {
  read: Target;
  write: Target;
  swap: () => void;
}

// ---- 渲染状态(模块级,init 后可用) ----

let gl: WebGL2RenderingContext | null = null;
let config: Required<LiquidOptions> = { ...DEFAULTS };

let cssWidth = 1;
let cssHeight = 1;
let texelX = 0;
let texelY = 0;
let contentSupported = false;
let pendingContent: ImageBitmap | null = null;
let contentDirty = false;

let velocity: DoubleTarget | null = null;
let dye: DoubleTarget | null = null;
let divergence: Target | null = null;
let curl: Target | null = null;
let pressure: DoubleTarget | null = null;
let contentTexture: WebGLTexture | null = null;
let quad: WebGLBuffer | null = null;
let vertexShader: WebGLShader | null = null;
const programs: WebGLProgram[] = [];
const shaders: WebGLShader[] = [];
const programInfo = new Map<string, { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation> }>();

const queued: Array<[number, number, number, number]> = [];

let timer: ReturnType<typeof setTimeout> | null = null;
let lastTime = performance.now();
let destroyed = false;
let running = false;
let visible = true;
let reducedMotion = false;
let idleAt = 0;

const pointers = new Map<number, { x: number; y: number; armed: boolean; lastAt: number; speed: number }>();

function post(message: LiquidWorkerResponse) {
  (self as unknown as { postMessage(m: unknown): void }).postMessage(message);
}

function compile(type: number, source: string): WebGLShader {
  const shader = gl!.createShader(type)!;
  gl!.shaderSource(shader, source);
  gl!.compileShader(shader);
  if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
    console.error("Liquid shader error:", gl!.getShaderInfoLog(shader));
  }
  shaders.push(shader);
  return shader;
}

function createProgram(fragSource: string) {
  const program = gl!.createProgram()!;
  gl!.attachShader(program, vertexShader!);
  gl!.attachShader(program, compile(gl!.FRAGMENT_SHADER, fragSource));
  gl!.linkProgram(program);
  programs.push(program);
  const uniforms: Record<string, WebGLUniformLocation> = {};
  const count = gl!.getProgramParameter(program, gl!.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl!.getActiveUniform(program, i)!;
    uniforms[info.name] = gl!.getUniformLocation(program, info.name)!;
  }
  return { program, uniforms };
}

function getProgram(fragSource: string) {
  let info = programInfo.get(fragSource);
  if (!info) {
    info = createProgram(fragSource);
    programInfo.set(fragSource, info);
  }
  return info;
}

function createTarget(
  size: number,
  internalFormat: number,
  format: number,
  filter: number,
): Target {
  const texture = gl!.createTexture()!;
  gl!.bindTexture(gl!.TEXTURE_2D, texture);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, filter);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, filter);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
  gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
  gl!.texImage2D(
    gl!.TEXTURE_2D,
    0,
    internalFormat,
    size,
    size,
    0,
    format,
    gl!.HALF_FLOAT,
    null,
  );
  const fbo = gl!.createFramebuffer()!;
  gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
  gl!.framebufferTexture2D(
    gl!.FRAMEBUFFER,
    gl!.COLOR_ATTACHMENT0,
    gl!.TEXTURE_2D,
    texture,
    0,
  );
  gl!.viewport(0, 0, size, size);
  gl!.clearColor(0, 0, 0, 1);
  gl!.clear(gl!.COLOR_BUFFER_BIT);
  return { fbo, texture, width: size, height: size };
}

function createDoubleTarget(
  size: number,
  internalFormat: number,
  format: number,
  filter: number,
): DoubleTarget {
  let read = createTarget(size, internalFormat, format, filter);
  let write = createTarget(size, internalFormat, format, filter);
  return {
    get read() {
      return read;
    },
    get write() {
      return write;
    },
    swap() {
      const t = read;
      read = write;
      write = t;
    },
  };
}

function releaseAll() {
  if (!gl) return;
  [velocity, dye, pressure].forEach((t) => {
    if (!t) return;
    gl!.deleteFramebuffer(t.read.fbo);
    gl!.deleteTexture(t.read.texture);
    gl!.deleteFramebuffer(t.write.fbo);
    gl!.deleteTexture(t.write.texture);
  });
  [divergence, curl].forEach((t) => {
    if (!t) return;
    gl!.deleteFramebuffer(t.fbo);
    gl!.deleteTexture(t.texture);
  });
  if (contentTexture) gl!.deleteTexture(contentTexture);
  programs.forEach((program) => gl!.deleteProgram(program));
  shaders.forEach((shader) => gl!.deleteShader(shader));
  if (quad) gl!.deleteBuffer(quad);
}

function updateTexelSize() {
  const width = Math.max(cssWidth, 1);
  const height = Math.max(cssHeight, 1);
  texelX = 1 / (config.simResolution * (width / (height + 400)));
  texelY = 1 / config.simResolution;
}

function bindTexture(texture: WebGLTexture, unit: number): number {
  gl!.activeTexture(gl!.TEXTURE0 + unit);
  gl!.bindTexture(gl!.TEXTURE_2D, texture);
  return unit;
}

function blit(target: Target | null) {
  if (target) {
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, target.fbo);
    gl!.viewport(0, 0, target.width, target.height);
  } else {
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, gl!.drawingBufferWidth, gl!.drawingBufferHeight);
  }
  gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
}

function uploadContent() {
  if (!contentSupported || !contentDirty) return;
  if (pendingContent) {
    gl!.bindTexture(gl!.TEXTURE_2D, contentTexture);
    gl!.texImage2D(
      gl!.TEXTURE_2D,
      0,
      gl!.RGBA,
      gl!.RGBA,
      gl!.UNSIGNED_BYTE,
      pendingContent,
    );
    pendingContent.close();
    pendingContent = null;
  }
  contentDirty = false;
}

function applySplat(x: number, y: number, dx: number, dy: number) {
  const aspect = cssWidth / Math.max(cssHeight, 1);
  const radius = config.radius / 100;
  const splat = getProgram(FRAG_SPLAT);

  gl!.useProgram(splat.program);
  gl!.uniform1i(
    splat.uniforms.uTarget,
    bindTexture(velocity!.read.texture, 0),
  );
  gl!.uniform1f(splat.uniforms.uAspect, aspect);
  gl!.uniform2f(splat.uniforms.uPoint, x, y);
  gl!.uniform3f(splat.uniforms.uColor, dx, dy, 10);
  gl!.uniform1f(splat.uniforms.uRadius, radius);
  blit(velocity!.write);
  velocity!.swap();

  gl!.uniform1i(
    splat.uniforms.uTarget,
    bindTexture(dye!.read.texture, 0),
  );
  blit(dye!.write);
  dye!.swap();
}

function step(delta: number) {
  gl!.disable(gl!.BLEND);

  const curlProgram = getProgram(FRAG_CURL);
  gl!.useProgram(curlProgram.program);
  gl!.uniform2f(curlProgram.uniforms.texelSize, texelX, texelY);
  gl!.uniform1i(
    curlProgram.uniforms.uVelocity,
    bindTexture(velocity!.read.texture, 0),
  );
  blit(curl);

  const vorticityProgram = getProgram(FRAG_VORTICITY);
  gl!.useProgram(vorticityProgram.program);
  gl!.uniform2f(vorticityProgram.uniforms.texelSize, texelX, texelY);
  gl!.uniform1i(
    vorticityProgram.uniforms.uVelocity,
    bindTexture(velocity!.read.texture, 0),
  );
  gl!.uniform1i(
    vorticityProgram.uniforms.uCurl,
    bindTexture(curl!.texture, 1),
  );
  gl!.uniform1f(vorticityProgram.uniforms.uCurlStrength, config.curl);
  gl!.uniform1f(vorticityProgram.uniforms.uDt, DT);
  blit(velocity!.write);
  velocity!.swap();

  const divergenceProgram = getProgram(FRAG_DIVERGENCE);
  gl!.useProgram(divergenceProgram.program);
  gl!.uniform2f(divergenceProgram.uniforms.texelSize, texelX, texelY);
  gl!.uniform1i(
    divergenceProgram.uniforms.uVelocity,
    bindTexture(velocity!.read.texture, 0),
  );
  blit(divergence);

  const clearProgram = getProgram(FRAG_CLEAR);
  gl!.useProgram(clearProgram.program);
  gl!.uniform1i(
    clearProgram.uniforms.uTexture,
    bindTexture(pressure!.read.texture, 0),
  );
  gl!.uniform1f(
    clearProgram.uniforms.uValue,
    Math.pow(config.pressure, delta * 60),
  );
  blit(pressure!.write);
  pressure!.swap();

  const pressureProgram = getProgram(FRAG_PRESSURE);
  gl!.useProgram(pressureProgram.program);
  gl!.uniform2f(pressureProgram.uniforms.texelSize, texelX, texelY);
  gl!.uniform1i(
    pressureProgram.uniforms.uDivergence,
    bindTexture(divergence!.texture, 0),
  );
  for (let i = 0; i < config.pressureIterations; i++) {
    gl!.uniform1i(
      pressureProgram.uniforms.uPressure,
      bindTexture(pressure!.read.texture, 1),
    );
    blit(pressure!.write);
    pressure!.swap();
  }

  const gradientProgram = getProgram(FRAG_GRADIENT);
  gl!.useProgram(gradientProgram.program);
  gl!.uniform2f(gradientProgram.uniforms.texelSize, texelX, texelY);
  gl!.uniform1i(
    gradientProgram.uniforms.uPressure,
    bindTexture(pressure!.read.texture, 0),
  );
  gl!.uniform1i(
    gradientProgram.uniforms.uVelocity,
    bindTexture(velocity!.read.texture, 1),
  );
  blit(velocity!.write);
  velocity!.swap();

  const advectProgram = getProgram(FRAG_ADVECT);
  gl!.useProgram(advectProgram.program);
  gl!.uniform2f(advectProgram.uniforms.texelSize, texelX, texelY);
  gl!.uniform1i(
    advectProgram.uniforms.uVelocity,
    bindTexture(velocity!.read.texture, 0),
  );
  gl!.uniform1i(
    advectProgram.uniforms.uSource,
    bindTexture(velocity!.read.texture, 0),
  );
  gl!.uniform1f(advectProgram.uniforms.uDt, DT);
  gl!.uniform1f(
    advectProgram.uniforms.uDissipation,
    Math.pow(config.velocityDissipation, delta * 60),
  );
  blit(velocity!.write);
  velocity!.swap();

  gl!.uniform1i(
    advectProgram.uniforms.uVelocity,
    bindTexture(velocity!.read.texture, 0),
  );
  gl!.uniform1i(
    advectProgram.uniforms.uSource,
    bindTexture(dye!.read.texture, 1),
  );
  gl!.uniform1f(
    advectProgram.uniforms.uDissipation,
    Math.pow(config.densityDissipation, delta * 60),
  );
  blit(dye!.write);
  dye!.swap();
}

function render() {
  uploadContent();
  const display = getProgram(FRAG_DISPLAY);
  gl!.useProgram(display.program);
  gl!.uniform1i(
    display.uniforms.uContent,
    bindTexture(contentTexture!, 0),
  );
  gl!.uniform1i(
    display.uniforms.uFluid,
    bindTexture(dye!.read.texture, 1),
  );
  gl!.uniform3f(
    display.uniforms.uColor,
    srgbToLinear(config.color[0]),
    srgbToLinear(config.color[1]),
    srgbToLinear(config.color[2]),
  );
  gl!.uniform1f(display.uniforms.uDistortion, config.distortion);
  gl!.uniform1f(display.uniforms.uIntensity, config.intensity);
  gl!.uniform1f(display.uniforms.uBlend, config.blend);
  gl!.uniform1f(display.uniforms.uRainbow, config.rainbow ? 1 : 0);
  gl!.uniform1f(display.uniforms.uHasContent, contentSupported ? 1 : 0);
  blit(null);
}

function idleDelayMs() {
  const dissipation = Math.min(config.densityDissipation, 0.999);
  const frames = Math.log(1e-7) / Math.log(dissipation);
  return (frames / 60) * 1000;
}

function schedule() {
  if (destroyed) return;
  timer = setTimeout(() => frame(performance.now()), 16);
}

function frame(now: number) {
  if (destroyed) return;
  if (!visible) {
    running = false;
    return;
  }
  const delta = Math.min((now - lastTime) / 1000, 1 / 30);
  lastTime = now;
  if (queued.length > 0) {
    idleAt = now + idleDelayMs();
    while (queued.length > 0) {
      const [x, y, dx, dy] = queued.pop()!;
      applySplat(x, y, dx, dy);
    }
  }
  step(delta);
  render();
  if (now >= idleAt && !contentDirty) {
    running = false;
    return;
  }
  schedule();
}

function start() {
  if (destroyed || running || !visible || reducedMotion) return;
  running = true;
  lastTime = performance.now();
  schedule();
}

function handlePointer(x: number, y: number, pointerId: number, now: number) {
  if (reducedMotion) return;
  const p = pointers.get(pointerId);
  if (!p) {
    pointers.set(pointerId, { x, y, armed: false, lastAt: now, speed: 0 });
    return;
  }
  const dt = now - p.lastAt;
  if (dt > RESTART_MS) {
    // 停顿后重新进入未激活状态:速度归零,需要再次加速才能激活
    p.armed = false;
    p.speed = 0;
  }
  p.lastAt = now;
  const dist = Math.hypot(x - p.x, y - p.y);
  const instantSpeed = dt > 0 ? dist / dt : 0;
  // 速度平滑(指数移动平均),避免单帧跳变误触发
  p.speed = p.speed * SPEED_SMOOTHING + instantSpeed * (1 - SPEED_SMOOTHING);
  if (!p.armed) {
    // 未激活:速率低于 minVelocity 时不产生特效,加速超过阈值后激活
    if (p.speed < config.minVelocity) {
      p.x = x;
      p.y = y;
      return;
    }
    p.armed = true;
  }
  const dx = (x - p.x) * config.force;
  const dy = -(y - p.y) * config.force;
  queued.push([x / cssWidth, 1 - y / cssHeight, dx, dy]);
  p.x = x;
  p.y = y;
  idleAt = now + idleDelayMs();
  start();
}

function initState(msg: Extract<LiquidWorkerRequest, { type: "init" }>) {
  config = { ...DEFAULTS, ...msg.options };
  cssWidth = Math.max(msg.cssWidth, 1);
  cssHeight = Math.max(msg.cssHeight, 1);
  contentSupported = msg.contentSupported;

  const canvas = msg.canvas;
  canvas.width = Math.max(msg.width, 1);
  canvas.height = Math.max(msg.height, 1);
  gl = canvas.getContext("webgl2", {
    alpha: true,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: true,
  });
  if (!gl || gl.isContextLost()) {
    gl = null;
    post({ type: "ready", ok: false });
    return;
  }

  gl.getExtension("EXT_color_buffer_float");
  const supportsLinear = Boolean(gl.getExtension("OES_texture_float_linear"));
  const filtering = supportsLinear ? gl.LINEAR : gl.NEAREST;

  vertexShader = compile(gl.VERTEX_SHADER, VERT);
  gl.enableVertexAttribArray(0);
  quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  velocity = createDoubleTarget(config.simResolution, gl.RG16F, gl.RG, filtering);
  dye = createDoubleTarget(config.dyeResolution, gl.RGBA16F, gl.RGBA, filtering);
  divergence = createTarget(config.simResolution, gl.R16F, gl.RED, gl.NEAREST);
  curl = createTarget(config.simResolution, gl.R16F, gl.RED, gl.NEAREST);
  pressure = createDoubleTarget(config.simResolution, gl.R16F, gl.RED, gl.NEAREST);

  contentTexture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, contentTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]),
  );

  updateTexelSize();
  post({ type: "ready", ok: true });
  start();
}

function handleResize(msg: Extract<LiquidWorkerRequest, { type: "resize" }>) {
  cssWidth = Math.max(msg.cssWidth, 1);
  cssHeight = Math.max(msg.cssHeight, 1);
  updateTexelSize();
  if (gl && (gl.drawingBufferWidth !== msg.width || gl.drawingBufferHeight !== msg.height)) {
    // 画布像素尺寸由 worker 侧控制(OffscreenCanvas 归 worker 所有)
    const canvas = gl.canvas as OffscreenCanvas;
    canvas.width = Math.max(msg.width, 1);
    canvas.height = Math.max(msg.height, 1);
  }
  start();
}

function handleContent(msg: Extract<LiquidWorkerRequest, { type: "content" }>) {
  if (!contentSupported || destroyed) return;
  pendingContent = msg.bitmap;
  contentDirty = true;
  idleAt = performance.now() + idleDelayMs();
  start();
}

function handleSetOptions(msg: Extract<LiquidWorkerRequest, { type: "setOptions" }>) {
  if (
    !Object.entries(msg.options).some(
      ([key, value]) => config[key as keyof LiquidOptions] !== value,
    )
  )
    return;
  const { simResolution, dyeResolution, ...rest } = msg.options;
  void simResolution;
  void dyeResolution;
  Object.assign(config, rest);
  start();
}

function handleDestroy() {
  destroyed = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  pendingContent?.close();
  pendingContent = null;
  releaseAll();
  programInfo.clear();
  programs.length = 0;
  shaders.length = 0;
  velocity = null;
  dye = null;
  divergence = null;
  curl = null;
  pressure = null;
  contentTexture = null;
  quad = null;
  vertexShader = null;
  gl = null;
}

self.onmessage = (event: MessageEvent<LiquidWorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      initState(msg);
      break;
    case "pointer":
      handlePointer(msg.x, msg.y, msg.pointerId, msg.time);
      break;
    case "pointerLeave":
      pointers.delete(msg.pointerId);
      break;
    case "splat":
      if (!reducedMotion) {
        queued.push([msg.x, msg.y, msg.dx, msg.dy]);
        idleAt = performance.now() + idleDelayMs();
        start();
      }
      break;
    case "resize":
      handleResize(msg);
      break;
    case "content":
      handleContent(msg);
      break;
    case "visibility":
      visible = msg.visible;
      if (visible) start();
      break;
    case "motion":
      reducedMotion = msg.reduced;
      if (!reducedMotion) start();
      break;
    case "setOptions":
      handleSetOptions(msg);
      break;
    case "destroy":
      handleDestroy();
      break;
  }
};

export {};
