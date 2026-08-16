import { HeroParticles } from './HeroParticles';

/**
 * 首屏 hero 装饰背景:Combo 白色线框字倾斜横贯首屏 + 粒子聚合流光层。
 * 会话首页(ChatEmptyState)与自动化首页(AutomationPanel)共用。
 *
 * 样式/定位/动画见 index.css `.combo-hero-*`:
 * - 线框字白色描边 + 0.3 透明度,绕中心 −11° 倾斜并轻微浮动;
 * - svg 宽取容器宽(上限 88rem)而非 vw,整词由 textLength 锁定画布 87% 宽,
 *   任何容器宽度下都完整可见、不裁切、不产生横向滚动条;
 * - HeroParticles 粒子按同一姿态采样目标点,飘入聚合构成字形,
 *   品牌色流光周期扫过,以 plus-lighter 加法混合叠在线框字上。
 */
export function HeroBackdrop() {
  return (
    <div
      aria-hidden
      className="combo-hero-bg absolute inset-0 overflow-hidden pointer-events-none [mask-image:linear-gradient(to_bottom,black_0%,black_60%,transparent_96%,transparent_100%)] [mask-repeat:no-repeat] [mask-size:100%_100%]"
    >
      <svg
        aria-hidden
        className="w-full max-w-[88rem]"
        viewBox="0 0 460 190"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* textLength 把整词锁定为 400(viewBox 单位),字体回退变宽/变窄
            也不会溢出画布,跨平台渲染一致 */}
        <text
          x="230"
          y="140"
          textAnchor="middle"
          textLength="400"
          lengthAdjust="spacingAndGlyphs"
          className="combo-hero-word"
        >
          Combo
        </text>
      </svg>
      <HeroParticles />
    </div>
  );
}
