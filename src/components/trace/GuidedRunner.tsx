"use client";

/**
 * The walkthrough, played against the real gate.
 *
 * The fourteen steps come from `src/lib/demo/script.ts` — the same file the CLI
 * walkthrough and the seed data read, so there is one version of the story and
 * it cannot drift. Each step that names an act also names the verdict it claims
 * it will get, which makes the script a test: after a step runs, this shows
 * whether the engine agreed with the narration or contradicted it.
 */

import { useCallback, useState } from "react";

import { DEMO_SCRIPT } from "@/lib/demo/script";
import { useSession, type LifecycleAction } from "@/components/state/session";
import type { SessionView } from "@/app/_shared/view";

const VENDOR: Record<string, string> = {
  foxit: "Foxit",
  doctavian: "Doctavian",
  nutrient: "Nutrient DWS",
  namecom: "name.com",
  serpapi: "SerpApi",
  xano: "Xano",
  none: "Chancery",
};

type Op =
  | { type: "lifecycle"; action: LifecycleAction }
  | { type: "act"; presetId: string }
  | { type: "narrate" };

/**
 * What each step does when it is played. Steps that only narrate still advance,
 * because the sequence is the argument: four steps of useful work happen before
 * anything is refused.
 */
const OPS: Record<string, Op[]> = {
  "D-01": [{ type: "narrate" }],
  "D-02": [{ type: "narrate" }],
  "D-03": [{ type: "lifecycle", action: "draft" }],
  "D-04": [{ type: "lifecycle", action: "sign" }],
  "D-05": [{ type: "narrate" }],
  "D-06": [{ type: "lifecycle", action: "anchor" }],
  "D-07": [{ type: "act", presetId: "reg-coffee" }],
  "D-08": [{ type: "act", presetId: "reg-roasters" }],
  "D-09": [{ type: "act", presetId: "reg-beans" }],
  "D-10": [{ type: "act", presetId: "reg-espresso" }],
  "D-11": [{ type: "act", presetId: "reg-collision" }],
  "D-12": [
    { type: "lifecycle", action: "tamper" },
    { type: "act", presetId: "reg-coffee" },
  ],
  "D-13": [
    { type: "lifecycle", action: "revoke" },
    { type: "act", presetId: "reg-coffee" },
  ],
  "D-14": [{ type: "narrate" }],
};

export function GuidedRunner({ session }: { session: SessionView }) {
  const { lifecycle, runAct, setStep, reset } = useSession();
  const [busy, setBusy] = useState(false);
  const step = session.step;
  const next = step + 1;
  const finished = next >= DEMO_SCRIPT.length;

  const play = useCallback(
    async (index: number) => {
      const entry = DEMO_SCRIPT[index];
      if (entry === undefined) return;
      setBusy(true);
      for (const op of OPS[entry.id] ?? []) {
        if (op.type === "lifecycle") await lifecycle(op.action);
        if (op.type === "act") await runAct(op.presetId);
      }
      await setStep(index);
      setBusy(false);
    },
    [lifecycle, runAct, setStep],
  );

  const playAll = useCallback(async () => {
    setBusy(true);
    for (let index = step + 1; index < DEMO_SCRIPT.length; index += 1) {
      const entry = DEMO_SCRIPT[index];
      for (const op of OPS[entry.id] ?? []) {
        if (op.type === "lifecycle") await lifecycle(op.action);
        if (op.type === "act") await runAct(op.presetId);
      }
      await setStep(index);
    }
    setBusy(false);
  }, [step, lifecycle, runAct, setStep]);

  return (
    <div className="guide">
      <div className="guide__controls">
        <button className="btn btn--sm btn--signal" onClick={() => void play(next)} disabled={busy || finished}>
          {busy ? "Running…" : finished ? "Walkthrough complete" : `Play ${DEMO_SCRIPT[next].id}`}
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => void playAll()} disabled={busy || finished}>
          Play to the end
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => void reset()} disabled={busy}>
          Start over
        </button>
      </div>

      <ol className="guide__steps">
        {DEMO_SCRIPT.map((entry, index) => {
          const played = index <= step;
          const current = index === next;
          const claim = entry.expect;
          const answered = played && claim ? matchFor(session, index) : null;

          return (
            <li
              key={entry.id}
              className="guide__step"
              data-state={played ? "played" : current ? "next" : "waiting"}
            >
              <span className="guide__id">{entry.id}</span>
              <div className="guide__text">
                <p className="guide__narration">{entry.narration}</p>
                <p className="guide__watch">
                  <span className="guide__vendor">{VENDOR[entry.vendor]}</span>
                  {entry.watch}
                </p>
                {claim && (
                  <p className="guide__claim">
                    <span className={`pill ${claim.outcome === "allow" ? "pill--go" : "pill--stop"}`}>
                      {claim.outcome}
                    </span>
                    <span className="pill pill--ghost">{claim.code}</span>
                    {answered !== null && (
                      <span className={`guide__match guide__match--${answered ? "ok" : "off"}`}>
                        {answered
                          ? "the engine agreed"
                          : "the engine answered something else — the narration is wrong, not the verdict"}
                      </span>
                    )}
                  </p>
                )}
                {entry.id === "D-02" && played && <Boundary />}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Did the engine answer what the narration claims? Read off the act log rather
 * than recomputed, so this compares the story against the verdict rather than
 * against a second opinion.
 *
 * Three steps ask for the same registration — the plain one, the one after the
 * document is edited, and the one after revocation — so the act is found by how
 * many earlier steps used that preset, not by taking the most recent match.
 */
function matchFor(session: SessionView, stepIndex: number): boolean | null {
  const entry = DEMO_SCRIPT[stepIndex];
  const op = (OPS[entry?.id ?? ""] ?? []).find((candidate) => candidate.type === "act");
  if (entry?.expect === undefined || op === undefined || op.type !== "act") return null;

  const ordinal = DEMO_SCRIPT.slice(0, stepIndex).filter((earlier) =>
    (OPS[earlier.id] ?? []).some(
      (candidate) => candidate.type === "act" && candidate.presetId === op.presetId,
    ),
  ).length;

  const act = session.acts.filter((candidate) => candidate.presetId === op.presetId)[ordinal];
  if (act === undefined) return null;
  return (
    act.outcome === entry.expect.outcome &&
    act.reasons.some((reason) => reason.code === entry.expect!.code)
  );
}

/**
 * The refusal at step two, transcribed from a real call.
 *
 * This is not illustrative. It is what Foxit's gateway returns to a caller that
 * holds no credential, recorded on 2026-09-03 and reproducible with
 * `pnpm boundary` or the curl in PROOF.md. An invented transcript here would be
 * the one place in the product where a vendor's response was fabricated, which
 * is why it is copied rather than written.
 */
function Boundary() {
  return (
    <pre className="guide__wire mono">
      {`POST https://na1.fusion.foxit.com/esign/api/v1/folders/createfolder
> content-type: application/json
> (no client_id, no client_secret — this process holds neither)

HTTP/1.1 400 Bad Request
{"allow":false,"reason":"Missing credentials: provide both
 'client_id' and 'client_secret' headers."}`}
    </pre>
  );
}
