import { cx } from "./ui";

/**
 * NEXUS identity: the AI MAVERIX wordmark and "Powered by Digital Nomads" with
 * the Kenyan and American flags. Flags are drawn as vectors because Windows
 * has no flag emoji and would show the letters "KE" / "US" instead.
 */

const frame = "rounded-[2px] shrink-0 shadow-[0_0_0_1px_var(--border-strong)]";

/** Flag of Kenya (3:2). */
export function FlagKE({ height = 12, className }: { height?: number; className?: string }) {
  return (
    <svg viewBox="0 0 30 20" height={height} width={height * 1.5} role="img" aria-label="Flag of Kenya" className={cx(frame, className)}>
      <title>Kenya</title>
      <rect width="30" height="20" fill="#fff" />
      <rect width="30" height="6" fill="#000" />
      <rect y="7" width="30" height="6" fill="#b00" />
      <rect y="14" width="30" height="6" fill="#060" />
      {/* crossed spears */}
      <g stroke="#fff" strokeWidth="0.55" strokeLinecap="round">
        <path d="M9.6 17 20.4 3M20.4 17 9.6 3" />
      </g>
      <g fill="#fff">
        <path d="M20.4 3l-.95 2.1.5.38.55.43z" transform="rotate(8 20.4 3)" />
        <path d="M9.6 3l.95 2.1-.5.38-.55.43z" transform="rotate(-8 9.6 3)" />
      </g>
      {/* Maasai shield */}
      <path d="M15 3.2c4 2.6 4 11 0 13.6-4-2.600-4-11 0-13.600z" fill="#b00" />
      <path d="M15 3.2c-4 2.6-4 11 0 13.6-2.300-3.400-2.300-10.200 0-13.600z" fill="#000" />
      <path d="M15 3.2c4 2.6 4 11 0 13.6 2.300-3.400 2.300-10.200 0-13.600z" fill="#000" />
      <ellipse cx="15" cy="10" rx="0.6" ry="2.3" fill="#fff" />
      <ellipse cx="15" cy="5.700" rx="0.34" ry="0.8" fill="#fff" />
      <ellipse cx="15" cy="14.300" rx="0.34" ry="0.8" fill="#fff" />
    </svg>
  );
}

const STAR = "M0-1 .225-.309 .951-.309 .363 .118 .588 .809 0 .382-.588 .809-.363 .118-.951-.309-.225-.309z";

/** Flag of the United States (19:10): 13 stripes and 50 stars. */
export function FlagUS({ height = 12, className }: { height?: number; className?: string }) {
  const stars: [number, number][] = [];
  for (let row = 0; row < 9; row++) {
    const count = row % 2 === 0 ? 6 : 5;
    for (let i = 0; i < count; i++) stars.push([(row % 2 === 0 ? 0.633 : 1.267) + i * 1.267, 0.538 + row * 0.538]);
  }
  return (
    <svg viewBox="0 0 19 10" height={height} width={height * 1.9} role="img" aria-label="Flag of the United States" className={cx(frame, className)}>
      <title>United States</title>
      <rect width="19" height="10" fill="#b22234" />
      {[1, 3, 5, 7, 9, 11].map((i) => (
        <rect key={i} y={(i * 10) / 13} width="19" height={10 / 13} fill="#fff" />
      ))}
      <rect width="7.6" height={(7 * 10) / 13} fill="#3c3b6e" />
      {stars.map(([x, y]) => (
        <path key={`${x}-${y}`} d={STAR} fill="#fff" transform={`translate(${x} ${y}) scale(0.300)`} />
      ))}
    </svg>
  );
}

export function Flags({ height = 12, className }: { height?: number; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 align-middle", className)}>
      <FlagKE height={height} />
      <FlagUS height={height} />
    </span>
  );
}

/** The AI MAVERIX wordmark: wide-tracked display type in the NEXUS gradient. */
export function AiMaverix({ className }: { className?: string }) {
  return (
    <span className={cx("font-display uppercase whitespace-nowrap tracking-[0.34em]", className)} aria-label="AI Maverix">
      <span className="font-bold text-gradient">AI</span>
      <span className="font-light text-fg-2"> MAVERIX</span>
    </span>
  );
}

export function PoweredBy({ className, flagHeight = 11 }: { className?: string; flagHeight?: number }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap text-muted", className)}>
      <span>
        Powered by <span className="font-medium text-fg-2">Digital Nomads</span>
      </span>
      <Flags height={flagHeight} />
    </span>
  );
}

/** Full identity block for the About section. */
export function BrandBlock() {
  return (
    <div className="flex flex-col items-center gap-2 py-3 text-center">
      <img src="/logo.svg" alt="" className="h-14 w-14" />
      <div className="font-display text-3xl font-semibold tracking-[0.3em] text-gradient pl-[0.3em]">NEXUS</div>
      <AiMaverix className="text-sm pl-[0.34em]" />
      <div className="h-px w-40 bg-gradient-to-r from-transparent via-[var(--border-strong)] to-transparent my-1" />
      <PoweredBy className="text-xs" flagHeight={13} />
      <p className="text-[11px] text-muted">Kenya · United States</p>
    </div>
  );
}
