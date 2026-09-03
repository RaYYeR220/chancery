/**
 * The mark: a ring crossed by a bar, the way an interchange is drawn.
 *
 * The ring is the authority and the bar is the act crossing it, so the mark
 * turns red the moment the instrument is withdrawn — it is a status light, not
 * a logo.
 */

export type RoundelTone = "go" | "stop" | "slate" | "paper";

const RING: Record<RoundelTone, string> = {
  go: "#00843d",
  stop: "#d0021b",
  slate: "#5b6770",
  paper: "#ffffff",
};

export function Roundel({
  size = 34,
  tone = "go",
  bar = "#0b2545",
  label,
}: {
  size?: number;
  tone?: RoundelTone;
  bar?: string;
  label?: string;
}) {
  const width = Math.round(size * 1.26);
  return (
    <svg
      width={width}
      height={size}
      viewBox="0 0 58 46"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <circle cx="29" cy="23" r="17" fill="none" stroke={RING[tone]} strokeWidth="7" />
      <rect x="0" y="18" width="58" height="10" fill={bar} />
      <rect x="0" y="20" width="58" height="6" fill={RING[tone] === "#ffffff" ? "#0b2545" : "#ffffff"} />
    </svg>
  );
}
