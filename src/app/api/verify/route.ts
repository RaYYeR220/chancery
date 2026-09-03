/**
 * The public verifier. No account, no key, no privileged read.
 *
 * Any real name is resolved over DNS-over-HTTPS against Cloudflare, falling
 * back to Google only on a transport failure — never to shop for a friendlier
 * answer. The demo agent is the one exception: its zone is served by this
 * process, so its answers are labelled `demo-zone` and the label travels with
 * the record everywhere it is shown.
 *
 * A lookup that could not be completed answers `error`, not `absent`. "We could
 * not ask" and "nobody has published anything" are different facts, and only
 * one of them is safe to act on.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { createDohResolver, DohError } from "@/lib/dns";
import { selectWritRecord, writRecordName } from "@/lib/core/writ-record";
import type { WritRecord } from "@/lib/core/writ-record";

import { AGENT, describeGrant } from "@/app/_shared/content";
import type { VerifierAnswer } from "@/app/_shared/view";
import { SESSION_COOKIE, getSession } from "../_engine/session";

export const dynamic = "force-dynamic";

const NAME = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+\.?$/;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("agent")?.trim().toLowerCase() ?? "";
  if (raw.length === 0 || !NAME.test(raw)) {
    return NextResponse.json(
      { error: "Enter an agent's domain name, for example ops.northwind.example" },
      { status: 400 },
    );
  }

  const agentDomain = raw.replace(/\.$/, "");
  const name = writRecordName(agentDomain);

  if (agentDomain === AGENT.domain) {
    return NextResponse.json(await answerFromDemoZone(agentDomain, name));
  }
  return NextResponse.json(await answerFromPublicDns(agentDomain, name));
}

/* ------------------------------------------------------------- public DNS */

async function answerFromPublicDns(agentDomain: string, name: string): Promise<VerifierAnswer> {
  const resolver = createDohResolver({ timeoutMs: 5_000 });
  const startedAt = Date.now();

  try {
    const lookup = await resolver.resolveTxt(name);
    const elapsedMs = Date.now() - startedAt;
    const selected = selectWritRecord(lookup.values);
    const record = selected.outcome === "absent" ? null : selected.record;

    return {
      agentDomain,
      name,
      source: "public-dns",
      resolver: `${lookup.resolver} — RCODE ${lookup.status}`,
      txtRecords: lookup.values,
      authenticatedData: lookup.authenticatedData,
      resolvedAt: new Date().toISOString(),
      elapsedMs,
      outcome: selected.outcome,
      record,
      problem:
        selected.outcome === "absent" && lookup.values.length > 0
          ? `${lookup.values.length} TXT ${lookup.values.length === 1 ? "record" : "records"} at this name, none of them a WRIT1 record.`
          : null,
      reading: reading(agentDomain, selected.outcome, record, lookup.authenticatedData),
      instrument: null,
    };
  } catch (error) {
    const detail =
      error instanceof DohError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      agentDomain,
      name,
      source: "unavailable",
      resolver: "no resolver answered",
      txtRecords: [],
      authenticatedData: false,
      resolvedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      outcome: "error",
      record: null,
      problem: detail,
      reading: [
        "The lookup did not complete, so nothing can be said about this agent's authority.",
        "An unanswered query is not the same as no authority, and it must not be treated as either an allow or a deny.",
      ],
      instrument: null,
    };
  }
}

/* -------------------------------------------------------------- demo zone */

async function answerFromDemoZone(agentDomain: string, name: string): Promise<VerifierAnswer> {
  const jar = await cookies();
  const session = getSession(jar.get(SESSION_COOKIE)?.value);
  const startedAt = Date.now();

  if (session === null) {
    return {
      agentDomain,
      name,
      source: "demo-zone",
      resolver: "chancery-demo-zone — nothing published yet",
      txtRecords: [],
      authenticatedData: false,
      resolvedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      outcome: "absent",
      record: null,
      problem:
        "This name is served by the demo zone in this deployment, and nothing has been published " +
        "into it yet. Draft, sign and publish an instrument on the console first.",
      reading: [
        `Nothing is published at ${name}.`,
        `${agentDomain} therefore holds no authority to commit to anything on anyone's behalf.`,
      ],
      instrument: null,
    };
  }

  const { lookup, resolution } = await session.resolver.lookupWrit(agentDomain);
  const record = lookup.outcome === "absent" ? null : lookup.record;
  const writ = await session.writ();
  const currentHash = writ === null ? null : session.desk.currentHash(writ.id);

  return {
    agentDomain,
    name,
    source: "demo-zone",
    resolver: resolution.resolver,
    txtRecords: resolution.txtRecords,
    authenticatedData: resolution.authenticatedData,
    resolvedAt: resolution.resolvedAt,
    elapsedMs: Date.now() - startedAt,
    outcome: lookup.outcome,
    record,
    problem: null,
    reading: reading(agentDomain, lookup.outcome, record, resolution.authenticatedData),
    instrument:
      writ === null || writ.policy === null
        ? null
        : {
            principal: writ.spec.principal.legalName,
            grants: writ.spec.grants.map((grant) => {
              const clause = describeGrant(grant);
              return { ref: clause.ref, heading: clause.heading, terms: clause.terms };
            }),
            documentAgrees: record !== null && currentHash === record.documentHash,
            expiresAt: writ.spec.expiresAt,
          },
  };
}

/* ------------------------------------------------------------ the reading */

/** One sentence per fact the record actually carries. Nothing is inferred. */
function reading(
  agentDomain: string,
  outcome: "active" | "revoked" | "absent",
  record: WritRecord | null,
  authenticatedData: boolean,
): string[] {
  if (outcome === "absent" || record === null) {
    return [
      `No writ is published for ${agentDomain}.`,
      `Nothing may be committed on anyone's behalf by ${agentDomain}, because there is no instrument to point at.`,
    ];
  }

  if (outcome === "revoked") {
    return [
      `The principal has published a revocation for ${agentDomain}.`,
      "A revocation is a positive record rather than a deletion, so a resolver still serving the old answer cannot hide it.",
      "Acts committed before the revocation stand. Nothing further is authorised.",
    ];
  }

  const expiry = new Date(record.expiresAt * 1000);
  const lines = [
    `${agentDomain} holds a writ that runs until ${expiry.toISOString().slice(0, 10)}.`,
    `The instrument it grants authority under must hash to ${record.documentHash}. A copy that does not is not this instrument.`,
    `The agent's key is ${record.publicKey}.`,
    `The signed document is published at ${record.url}, so the terms can be read without asking anyone.`,
  ];

  lines.push(
    authenticatedData
      ? "The answer was DNSSEC-validated, so a revocation could not have been stripped in transit."
      : "The answer was not DNSSEC-validated. A strict verifier reports this authority as unverified rather than valid, because a revocation could have been removed on the way here.",
  );
  return lines;
}
