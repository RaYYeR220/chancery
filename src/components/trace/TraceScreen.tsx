"use client";

/**
 * The agent trace.
 *
 * Two halves, separated by a rule that is drawn as heavily as it deserves.
 * Above it, everything the agent does without asking anyone. Below it, every
 * act that cannot be undone — each one carrying its verdict inline, because a
 * refusal is part of the trace rather than an interruption of it.
 */

import { ACT_PRESETS, REVERSIBLE_CALLS, STATIONS, money, standingStations } from "@/app/_shared/content";
import { CheckLadder, LineMap } from "@/components/line/LineMap";
import { ActRunner } from "@/components/gate/ActRunner";
import { LimitBoard, MeterStrip } from "@/components/gate/LimitBoard";
import { SuspensionBar, VerdictPanel } from "@/components/gate/Verdict";
import { useSelectedAct, useSession } from "@/components/state/session";

import { GuidedRunner } from "./GuidedRunner";

/** The four refusals the walkthrough turns on, named by the code they produce. */
const FLAVOURS: { code: string; label: string; presetId: string; note: string }[] = [
  {
    code: "COUNT_LIMIT_EXCEEDED",
    label: "Over a cap",
    presetId: "reg-espresso",
    note: "Nothing went wrong. The principal wrote three.",
  },
  {
    code: "VALUE_NOT_ALLOWLISTED",
    label: "Outside the schedule",
    presetId: "reg-trade-io",
    note: "Well-formed name, budget with room, unlisted suffix. Ask before the third registration, or the count answers first.",
  },
  {
    code: "DILIGENCE_FLAGGED",
    label: "The world said no",
    presetId: "reg-collision",
    note: "Scope allowed it; a live register entry did not.",
  },
  {
    code: "DOCUMENT_HASH_MISMATCH",
    label: "The document changed",
    presetId: "reg-coffee",
    note: "Edit the signed copy first, then ask again.",
  },
];

export function TraceScreen() {
  const { session, loading, error, selectedActId, select, lifecycle, pending } = useSession();
  const act = useSelectedAct();

  if (loading || session === null) {
    return (
      <div className="band">
        <div className="wrap">
          <p className="band__note">{error ?? "Opening the session…"}</p>
        </div>
      </div>
    );
  }

  const stations = act?.stations ?? standingStations(session.stage);
  const stopIndex = act === null ? null : STATIONS.findIndex((station) => station.id === act.stopAt);
  const tampered = session.document !== null && !session.document.agrees;

  return (
    <>
      <section className="band band--ink">
        <div className="wrap">
          <div className="band__head">
            <div>
              <h1 className="band__title">The agent, watched</h1>
              <p className="band__note">
                {session.agentDomain} runs whatever it likes until it reaches something it cannot
                undo. Then it asks, and the answer is a verdict citing a clause in a document a human
                signed.
              </p>
            </div>
            <MeterStrip gauges={session.gauges} act={act} />
          </div>

          <div className="rig rig--ink">
            <div>
              <LineMap
                stations={stations}
                runKey={act?.id ?? null}
                stopIndex={stopIndex === -1 ? null : stopIndex}
                outcome={act?.outcome ?? null}
              />
              <CheckLadder stations={stations} />
            </div>
            <VerdictPanel act={act} session={session} />
          </div>
        </div>
      </section>

      <SuspensionBar act={act} stage={session.stage} />

      {error !== null && (
        <div className="alert" role="alert">
          <div className="wrap">{error}</div>
        </div>
      )}

      <section className="band">
        <div className="wrap">
          <div className="rig">
            <div className="stack">
              <div className="band__head">
                <div>
                  <h2 className="band__title">The stream</h2>
                  <p className="band__note">
                    The boundary is drawn at irreversibility, not at tool category. An agent may ask
                    for anything; what it gets back is a verdict rather than a missing capability.
                  </p>
                </div>
              </div>

              <ul className="stream">
                {REVERSIBLE_CALLS.map((call) => (
                  <li key={call.id} className="stream__row stream__row--free">
                    <span className="stream__tool mono">{call.tool}</span>
                    <span className="stream__target">{call.target}</span>
                    <span className="stream__note">{call.reason}</span>
                    <span className="pill pill--info">No gate</span>
                  </li>
                ))}
              </ul>

              <p className="boundary">
                <span className="boundary__rule hazard" aria-hidden="true" />
                <span className="boundary__word">Irreversibility</span>
              </p>

              {session.acts.length === 0 ? (
                <p className="board__empty">
                  Nothing irreversible has been attempted yet. Play the walkthrough, or ask for one
                  of the acts below.
                </p>
              ) : (
                <ul className="stream">
                  {[...session.acts].reverse().map((entry) => {
                    const reason = entry.reasons[0];
                    return (
                      <li
                        key={entry.id}
                        className="stream__row stream__row--gated"
                        data-outcome={entry.outcome}
                        data-sel={selectedActId === entry.id ? "1" : undefined}
                      >
                        <button className="stream__pick" onClick={() => select(entry.id)}>
                          <span className="stream__head">
                            <span className="stream__tool mono">{entry.kind}</span>
                            <span className="stream__target">{String(entry.fields.domainName ?? "")}</span>
                            <span className="stream__price">
                              {entry.amountMinorUnits === null
                                ? ""
                                : money(entry.amountMinorUnits, entry.currency ?? "USD")}
                            </span>
                            <span className={`pill ${entry.outcome === "allow" ? "pill--go" : "pill--stop"}`}>
                              {entry.outcome === "allow" ? "Allow" : "Deny"}
                            </span>
                          </span>
                          <span className="stream__verdict">{reason?.message}</span>
                          <span className="stream__cite">
                            {reason?.clauseRef !== undefined && `clause ${reason.clauseRef}`}
                            {reason?.pageNumber !== undefined && `, page ${reason.pageNumber}`}
                            {reason?.clauseRef !== undefined && " · "}
                            {reason?.code}
                            {entry.executed !== null && ` · order ${entry.executed.reference}`}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="stack">
              <div className="slab">
                <div className="slab__cap slab__cap--go">
                  <span>Guided walkthrough</span>
                  <span>14 steps</span>
                </div>
                <div className="slab__body">
                  <GuidedRunner session={session} />
                </div>
              </div>

              <div className="slab">
                <div className="slab__cap">
                  <span>Limits</span>
                  <span>clause 3(b)</span>
                </div>
                <div className="slab__body">
                  <LimitBoard gauges={session.gauges} act={act} title="" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="band band--flat">
        <div className="wrap">
          <div className="band__head">
            <div>
              <h2 className="band__title">Four ways to be refused</h2>
              <p className="band__note">
                Each of these produces a different denial code from the same clause. The button asks;
                the engine answers; nothing here predicts the answer.
              </p>
            </div>
          </div>

          <ul className="flavours">
            {FLAVOURS.map((flavour) => {
              const preset = ACT_PRESETS.find((item) => item.id === flavour.presetId);
              const seen = [...session.acts]
                .reverse()
                .find((entry) => entry.reasons.some((reason) => reason.code === flavour.code));
              return (
                <li key={flavour.code} className="flavour" data-seen={seen ? "1" : undefined}>
                  <span className="flavour__code mono">{flavour.code}</span>
                  <span className="flavour__label">{flavour.label}</span>
                  <p className="flavour__note">{flavour.note}</p>
                  <p className="flavour__act">{preset?.title}</p>
                  {seen ? (
                    <button className="btn btn--sm btn--ghost" onClick={() => select(seen.id)}>
                      Show this refusal
                    </button>
                  ) : flavour.code === "DOCUMENT_HASH_MISMATCH" && !tampered ? (
                    <button
                      className="btn btn--sm"
                      onClick={() => void lifecycle("tamper")}
                      disabled={pending !== null || session.stage !== "anchored"}
                    >
                      Edit one byte of the writ
                    </button>
                  ) : (
                    <span className="flavour__hint">Ask for it below.</span>
                  )}
                </li>
              );
            })}
          </ul>

          {tampered && session.document !== null && (
            <div className="slab tamperbar">
              <div className="slab__cap slab__cap--stop">
                <span>The signed copy has been edited</span>
                <span>clause 5</span>
              </div>
              <div className="slab__body">
                <p>
                  The document served at {session.document.url} no longer hashes to the value DNS
                  publishes, so every act under this instrument stops at the instrument check.
                </p>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => void lifecycle("restore")}
                  disabled={pending !== null}
                >
                  Put the signed copy back
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="band">
        <div className="wrap">
          <div className="band__head">
            <div>
              <h2 className="band__title">Ask for anything</h2>
              <p className="band__note">
                Eight acts against the same instrument. A refusal costs nothing and consumes no
                budget, which is why the fourth registration can be attempted at all.
              </p>
            </div>
          </div>
          <ActRunner session={session} />
        </div>
      </section>
    </>
  );
}
