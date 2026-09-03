"use client";

/**
 * Withdrawing authority.
 *
 * Two deliberate obstacles, both borrowed from the thing this is modelled on: a
 * cover that has to be lifted, and a handle that has to be held. Neither is
 * theatre. Revocation is the one control on this console that cannot be undone
 * from this console, and a control like that should be hard to operate by
 * accident and impossible to operate by a stray click.
 *
 * Releasing early aborts. Reduced motion drops the sweep, not the three
 * seconds — the wait is the point, the animation is not.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useSession } from "@/components/state/session";
import type { SessionView } from "@/app/_shared/view";

const HOLD_MS = 3000;

export function EmergencyStop({ session }: { session: SessionView }) {
  const { lifecycle, pending } = useSession();
  const [lifted, setLifted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Cover closed. The handle cannot be reached.");
  const holding = useRef(false);
  const frame = useRef(0);
  const startedAt = useRef(0);

  const revoked = session.stage === "revoked";
  const armed = session.stage === "anchored";

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const finish = useCallback(() => {
    holding.current = false;
    cancelAnimationFrame(frame.current);
    setProgress(1);
    setStatus("Withdrawing — publishing a tombstone at the agent’s name.");
    void lifecycle("revoke");
  }, [lifecycle]);

  const tick = useCallback(() => {
    const elapsed = performance.now() - startedAt.current;
    const value = Math.min(1, elapsed / HOLD_MS);
    setProgress(value);
    const left = Math.ceil((HOLD_MS - elapsed) / 1000);
    setStatus(`Holding — ${Math.max(1, left)} to go. Release to abort.`);
    if (value >= 1) {
      finish();
      return;
    }
    frame.current = requestAnimationFrame(tick);
  }, [finish]);

  const beginHold = useCallback(() => {
    if (!lifted || revoked || holding.current) return;
    holding.current = true;
    startedAt.current = performance.now();
    frame.current = requestAnimationFrame(tick);
  }, [lifted, revoked, tick]);

  const cancelHold = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    cancelAnimationFrame(frame.current);
    setProgress(0);
    setStatus("Released early, so nothing happened. Hold the full three seconds.");
  }, []);

  if (revoked) {
    return (
      <div className="estop estop--done">
        <p className="estop__done">Authority withdrawn</p>
        <dl className="kv">
          <dt>At</dt>
          <dd>{new Date(session.now).toISOString().replace("T", " ").slice(0, 19)} UTC</dd>
          <dt>Name</dt>
          <dd className="mono">{session.recordName}</dd>
          <dt>Published</dt>
          <dd className="mono">
            {session.record?.txtRecords.find((value) => value.includes("st=revoked")) ??
              "tombstone published"}
          </dd>
        </dl>
        <p className="estop__note">
          A tombstone rather than a deletion: a resolver still serving the old answer cannot omit a
          record that is there. Withdrawal reaches forward only, so the registrations already made
          stand in the principal&rsquo;s name.
        </p>
      </div>
    );
  }

  return (
    <div className="estop">
      <p className="estop__note">
        Publishes a revocation at <span className="mono">{session.recordName}</span>. Every act after
        the next resolution is refused. This cannot be undone from this console.
      </p>

      {!lifted ? (
        <button
          className="estop__cover hazard"
          onClick={() => {
            if (!armed) return;
            setLifted(true);
            setStatus("Cover lifted. Press and hold the handle for three seconds.");
          }}
          disabled={!armed}
        >
          <span>{armed ? "Break glass — lift the cover" : "Nothing published to withdraw"}</span>
        </button>
      ) : (
        <button
          className="estop__handle"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            beginHold();
          }}
          onPointerUp={cancelHold}
          onPointerCancel={cancelHold}
          onPointerLeave={cancelHold}
          onKeyDown={(event) => {
            if ((event.key === " " || event.key === "Enter") && !event.repeat) {
              event.preventDefault();
              beginHold();
            }
          }}
          onKeyUp={cancelHold}
          onBlur={cancelHold}
          disabled={pending !== null}
          aria-describedby="estop-status"
        >
          <span className="estop__sweep" style={{ width: `${progress * 100}%` }} aria-hidden="true" />
          <span className="estop__label">Hold to withdraw authority</span>
        </button>
      )}

      <p className="estop__status" id="estop-status" role="status">
        {status}
      </p>
    </div>
  );
}
