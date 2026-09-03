"use client";

/**
 * The public verifier.
 *
 * No account, no key, no privileged read: an agent's authority is published in
 * DNS or it does not exist. Any real name here is a live DNS-over-HTTPS query,
 * and the answer prints the raw TXT strings before anything is parsed, because
 * a verifier that shows only its own reading of a record is asking to be
 * trusted rather than checked.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ReplayView, SessionView, VerifierAnswer } from "@/app/_shared/view";
import { useSession } from "@/components/state/session";

const SUGGESTIONS = [
  { name: "ops.northwind.example", note: "the demo agent, served by this deployment" },
  { name: "cloudflare.com", note: "a real name with no writ published" },
  { name: "example.iana.org", note: "a real name, live query" },
];

const SOURCE_WORD: Record<VerifierAnswer["source"], string> = {
  "public-dns": "Live public DNS",
  "demo-zone": "This deployment’s demo zone",
  unavailable: "No answer",
};

export function VerifyScreen() {
  const { session } = useSession();
  const [query, setQuery] = useState("ops.northwind.example");
  const [answer, setAnswer] = useState<VerifierAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const asked = useRef(false);

  const ask = useCallback(async (name: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(`/api/verify?agent=${encodeURIComponent(name)}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as VerifierAnswer & { error?: string };
      if (!response.ok) {
        setProblem(body.error ?? "The query could not be sent.");
        setAnswer(null);
        return;
      }
      setAnswer(body);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
      setAnswer(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void ask("ops.northwind.example");
  }, [ask]);

  return (
    <>
      <section className="band band--ink">
        <div className="wrap">
          <div className="band__head">
            <div>
              <h1 className="band__title">Ask what an agent may do</h1>
              <p className="band__note">
                There is no account and no login. An agent&rsquo;s authority is published in public
                DNS, alongside SPF and CAA, or it does not exist.
              </p>
            </div>
          </div>

          <form
            className="ask"
            onSubmit={(event) => {
              event.preventDefault();
              void ask(query.trim());
            }}
          >
            <label className="ask__label" htmlFor="agent">
              Agent domain
            </label>
            <input
              id="agent"
              className="ask__input mono"
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="btn btn--signal" type="submit" disabled={busy}>
              {busy ? "Resolving…" : "Resolve"}
            </button>
          </form>

          <ul className="ask__suggest">
            {SUGGESTIONS.map((suggestion) => (
              <li key={suggestion.name}>
                <button
                  onClick={() => {
                    setQuery(suggestion.name);
                    void ask(suggestion.name);
                  }}
                  disabled={busy}
                >
                  <span className="mono">{suggestion.name}</span>
                  <span>{suggestion.note}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {problem !== null && (
        <div className="alert" role="alert">
          <div className="wrap">{problem}</div>
        </div>
      )}

      {answer !== null && <Answer answer={answer} />}

      {session !== null && <Receipts session={session} />}
    </>
  );
}

/* ----------------------------------------------------------------- answer */

function Answer({ answer }: { answer: VerifierAnswer }) {
  const cap =
    answer.outcome === "active"
      ? "slab__cap--go"
      : answer.outcome === "revoked" || answer.outcome === "error"
        ? "slab__cap--stop"
        : "";

  return (
    <section className="band">
      <div className="wrap">
        <div className="rig">
          <div className="stack">
            <div className="slab">
              <div className="slab__cap">
                <span>Answer — {answer.name} IN TXT</span>
                <span>
                  {SOURCE_WORD[answer.source]} · {answer.elapsedMs} ms
                </span>
              </div>
              <div className="slab__body">
                {answer.txtRecords.length === 0 ? (
                  <p className="txt txt--none mono">
                    ;; no TXT record at this name
                    {"\n"};; the name does not carry a writ
                  </p>
                ) : (
                  answer.txtRecords.map((record, index) => (
                    <p
                      key={index}
                      className="txt mono"
                      data-tomb={record.includes("st=revoked") ? "1" : undefined}
                    >
                      &quot;{record}&quot;
                    </p>
                  ))
                )}
                {answer.problem !== null && <p className="txt__problem">{answer.problem}</p>}
              </div>
            </div>

            <div className="slab">
              <div className="slab__cap">
                <span>Validation</span>
                <span>{answer.resolver}</span>
              </div>
              <div className="slab__body">
                <dl className="kv">
                  <dt>DNSSEC</dt>
                  <dd>
                    {answer.authenticatedData
                      ? "AD flag set — the chain validated"
                      : answer.source === "demo-zone"
                        ? "Served in process; there is no chain to validate"
                        : "AD flag unset — this answer is not authoritative for a verifier"}
                  </dd>
                  <dt>Queried</dt>
                  <dd className="mono">{answer.name}</dd>
                  <dt>Answered</dt>
                  <dd>{answer.resolvedAt.replace("T", " ").slice(0, 19)} UTC</dd>
                  <dt>Records</dt>
                  <dd>{answer.txtRecords.length}</dd>
                </dl>
              </div>
            </div>

            {answer.record !== null && (
              <div className={`slab`}>
                <div className={`slab__cap ${cap}`}>
                  <span>The record, parsed</span>
                  <span>WRIT1 · {answer.outcome}</span>
                </div>
                <div className="slab__body">
                  <dl className="kv">
                    <dt>Status</dt>
                    <dd>{answer.record.status}</dd>
                    <dt>Document</dt>
                    <dd className="mono">{answer.record.documentHash}</dd>
                    <dt>Agent key</dt>
                    <dd className="mono">{answer.record.publicKey}</dd>
                    <dt>Signed copy</dt>
                    <dd className="mono">{answer.record.url}</dd>
                    <dt>Expires</dt>
                    <dd>{new Date(answer.record.expiresAt * 1000).toISOString().slice(0, 10)}</dd>
                  </dl>
                </div>
              </div>
            )}
          </div>

          <div className="stack">
            <div className={`slab notice ${answer.outcome === "active" ? "" : "notice--no"}`}>
              <div className={`slab__cap ${cap}`}>
                <span>
                  {answer.outcome === "active"
                    ? "What this agent may do"
                    : answer.outcome === "revoked"
                      ? "Authority withdrawn"
                      : answer.outcome === "error"
                        ? "Nothing can be said"
                        : "No authority"}
                </span>
              </div>
              <div className="slab__body">
                {answer.reading.map((line, index) => (
                  <p key={index} className="notice__line">
                    {line}
                  </p>
                ))}
              </div>
            </div>

            {answer.instrument !== null && (
              <div className="slab">
                <div className="slab__cap">
                  <span>The instrument behind it</span>
                  <span>{answer.instrument.principal}</span>
                </div>
                <div className="slab__body">
                  {answer.instrument.grants.map((grant) => (
                    <div key={grant.ref} className="notice__grant">
                      <p className="notice__grantref">
                        Clause {grant.ref} — {grant.heading}
                      </p>
                      <ul>
                        {grant.terms.map((term) => (
                          <li key={term}>{term}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  <p
                    className={`notice__agree ${answer.instrument.documentAgrees ? "" : "notice__agree--off"}`}
                  >
                    {answer.instrument.documentAgrees
                      ? "The copy served at the published URL hashes to the value in the record. They are the same instrument."
                      : "The copy served at the published URL does not hash to the value in the record. It is not this instrument, and nothing under it is enforceable."}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- receipts */

/** Re-derive a verdict from the evidence it was made on, the way a disputer would. */
function Receipts({ session }: { session: SessionView }) {
  const [replay, setReplay] = useState<ReplayView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (session.acts.length === 0) return null;

  const check = async (digest: string) => {
    setBusy(digest);
    try {
      const response = await fetch(`/api/bundle/${encodeURIComponent(digest)}`, { cache: "no-store" });
      const body = (await response.json()) as { view?: ReplayView };
      setReplay(body.view ?? null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="band band--flat">
      <div className="wrap">
        <div className="band__head">
          <div>
            <h2 className="band__title">Re-derive a verdict</h2>
            <p className="band__note">
              Every decision was published with the evidence it came from. Running it again over that
              same evidence has to produce the same answer, or the verdict can no longer be
              reproduced — which is the thing a reviewer needs to be told.
            </p>
          </div>
        </div>

        <div className="board__scroll">
          <table className="board">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Act</th>
                <th scope="col">Verdict</th>
                <th scope="col">Receipt</th>
                <th scope="col">Replay</th>
              </tr>
            </thead>
            <tbody>
              {[...session.acts].reverse().map((act) => (
                <tr key={act.id}>
                  <td className="board__t">{act.at.slice(11, 19)}</td>
                  <td>{String(act.fields.domainName ?? act.kind)}</td>
                  <td>
                    <span className={`pill ${act.outcome === "allow" ? "pill--go" : "pill--stop"}`}>
                      {act.reasons[0]?.code}
                    </span>
                  </td>
                  <td className="mono">{act.bundleDigest.slice(0, 20)}…</td>
                  <td>
                    <button
                      className="btn btn--sm btn--ghost"
                      onClick={() => void check(act.bundleDigest)}
                      disabled={busy !== null}
                    >
                      {busy === act.bundleDigest ? "Deriving…" : "Re-derive"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {replay !== null && (
          <div className={`slab replay ${replay.agrees ? "" : "replay--off"}`}>
            <div className={`slab__cap ${replay.agrees ? "slab__cap--go" : "slab__cap--stop"}`}>
              <span>{replay.agrees ? "Reproduced" : "Could not be reproduced"}</span>
              <span className="mono">{replay.digest.slice(0, 24)}…</span>
            </div>
            <div className="slab__body">
              <p>
                Recomputed from the bundle alone, with the clock the decision was made against
                ({replay.evaluatedAt.replace("T", " ").slice(0, 19)} UTC): the engine answers{" "}
                <b>{replay.recomputed.outcome}</b> —{" "}
                {replay.recomputed.reasons.map((reason) => reason.code).join(", ")}.
              </p>
              {!replay.agrees && (
                <ul className="replay__diffs">
                  {replay.differences.map((difference) => (
                    <li key={difference}>{difference}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
