"use client";

/**
 * The line an irreversible act travels.
 *
 * Eight stations in the order the gatekeeper applies them, on three service
 * lines. The token rides from the origin and stops dead at the first station it
 * cannot clear; everything past that station goes grey and dashed, because
 * nothing beyond it ran. This is the only animation on the page and it exists
 * because a viewer needs to see *where* a refusal happened, not just read it.
 *
 * The diagram is decorative in the accessibility tree: the ladder underneath
 * carries the same eight stations as real text, and it is what a screen reader
 * and a narrow viewport both get.
 */

import { useEffect, useRef, useState } from "react";

import { LINES } from "@/app/_shared/content";
import type { StationView } from "@/app/_shared/view";

const COLOUR: Record<StationView["line"], string> = {
  authority: "#00843d",
  condition: "#0072ce",
  schedule: "#f5a623",
};

const DARK = "#5b6770";

/** Geometry of the horizontal diagram: two rows joined by one 45-degree elbow. */
const ROW_ONE_Y = 54;
const ROW_TWO_Y = 104;
const POINTS: [number, number][] = [
  [62, ROW_ONE_Y],
  [190, ROW_ONE_Y],
  [318, ROW_ONE_Y],
  [446, ROW_ONE_Y],
  [604, ROW_TWO_Y],
  [726, ROW_TWO_Y],
  [848, ROW_TWO_Y],
  [956, ROW_TWO_Y],
];
/** The elbow itself, inserted into the fourth leg so the drop is a clean 45°. */
const ELBOW: [number, number][] = [
  [506, ROW_ONE_Y],
  [556, ROW_TWO_Y],
];

function legPath(index: number): [number, number][] {
  const from = POINTS[index];
  const to = POINTS[index + 1];
  return index === 3 ? [from, ELBOW[0], ELBOW[1], to] : [from, to];
}

function pointsAttr(points: [number, number][]): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ");
}

/** Distance along the whole polyline, used to walk the token leg by leg. */
function interpolate(all: [number, number][], t: number): [number, number] {
  const spans: number[] = [];
  let total = 0;
  for (let i = 0; i < all.length - 1; i += 1) {
    const dx = all[i + 1][0] - all[i][0];
    const dy = all[i + 1][1] - all[i][1];
    const length = Math.hypot(dx, dy);
    spans.push(length);
    total += length;
  }
  let travelled = t * total;
  for (let i = 0; i < spans.length; i += 1) {
    if (travelled <= spans[i] || i === spans.length - 1) {
      const p = spans[i] === 0 ? 0 : Math.min(1, travelled / spans[i]);
      return [
        all[i][0] + (all[i + 1][0] - all[i][0]) * p,
        all[i][1] + (all[i + 1][1] - all[i][1]) * p,
      ];
    }
    travelled -= spans[i];
  }
  return all[all.length - 1];
}

export interface LineMapProps {
  stations: StationView[];
  /** Changes when a new act is put on the line, which restarts the token. */
  runKey: string | null;
  /** Index of the station the act stopped at, or null when the line is idle. */
  stopIndex: number | null;
  outcome: "allow" | "deny" | null;
}

export function LineMap({ stations, runKey, stopIndex, outcome }: LineMapProps) {
  const [reached, setReached] = useState<number>(stopIndex ?? -1);
  const [token, setToken] = useState<[number, number] | null>(null);
  const frame = useRef<number>(0);

  useEffect(() => {
    if (runKey === null || stopIndex === null) {
      setReached(-1);
      setToken(null);
      return;
    }

    const path: [number, number][] = [];
    for (let i = 0; i < stopIndex; i += 1) path.push(...legPath(i));
    path.unshift(POINTS[0]);
    if (path.length < 2) {
      setReached(stopIndex);
      setToken(POINTS[stopIndex]);
      return;
    }

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setReached(stopIndex);
      setToken(POINTS[stopIndex]);
      return;
    }

    const duration = 260 + stopIndex * 150;
    const startedAt = performance.now();
    setReached(0);

    const step = () => {
      const t = Math.min(1, (performance.now() - startedAt) / duration);
      setToken(interpolate(path, t));
      setReached(Math.min(stopIndex, Math.floor(t * stopIndex + 0.0001)));
      if (t < 1) {
        frame.current = requestAnimationFrame(step);
        return;
      }
      setReached(stopIndex);
      setToken(POINTS[stopIndex]);
    };

    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [runKey, stopIndex]);

  const tokenColour = outcome === "deny" ? "#d0021b" : "#ffffff";

  return (
    <div className="linemap">
      <svg
        className="linemap__svg"
        viewBox="0 0 1010 166"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        focusable="false"
      >
        {stations.slice(0, -1).map((station, index) => {
          const next = stations[index + 1];
          const spent = stopIndex !== null && index >= stopIndex;
          const dead = next.state === "dark" || next.state === "skipped" || spent;
          return (
            <polyline
              key={station.id}
              points={pointsAttr(legPath(index))}
              fill="none"
              stroke={dead ? DARK : COLOUR[next.line]}
              strokeWidth={12}
              strokeDasharray={dead ? "16 11" : undefined}
              strokeLinejoin="miter"
            />
          );
        })}

        {stations.map((station, index) => {
          const [x, y] = POINTS[index];
          const above = y === ROW_ONE_Y;
          const running = runKey !== null && stopIndex !== null;
          const state =
            running && index > reached && index !== stopIndex ? "idle" : station.state;
          const fill =
            state === "failed"
              ? "#d0021b"
              : state === "cleared"
                ? "#00843d"
                : state === "dark" || state === "skipped"
                  ? "#0b2545"
                  : "#ffffff";
          const stroke =
            state === "dark" || state === "skipped" ? DARK : state === "idle" ? COLOUR[station.line] : "#ffffff";
          const dim = state === "dark" || state === "skipped";

          return (
            <g key={station.id} opacity={dim ? 0.55 : 1}>
              {station.id === "commit" ? (
                <rect x={x - 13} y={y - 15} width={26} height={30} fill={fill} stroke={stroke} strokeWidth={5} />
              ) : (
                <circle cx={x} cy={y} r={12} fill={fill} stroke={stroke} strokeWidth={5} />
              )}
              <text
                x={x}
                y={above ? y - 28 : y + 36}
                textAnchor="middle"
                fill="#ffffff"
                fontSize="15"
                fontWeight="700"
              >
                {station.short}
              </text>
              <text
                x={x}
                y={above ? y - 13 : y + 51}
                textAnchor="middle"
                fill="#ffffff"
                fontSize="12"
                opacity="0.66"
              >
                cl. {station.clause}
              </text>
            </g>
          );
        })}

        {token !== null && (
          <circle
            cx={token[0]}
            cy={token[1]}
            r={9}
            fill={tokenColour}
            stroke="#0b2545"
            strokeWidth={3}
          />
        )}
      </svg>

      <ul className="linekey">
        {LINES.map((line) => (
          <li key={line.id}>
            <i style={{ background: line.colour }} />
            {line.label}
          </li>
        ))}
        <li>
          <i style={{ background: DARK }} />
          No service
        </li>
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- the ladder */

const MARK: Record<StationView["state"], string> = {
  cleared: "✓",
  failed: "✕",
  skipped: "–",
  idle: "·",
  dark: "·",
};

/**
 * The same eight stations as text. This is the accessible representation of the
 * diagram and, below 900px, the only one — which is why it carries the note
 * saying what each station actually compared rather than repeating the diagram.
 */
export function CheckLadder({ stations }: { stations: StationView[] }) {
  return (
    <ol className="ladder">
      {stations.map((station, index) => (
        <li key={station.id} className="ladder__row" data-state={station.state} data-line={station.line}>
          <span className="ladder__spine" aria-hidden="true" />
          <span className="ladder__mark">{MARK[station.state]}</span>
          <span className="ladder__name">
            {station.name}
            <span className="ladder__clause">clause {station.clause}</span>
          </span>
          <span className="ladder__note">
            {station.note.length > 0 ? station.note : station.tests}
          </span>
          <span className="sr">
            {station.state === "cleared"
              ? "cleared"
              : station.state === "failed"
                ? "refused here"
                : station.state === "skipped"
                  ? "not reached"
                  : station.state === "dark"
                    ? "no service"
                    : `station ${index + 1}`}
          </span>
        </li>
      ))}
    </ol>
  );
}
