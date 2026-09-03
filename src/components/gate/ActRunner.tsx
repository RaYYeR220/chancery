"use client";

/**
 * Asking the gate for something.
 *
 * The catalogue never says what an act will be answered — the answer comes back
 * from the engine and is printed as it arrives. That matters here more than
 * anywhere: a button labelled "this one gets denied" would be a claim about the
 * gate rather than a use of it.
 */

import { ACT_PRESETS, money } from "@/app/_shared/content";
import { useSession } from "@/components/state/session";
import type { SessionView } from "@/app/_shared/view";

const COMPACT = ["reg-coffee", "reg-roasters", "reg-beans", "reg-espresso"];

export function ActRunner({
  session,
  compact = false,
}: {
  session: SessionView;
  compact?: boolean;
}) {
  const { runAct, pending } = useSession();
  const presets = compact ? ACT_PRESETS.filter((preset) => COMPACT.includes(preset.id)) : ACT_PRESETS;
  const armed = session.stage === "anchored" || session.stage === "revoked";

  return (
    <div className="runner">
      {!armed && (
        <p className="runner__locked">
          The gate answers already, and it answers no: with nothing published in DNS there is no
          authority to check an act against. Publish an instrument to see it answer anything else.
        </p>
      )}
      <ul className="runner__list">
        {presets.map((preset) => {
          const previous = [...session.acts]
            .reverse()
            .find((act) => act.presetId === preset.id);
          return (
            <li key={preset.id}>
              <button
                className="runner__item"
                onClick={() => void runAct(preset.id)}
                disabled={pending !== null}
                data-outcome={previous?.outcome}
              >
                <span className="runner__title">{preset.title}</span>
                <span className="runner__detail">{preset.detail}</span>
                <span className="runner__foot">
                  <span className="runner__price">
                    {money(preset.request.amountMinorUnits ?? 0, preset.request.currency ?? "USD")}
                  </span>
                  {previous ? (
                    <span className={`pill ${previous.outcome === "allow" ? "pill--go" : "pill--stop"}`}>
                      {previous.outcome === "allow" ? "Allowed" : "Denied"}
                    </span>
                  ) : (
                    <span className="runner__ask">
                      {pending === preset.id ? "Asking…" : "Ask the gate"}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
