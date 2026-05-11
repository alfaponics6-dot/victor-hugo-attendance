// Inline SVG flags for the 4 supported locales. We render SVG (not emoji)
// because Windows + Chrome doesn't ship flag-emoji glyphs and falls back to
// the regional-indicator letters (e.g. "🇪🇸" → "ES").
//
// Each flag is sized via a wrapping <span> with rounded corners + a hairline
// border so it reads as a chip rather than a raw rectangle. The internal SVG
// uses viewBox="0 0 3 2" (standard 3:2 flag aspect) so it scales cleanly.

const Frame = ({ children, className = '' }) => (
  <span
    aria-hidden
    className={
      'inline-block overflow-hidden rounded-[3px] ring-1 ring-white/15 align-[-2px] leading-none w-[1.25em] h-[0.85em] ' +
      className
    }
  >
    {children}
  </span>
);

const ES = (props) => (
  <Frame {...props}>
    <svg viewBox="0 0 3 2" width="100%" height="100%" preserveAspectRatio="none">
      <rect width="3" height="2" fill="#AA151B" />
      <rect y="0.5" width="3" height="1" fill="#F1BF00" />
    </svg>
  </Frame>
);

const US = (props) => (
  <Frame {...props}>
    <svg viewBox="0 0 7410 3900" width="100%" height="100%" preserveAspectRatio="none">
      <rect width="7410" height="3900" fill="#B22234" />
      <g fill="#FFFFFF">
        <rect y="300" width="7410" height="300" />
        <rect y="900" width="7410" height="300" />
        <rect y="1500" width="7410" height="300" />
        <rect y="2100" width="7410" height="300" />
        <rect y="2700" width="7410" height="300" />
        <rect y="3300" width="7410" height="300" />
      </g>
      <rect width="2964" height="2100" fill="#3C3B6E" />
    </svg>
  </Frame>
);

const FR = (props) => (
  <Frame {...props}>
    <svg viewBox="0 0 3 2" width="100%" height="100%" preserveAspectRatio="none">
      <rect width="1" height="2" x="0" fill="#0055A4" />
      <rect width="1" height="2" x="1" fill="#FFFFFF" />
      <rect width="1" height="2" x="2" fill="#EF4135" />
    </svg>
  </Frame>
);

const BR = (props) => (
  <Frame {...props}>
    <svg viewBox="0 0 14 10" width="100%" height="100%" preserveAspectRatio="none">
      <rect width="14" height="10" fill="#009C3B" />
      <polygon points="7,1.2 12.8,5 7,8.8 1.2,5" fill="#FFDF00" />
      <circle cx="7" cy="5" r="1.8" fill="#002776" />
    </svg>
  </Frame>
);

const MAP = { es: ES, en: US, fr: FR, pt: BR };

const Flag = ({ code, className }) => {
  const Comp = MAP[code];
  return Comp ? <Comp className={className} /> : null;
};

export default Flag;
