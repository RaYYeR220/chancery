"use client";

/**
 * Issuing the instrument, as four stops on a short line.
 *
 * Each stop shows the artefact it produced rather than a tick, because the
 * point of the sequence is that a real thing exists at every stage: a document,
 * an envelope, a set of terms with page citations, and a record in DNS anyone
 * can read. Signing is the one stop with no automated path past it.
 */

import { useSession } from "@/components/state/session";
import type { SessionView } from "@/app/_shared/view";

type StopState = "done" | "now" | "waiting";

export function IssueLine({ session }: { session: SessionView }) {
  const { lifecycle, pending } = useSession();
  const { stage, writ, record } = session;

  const done = {
    draft: writ !== null,
    sign: writ !== null && writ.documentSha256 !== null,
    read: writ !== null && writ.documentSha256 !== null,
    publish: stage === "anchored" || stage === "revoked",
  };

  const stops: {
    id: string;
    ordinal: string;
    title: string;
    state: StopState;
    artefact: React.ReactNode;
    action?: React.ReactNode;
  }[] = [
    {
      id: "draft",
      ordinal: "1",
      title: "Draft the writ",
      state: done.draft ? "done" : "now",
      artefact: writ ? (
        <>
          {writ.grants.length} grants, clauses {writ.grants.map((grant) => grant.ref).join(" and ")},
          governed by {writ.jurisdiction === "IE" ? "Irish law" : writ.jurisdiction}
        </>
      ) : (
        <>Terms branch on jurisdiction and compute the ceiling from their parts.</>
      ),
      action: done.draft ? undefined : (
        <button className="btn btn--sm" onClick={() => void lifecycle("draft")} disabled={pending !== null}>
          {pending === "draft" ? "Drafting…" : "Draft"}
        </button>
      ),
    },
    {
      id: "sign",
      ordinal: "2",
      title: "A human signs",
      state: done.sign ? "done" : done.draft ? "now" : "waiting",
      artefact: writ?.envelopeId ? (
        <>
          Envelope <span className="mono">{writ.envelopeId}</span>, executed by{" "}
          {writ.principal.legalName}
        </>
      ) : (
        <>No agent path holds a signing credential, so no agent can take this step.</>
      ),
      action:
        done.draft && !done.sign ? (
          <button
            className="btn btn--sm btn--signal"
            onClick={() => void lifecycle("sign")}
            disabled={pending !== null}
          >
            {pending === "sign" ? "Signing…" : "Sign"}
          </button>
        ) : undefined,
    },
    {
      id: "read",
      ordinal: "3",
      title: "Read the signed copy back",
      state: done.read ? "done" : "waiting",
      artefact: done.read ? (
        <>
          Every clause carries a page and a box on that page. Nothing failed to ground, so nothing
          was dropped.
        </>
      ) : (
        <>A term that does not ground in the page it came from is treated as absent.</>
      ),
    },
    {
      id: "publish",
      ordinal: "4",
      title: "Publish in DNS",
      state: done.publish ? "done" : done.sign ? "now" : "waiting",
      artefact:
        record !== null && record.outcome !== "absent" ? (
          <>
            Published at <span className="mono">{record.name}</span>, answered by {record.resolver}
          </>
        ) : (
          <>The hash, the key and the expiry go where SPF and CAA already live.</>
        ),
      action:
        done.sign && !done.publish ? (
          <button
            className="btn btn--sm"
            onClick={() => void lifecycle("anchor")}
            disabled={pending !== null}
          >
            {pending === "anchor" ? "Publishing…" : "Publish"}
          </button>
        ) : undefined,
    },
  ];

  return (
    <ol className="issue">
      {stops.map((stop) => (
        <li key={stop.id} className="issue__stop" data-state={stop.state}>
          <span className="issue__mark" aria-hidden="true">
            {stop.state === "done" ? "✓" : stop.ordinal}
          </span>
          <div className="issue__text">
            <p className="issue__title">{stop.title}</p>
            <p className="issue__artefact">{stop.artefact}</p>
          </div>
          {stop.action && <div className="issue__action">{stop.action}</div>}
        </li>
      ))}
    </ol>
  );
}
