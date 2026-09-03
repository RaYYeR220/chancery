"use client";

/**
 * The limits, as gauges rather than as sentences.
 *
 * Each row is one term of clause 3(b) with its live reading beside it. When an
 * act is on the line the gauge it was measured against shows what that act did
 * to it: the sum it added, or — when it was refused — the overrun past the
 * terminus, drawn beyond the buffer stop so the refusal has a shape and not
 * just a number.
 */

import { money } from "@/app/_shared/content";
import type { ActView, GaugeView } from "@/app/_shared/view";

/** The permitted range occupies this much of the track; the rest is the buffer. */
const TERMINUS = 84;

export function LimitBoard({
  gauges,
  act,
  title = "Limits in force",
}: {
  gauges: GaugeView[];
  act: ActView | null;
  title?: string;
}) {
  if (gauges.length === 0) {
    return (
      <div className="limits limits--empty">
        <p>
          No limits are in force, because no instrument has been signed. Every irreversible act is
          refused by default rather than by a limit.
        </p>
      </div>
    );
  }

  const code = act?.reasons[0]?.code;

  return (
    <div className="limits">
      <h3 className="limits__title">{title}</h3>
      {gauges.map((gauge) => (
        <Gauge
          key={gauge.id}
          gauge={gauge}
          act={act}
          breached={
            (gauge.kind === "count" && code === "COUNT_LIMIT_EXCEEDED") ||
            (gauge.kind === "amount" && code === "AMOUNT_LIMIT_EXCEEDED") ||
            (gauge.kind === "allowlist" && code === "VALUE_NOT_ALLOWLISTED") ||
            (gauge.kind === "pattern" && code === "VALUE_PATTERN_MISMATCH") ||
            (gauge.kind === "condition" &&
              (code === "DILIGENCE_FLAGGED" || code === "DILIGENCE_UNKNOWN"))
          }
        />
      ))}
    </div>
  );
}

function Gauge({
  gauge,
  act,
  breached,
}: {
  gauge: GaugeView;
  act: ActView | null;
  breached: boolean;
}) {
  return (
    <div className="gauge" data-breached={breached ? "1" : undefined}>
      <div className="gauge__head">
        <span className="gauge__label">{gauge.label}</span>
        <span className="gauge__clause">cl. {gauge.clause}</span>
      </div>
      <GaugeBody gauge={gauge} act={act} breached={breached} />
    </div>
  );
}

function GaugeBody({
  gauge,
  act,
  breached,
}: {
  gauge: GaugeView;
  act: ActView | null;
  breached: boolean;
}) {
  if (gauge.kind === "count" && gauge.max !== null && gauge.used !== null) {
    const cells = Array.from({ length: gauge.max }, (_, index) => index < gauge.used!);
    return (
      <>
        <div className="segbar" role="img" aria-label={gauge.reading}>
          {cells.map((filled, index) => (
            <i key={index} data-filled={filled ? "1" : undefined} />
          ))}
          {breached && <i data-over="1" />}
        </div>
        <p className="gauge__read">
          {gauge.reading}
          {breached && <span className="gauge__over"> — this act would be number {gauge.used + 1}</span>}
        </p>
      </>
    );
  }

  if (gauge.kind === "amount" && gauge.max !== null && gauge.used !== null) {
    const currency = gauge.currency ?? "USD";
    const pending = act?.amountMinorUnits ?? 0;
    const wouldBe = gauge.used + (breached ? pending : 0);
    const fill = Math.min(TERMINUS, (gauge.used / gauge.max) * TERMINUS);
    const overrun = breached
      ? Math.min(100 - TERMINUS, ((wouldBe - gauge.max) / gauge.max) * TERMINUS)
      : 0;

    return (
      <>
        <div className="track" role="img" aria-label={gauge.reading}>
          <span className="track__bed" style={{ width: `${TERMINUS}%` }} />
          <span className="track__fill" style={{ width: `${fill}%` }} />
          {breached && (
            <span className="track__over" style={{ left: `${TERMINUS}%`, width: `${overrun}%` }} />
          )}
          <span className="track__terminus" style={{ left: `${TERMINUS}%` }} />
          {[0.25, 0.5, 0.75].map((at) => (
            <span key={at} className="track__tick" style={{ left: `${at * TERMINUS}%` }} />
          ))}
          <span
            className="track__token"
            data-over={breached ? "1" : undefined}
            style={{ left: `${breached ? TERMINUS + overrun : fill}%` }}
          />
        </div>
        <p className="gauge__read">
          {gauge.reading}
          {breached && (
            <span className="gauge__over">
              {" "}
              — this act adds {money(pending, currency)} and runs {money(wouldBe - gauge.max, currency)}{" "}
              past the terminus
            </span>
          )}
        </p>
      </>
    );
  }

  if (gauge.kind === "allowlist" && gauge.values !== null) {
    const requested = act === null ? null : String(act.fields.tld ?? "");
    return (
      <>
        <div className="chips">
          {gauge.values.map((value) => (
            <span key={value} className="chip" data-hit={requested === value ? "1" : undefined}>
              .{value}
            </span>
          ))}
          {requested !== null && requested.length > 0 && !gauge.values.includes(requested) && (
            <span className="chip chip--miss">.{requested}</span>
          )}
        </div>
        <p className="gauge__read">
          {gauge.reading}
          {breached && <span className="gauge__over"> — the schedule is exhaustive</span>}
        </p>
      </>
    );
  }

  if (gauge.kind === "pattern" && gauge.values !== null) {
    const tested = act === null ? null : String(act.fields.domainName ?? "");
    return (
      <>
        <p className="gauge__pattern mono">{gauge.values[0]}</p>
        {tested !== null && tested.length > 0 && (
          <p className="gauge__tested mono" data-miss={breached ? "1" : undefined}>
            {tested}
          </p>
        )}
        <p className="gauge__read">{gauge.reading}</p>
      </>
    );
  }

  const finding = act?.diligence[0];
  return (
    <>
      <p className="gauge__read">
        {finding === undefined ? (
          gauge.reading
        ) : (
          <>
            <span className={`pill ${finding.verdict === "clear" ? "pill--go" : "pill--stop"}`}>
              {finding.verdict}
            </span>{" "}
            {finding.summary}
          </>
        )}
      </p>
    </>
  );
}
