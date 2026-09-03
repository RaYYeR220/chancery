/**
 * Which half of the system is live, reported rather than assumed.
 *
 * A demo that shows a scripted answer in the same style as a live one is worse
 * than no demo. So every seam reports three separate facts — whether its
 * credentials are present, what is actually answering in this session, and
 * whether that answer touched the network — and the UI prints all three. A
 * service with no credentials is `unavailable`, never `pass`.
 */

import type { ModeReport, ServiceStatus } from "@/app/_shared/view";

function present(...names: string[]): boolean {
  return names.every((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.length > 0;
  });
}

export function serpApiKey(): string | null {
  const key = process.env.SERPAPI_KEY;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/**
 * Live diligence is opt-in even with a key present, because a check that times
 * out answers `unknown` and `unknown` denies. The walkthrough has to be
 * reproducible; a live SERP's latency is not.
 */
export function liveDiligenceRequested(): boolean {
  return process.env.CHANCERY_LIVE_DILIGENCE === "1";
}

export function modeReport(): ModeReport {
  const doctavian = present("DOCTAVIAN_BEARER", "DOCTAVIAN_DOCUMENTS_KEY");
  const foxit = present("FOXIT_ESIGN_CLIENT_ID", "FOXIT_ESIGN_CLIENT_SECRET");
  const nutrient = present("NUTRIENT_API_KEY");
  const namecom = present("NAMECOM_USERNAME", "NAMECOM_TOKEN");
  const serpapiKey = serpApiKey() !== null;
  const serpapi = serpapiKey && liveDiligenceRequested();
  const xano = present("XANO_BASE_URL", "XANO_TOKEN");

  const services: ServiceStatus[] = [
    {
      key: "decide",
      label: "Chancery gatekeeper",
      role: "The verdict",
      supply: "live",
      detail: "decide() runs unchanged. Every verdict on screen came out of it.",
      requires: [],
      credentialsPresent: true,
    },
    {
      key: "dns",
      label: "Public DNS",
      role: "Where authority is published",
      supply: "live",
      detail:
        "The verifier queries Cloudflare and Google over DoH for any real name. The demo agent's " +
        "zone is served in-process and is labelled as such wherever it appears.",
      requires: [],
      credentialsPresent: true,
    },
    {
      key: "doctavian",
      label: "Doctavian",
      role: "Generating the writ",
      supply: doctavian ? "live" : "scripted",
      detail: doctavian
        ? "Credentials present. The demo session still renders locally so it stays reproducible."
        : "The instrument is rendered in process from the same grants the gate enforces.",
      requires: ["DOCTAVIAN_BEARER", "DOCTAVIAN_DOCUMENTS_KEY"],
      credentialsPresent: doctavian,
    },
    {
      key: "foxit",
      label: "Foxit eSign",
      role: "The signature ceremony",
      supply: foxit ? "live" : "scripted",
      detail: foxit
        ? "Credentials present, held server-side. No agent-facing route can reach them."
        : "No signing credential is configured, so no agent path could reach one either.",
      requires: ["FOXIT_ESIGN_CLIENT_ID", "FOXIT_ESIGN_CLIENT_SECRET"],
      credentialsPresent: foxit,
    },
    {
      key: "nutrient",
      label: "Nutrient DWS",
      role: "Reading the signed writ back",
      supply: nutrient ? "live" : "scripted",
      detail: nutrient
        ? "Credentials present. Extraction is metered per page and is not run on every act."
        : "Terms are read back in process, with a page and a box recorded for every clause.",
      requires: ["NUTRIENT_API_KEY"],
      credentialsPresent: nutrient,
    },
    {
      key: "namecom",
      label: "name.com",
      role: "Registration and the DNS anchor",
      supply: namecom ? "live" : "scripted",
      detail: namecom
        ? "Credentials present. The demo session does not spend money against them."
        : "Registrations return an order reference and buy nothing. No card is reachable from here.",
      requires: ["NAMECOM_USERNAME", "NAMECOM_TOKEN"],
      credentialsPresent: namecom,
    },
    {
      key: "serpapi",
      label: "SerpApi",
      role: "Diligence against the live world",
      supply: serpapi ? "live" : "scripted",
      detail: serpapi
        ? "Trademark checks run against live search results, and a check that times out denies."
        : serpapiKey
          ? "Credentials present, live checks not requested. Set CHANCERY_LIVE_DILIGENCE=1 to run them; until then a local register extract of three entries answers, quoted in full on every finding."
          : "Trademark checks read a local register extract of three entries, quoted in full on every finding.",
      requires: ["SERPAPI_KEY", "CHANCERY_LIVE_DILIGENCE=1"],
      credentialsPresent: serpapiKey,
    },
    {
      key: "xano",
      label: "Xano",
      role: "Registry, ledger and act history",
      supply: "scripted",
      detail: xano
        ? "Credentials present. The demo session uses the in-process store so a reset costs nothing."
        : "MemoryWritStore holds the session. It builds the same hash chain the backend of record does.",
      requires: ["XANO_BASE_URL", "XANO_TOKEN"],
      credentialsPresent: xano,
    },
  ];

  const scriptedThroughout = !doctavian && !foxit && !nutrient && !namecom && !serpapiKey && !xano;

  return {
    scriptedThroughout,
    headline: scriptedThroughout
      ? "Scripted session — no credentials configured"
      : "Mixed session — some seams are live",
    services,
  };
}
