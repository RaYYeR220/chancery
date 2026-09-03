/**
 * What is actually answering, as JSON.
 *
 * The point of this endpoint is that a stand-in can never be read as a live
 * result: every port reports `live`, `stand-in` or `misconfigured` with the
 * reason it is in that mode, so a client that renders a verdict can label where
 * each input came from without having to infer it.
 *
 * No secret leaves here in any form. `readConfig` reads values in order to
 * decide whether a service is configured; the report it produces carries
 * variable names and booleans, and a masked prefix would still be a disclosure
 * of a value nobody consented to publish.
 *
 * Derived from configuration alone, so it answers without constructing a
 * `Chancery` or touching a vendor — and it is the same function `composeChancery`
 * reads, so the two cannot drift apart.
 */

import { NextResponse } from "next/server";

import { readConfig, statusReport } from "@/lib/service/config";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { ...statusReport(readConfig()), checkedAt: new Date().toISOString() },
    // The whole value of this endpoint is that it describes the process as it
    // is right now; a cached copy would describe one that has been redeployed.
    { headers: { "cache-control": "no-store" } },
  );
}
