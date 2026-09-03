"use client";

/**
 * The verdict, and the evidence it was drawn from.
 *
 * A refusal is the system working, so it is set as a signage notice rather than
 * as an error: a red cap, the station it stopped at, and the clause it cites.
 * Every sentence of prose here is `DecisionReason.message` straight off the
 * `Decision` — none of it is written in the UI, because the engine's wording is
 * the wording that has to survive into an audit.
 */

import type { ActView, DocumentView, SessionView } from "@/app/_shared/view";

export function VerdictPanel({
  act,
  session,
}: {
  act: ActView | null;
  session: SessionView;
}) {
  if (act === null) return <StandingPanel session={session} />;

  const denied = act.outcome === "deny";
  const stopStation = act.stations.find((station) => station.id === act.stopAt);
  const primary = act.reasons[0];

  return (
    <div className={`verdict ${denied ? "verdict--deny" : "verdict--allow"}`} aria-live="polite">
      <div className="verdict__cap">
        <span className="verdict__word">{denied ? "Deny" : "Allow"}</span>
        <span className="verdict__at">
          {denied ? `stopped at ${stopStation?.name ?? "the gate"}` : "cleared every station"}
        </span>
      </div>

      <div className="verdict__body">
        <p className="verdict__act">{act.title}</p>

        {act.reasons.map((reason, index) => (
          <p key={index} className="verdict__reason">
            {reason.message}
          </p>
        ))}

        {primary?.clauseRef !== undefined && (
          <p className="verdict__cite">
            <span className="pill pill--signal">Clause {primary.clauseRef}</span>
            {primary.pageNumber !== undefined && <span className="pill pill--ghost">Page {primary.pageNumber}</span>}
            <span className="pill pill--ghost">{primary.code}</span>
          </p>
        )}

        <Evidence act={act} document={session.document} />

        <dl className="kv verdict__kv">
          <dt>Receipt</dt>
          <dd className="mono">{act.bundleDigest}</dd>
          <dt>Resolver</dt>
          <dd>
            {act.resolver} — AD {act.authenticatedData ? "set" : "unset"}
          </dd>
          {act.executed !== null && (
            <>
              <dt>Order</dt>
              <dd className="mono">{act.executed.reference}</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- standing */

function StandingPanel({ session }: { session: SessionView }) {
  const { writ, record, stage } = session;

  if (writ === null) {
    return (
      <div className="verdict verdict--idle">
        <div className="verdict__cap">
          <span className="verdict__word">No authority</span>
          <span className="verdict__at">nothing has been granted</span>
        </div>
        <div className="verdict__body">
          <p className="verdict__reason">
            The line is dark. Until a human signs an instrument, every irreversible act
            {" "}{session.agentDomain} attempts is refused, and there is no clause to cite for the refusal
            beyond the absence of one.
          </p>
          <p className="verdict__hint">Draft the writ below to open the line.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`verdict ${stage === "revoked" ? "verdict--deny" : "verdict--idle"}`}>
      <div className="verdict__cap">
        <span className="verdict__word">
          {stage === "revoked" ? "Withdrawn" : stage === "anchored" ? "In force" : "Not yet published"}
        </span>
        <span className="verdict__at">
          {stage === "anchored" ? `${writ.daysRemaining} days to run` : `status ${writ.status}`}
        </span>
      </div>
      <div className="verdict__body">
        <dl className="kv">
          <dt>Instrument</dt>
          <dd className="mono">{writ.id}</dd>
          <dt>Principal</dt>
          <dd>{writ.principal.legalName}</dd>
          <dt>Attorney</dt>
          <dd className="mono">{writ.agent.domain}</dd>
          <dt>Law</dt>
          <dd>{writ.jurisdiction === "IE" ? "Ireland" : writ.jurisdiction}</dd>
          <dt>Record</dt>
          <dd>
            {record === null || record.outcome === "absent"
              ? "Not published"
              : record.outcome === "revoked"
                ? "Tombstone published"
                : "WRIT1 active"}
          </dd>
          <dt>Document</dt>
          <dd className="mono">{writ.documentSha256 ?? "not signed"}</dd>
        </dl>
        <p className="verdict__hint">
          {stage === "revoked"
            ? "Acts committed before the withdrawal stand. Nothing further is authorised."
            : stage === "anchored"
              ? "Put an act on the line and watch where it stops."
              : "Publish the record in DNS to make this authority checkable by anyone."}
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- evidence */

function Evidence({ act, document }: { act: ActView; document: DocumentView | null }) {
  const code = act.reasons[0]?.code;

  if (code === "DOCUMENT_HASH_MISMATCH") {
    return <HashDivergence act={act} document={document} />;
  }

  if (code === "DILIGENCE_FLAGGED" || code === "DILIGENCE_UNKNOWN") {
    return (
      <div className="evidence evidence--stop">
        {act.diligence.map((finding) => (
          <div key={finding.check} className="evidence__item">
            <span className="evidence__src">
              {finding.check.replace(/_/g, " ")} — {finding.verdict}
            </span>
            <p>{finding.summary}</p>
            <ul className="evidence__cites">
              {finding.citations.map((citation) => (
                <li key={citation.url}>
                  <a href={citation.url} target="_blank" rel="noreferrer noopener">
                    {citation.title}
                  </a>
                  <span className="evidence__engine">read via {citation.engine}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  const station = act.stations.find((entry) => entry.id === act.stopAt);
  if (station === undefined || station.note.length === 0) return null;

  return (
    <div className={`evidence ${act.outcome === "deny" ? "evidence--stop" : "evidence--go"}`}>
      <div className="evidence__item">
        <span className="evidence__src">{station.name} — what it compared</span>
        <p>{station.note}</p>
      </div>
    </div>
  );
}

/**
 * The hash divergence, set as a diff. The two values are printed in full and
 * aligned, because "they differ" is a claim and two columns of characters is
 * the proof.
 */
export function HashDivergence({
  act,
  document,
}: {
  act: ActView;
  document: DocumentView | null;
}) {
  const published = act.publishedHash ?? "—";
  const fetched = act.fetchedHash ?? "—";
  const firstDiff = firstDifference(published, fetched);

  return (
    <div className="hashdiff">
      <div className="hashdiff__row">
        <span className="hashdiff__k">DNS publishes</span>
        <span className="hashdiff__v">{published}</span>
      </div>
      <div className="hashdiff__row hashdiff__row--bad">
        <span className="hashdiff__k">Document serves</span>
        <span className="hashdiff__v">{fetched}</span>
      </div>
      <div className="hashdiff__row hashdiff__row--caret">
        <span className="hashdiff__k" />
        <span className="hashdiff__v">
          {" ".repeat(firstDiff)}
          <b>^</b>
        </span>
      </div>
      {document?.edit && (
        <p className="hashdiff__edit">
          The signed copy read <em>{document.edit.before}</em>; the copy now served reads{" "}
          <em>{document.edit.after}</em>. One word and one digit, and every act under this
          instrument stops at the first station.
        </p>
      )}
    </div>
  );
}

function firstDifference(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return length;
}

/* -------------------------------------------------------- suspension bar */

/** The full-bleed notice. It only ever appears because the gate refused. */
export function SuspensionBar({ act, stage }: { act: ActView | null; stage: string }) {
  if (stage === "revoked") {
    return (
      <div className="susp susp--dark" role="status">
        <p className="susp__head">No service — instrument withdrawn</p>
        <p className="susp__why">
          A tombstone is published at the agent&rsquo;s name. Revocation reaches forward only: acts
          committed before it stand, and nothing further is authorised.
        </p>
      </div>
    );
  }

  if (act === null || act.outcome !== "deny") return null;
  const station = act.stations.find((entry) => entry.id === act.stopAt);
  const reason = act.reasons[0];

  return (
    <div className="susp" role="status">
      <p className="susp__head">
        Service suspended at {station?.name ?? "the gate"}
        {reason?.clauseRef !== undefined && ` — clause ${reason.clauseRef}`}
        {reason?.pageNumber !== undefined && `, page ${reason.pageNumber}`}
      </p>
      <p className="susp__why">{reason?.message}</p>
    </div>
  );
}
