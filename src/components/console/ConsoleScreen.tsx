"use client";

/**
 * The principal's console.
 *
 * Reading order is the order the questions get asked: what is in force, how do
 * I grant it, what does it say, how much of it is left, and how do I take it
 * back. The line at the top is the only thing that moves, and it moves because
 * an act was asked for.
 */

import { STATIONS, standingStations } from "@/app/_shared/content";
import { CheckLadder, LineMap } from "@/components/line/LineMap";
import { ActRunner } from "@/components/gate/ActRunner";
import { LimitBoard } from "@/components/gate/LimitBoard";
import { SuspensionBar, VerdictPanel } from "@/components/gate/Verdict";
import { ServiceBoard } from "@/components/signage/ServiceBoard";
import { useSelectedAct, useSession } from "@/components/state/session";

import { ActBoard } from "./ActBoard";
import { ClauseTable } from "./ClauseTable";
import { EmergencyStop } from "./EmergencyStop";
import { IssueLine } from "./IssueLine";

export function ConsoleScreen() {
  const { session, loading, error, reset, pending } = useSession();
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
  const stopIndex =
    act === null ? null : STATIONS.findIndex((station) => station.id === act.stopAt);

  return (
    <>
      <section className="band band--ink">
        <div className="wrap">
          <div className="band__head">
            <div>
              <h1 className="band__title">Every irreversible act travels this line</h1>
              <p className="band__note">
                An act boards at the published record and must call at each station before it may
                commit. A station it cannot clear suspends the service there, and nothing beyond it
                runs.
              </p>
            </div>
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
          <div className="band__head">
            <h2 className="band__title">Granting authority</h2>
            <p className="band__note">
              An AI can draft the instrument. Only a human can commit to it, and the credential that
              would let one be signed is never held by agent-facing code.
            </p>
          </div>
          <IssueLine session={session} />
        </div>
      </section>

      {session.writ !== null && (
        <section className="band">
          <div className="wrap">
            <div className="band__head">
              <div>
                <h2 className="band__title">Conditions of carriage</h2>
                <p className="band__note">
                  Instrument {session.writ.id}, executed under {session.writ.jurisdiction === "IE" ? "Irish" : session.writ.jurisdiction} law.
                  This is the whole of the authority; nothing outside it runs.
                </p>
              </div>
            </div>

            <div className="rig">
              <ClauseTable writ={session.writ} act={act} />
              <div className="stack">
                <div className="slab">
                  <div className="slab__cap">
                    <span>Limits</span>
                    <span>clause 3(b)</span>
                  </div>
                  <div className="slab__body">
                    <LimitBoard gauges={session.gauges} act={act} title="" />
                  </div>
                </div>

                <div className="slab">
                  <div className="slab__cap slab__cap--stop">
                    <span>Emergency stop</span>
                    <span>clause 5</span>
                  </div>
                  <div className="slab__body">
                    <EmergencyStop session={session} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="band">
        <div className="wrap">
          <div className="band__head">
            <div>
              <h2 className="band__title">What the agent asked for</h2>
              <p className="band__note">
                Select a row to put that act back on the line. Reversible work is not listed here
                because none of it needed authority; it is on the agent trace.
              </p>
            </div>
          </div>

          <div className="rig">
            <ActBoard acts={session.acts} />
            <div className="slab">
              <div className="slab__cap">
                <span>Ask for an act</span>
                <span>{session.agentDomain}</span>
              </div>
              <div className="slab__body">
                <ActRunner session={session} compact />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="band band--flat">
        <div className="wrap">
          <div className="band__head">
            <div>
              <h2 className="band__title">Service status</h2>
              <p className="band__note">
                Chain head <span className="mono">{session.chainHead.slice(0, 24)}…</span> over{" "}
                {session.ledger.length} ledger entries.
              </p>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={() => void reset()} disabled={pending !== null}>
              {pending === "reset" ? "Clearing…" : "Clear this session"}
            </button>
          </div>
          <ServiceBoard mode={session.mode} />
        </div>
      </section>
    </>
  );
}
