/**
 * The status report is accurate for a mixed configuration.
 *
 * Two properties are being defended. A port is reported as live only when its
 * vendor is actually wired, so a stand-in can never be presented as a live
 * result — and no secret leaves in any form, not even a length or a prefix,
 * because this report is served to whoever can reach the endpoint.
 */

import { describe, expect, it } from "vitest";

import { composeChancery } from "@/lib/service/compose";
import { readConfig, statusReport, type PortName } from "@/lib/service/config";
import * as w from "@/lib/eval/world";

/**
 * Opaque on purpose. A fixture that spelled its vendor's name would collide
 * with the report's own prose and make the leak assertion below pass or fail
 * for the wrong reason.
 */
const SECRETS = {
  NUTRIENT_API_KEY: "zq7Xk2Lp9RvT4wB1",
  SERPAPI_KEY: "mH8jY3sD6fA0cE5n",
  NAMECOM_USERNAME: "uW4rQ9tZ2xV7bK1m",
  NAMECOM_TOKEN: "gN6pL0dC3hJ8yF5s",
  XANO_BASE_URL: "https://kR2vM7qX.example/api",
};

/**
 * Nutrient, SerpApi and name.com configured; Xano half-configured; Doctavian
 * and Foxit absent. One of each state, which is the case worth asserting.
 */
const MIXED: Record<string, string | undefined> = {
  ...SECRETS,
  NAMECOM_ENV: "sandbox",
  CHANCERY_DOCUMENT_BASE_URL: "https://chancery.example/w",
};

function modes(env: Record<string, string | undefined>): Record<PortName, string> {
  const report = statusReport(readConfig(env));
  return Object.fromEntries(report.ports.map((port) => [port.port, port.mode])) as Record<
    PortName,
    string
  >;
}

describe("the status report", () => {
  it("reports each port in the mode it is actually in", () => {
    expect(modes(MIXED)).toEqual({
      generator: "stand-in",
      signatures: "stand-in",
      extractor: "live",
      registry: "live",
      // Authority is read back from wherever it was written, so the resolver
      // follows the registrar rather than a credential of its own.
      resolver: "live",
      diligence: "live",
      // XANO_BASE_URL without XANO_TOKEN is a deployment someone meant to
      // configure, which must never be reported as a deliberate stand-in run.
      store: "misconfigured",
    });
  });

  it("distinguishes a half-configured seam from an absent one, in words", () => {
    const report = statusReport(readConfig(MIXED));

    const store = report.ports.find((port) => port.port === "store");
    expect(store?.reason).toContain("XANO_TOKEN");
    expect(store?.reason).toContain("partly configured");
    expect(store?.requires).toEqual([
      { name: "XANO_BASE_URL", present: true },
      { name: "XANO_TOKEN", present: false },
    ]);

    const signatures = report.ports.find((port) => port.port === "signatures");
    expect(signatures?.reason).toContain("FOXIT_ESIGN_CLIENT_SECRET");
    expect(signatures?.reason).not.toContain("partly configured");

    expect(report.standInThroughout).toBe(false);
    expect(report.headline).toContain("partly configured");
  });

  it("never carries a secret, in any form", () => {
    const serialised = JSON.stringify(statusReport(readConfig(MIXED)));

    for (const value of Object.values(SECRETS)) {
      expect(serialised).not.toContain(value);
    }
    // Not even a prefix: a masked secret is still a disclosure of one. Checked
    // on the opaque credentials rather than on XANO_BASE_URL, whose first six
    // characters are `https:` and are shared with the report's own prose.
    for (const value of Object.values(SECRETS).filter((entry) => !entry.startsWith("https://"))) {
      expect(serialised).not.toContain(value.slice(0, 6));
    }
    // Variable names and booleans are the whole of what it says about them.
    expect(serialised).toContain('{"name":"SERPAPI_KEY","present":true}');
  });

  it("refuses to relax the DNSSEC requirement on a value it cannot read", () => {
    const report = statusReport(
      readConfig({ ...MIXED, CHANCERY_ALLOW_UNAUTHENTICATED_DNS: "perhaps" }),
    );

    expect(report.settings.allowUnauthenticatedDns.value).toBe(false);
    expect(report.settings.allowUnauthenticatedDns.configured).toBe(false);
    expect(report.warnings.join(" ")).toContain("could not be read as a boolean");
  });

  it("takes the registrar offline rather than guess which environment was meant", () => {
    expect(modes({ ...MIXED, NAMECOM_ENV: "staging" })).toMatchObject({
      registry: "misconfigured",
      resolver: "misconfigured",
    });
  });

  it("matches what the composition actually wired", () => {
    const { ports, deps } = composeChancery({ env: MIXED, clock: () => w.NOW });

    const byPort = Object.fromEntries(ports.map((port) => [port.port, port]));
    expect(byPort.diligence.implementation).toBe("SerpApiDiligenceService");
    expect(deps.diligence.constructor.name).toBe("SerpApiDiligenceService");

    // Half-configured falls back to the stand-in and is labelled for it, so a
    // reader is never told a broken seam is a deliberate one.
    expect(byPort.store.mode).toBe("misconfigured");
    expect(deps.store.constructor.name).toBe("MemoryWritStore");

    expect(deps.generator.constructor.name).toBe("StandInDocumentDesk");
    expect(deps.allowUnauthenticatedDns).toBe(false);
    expect(deps.documentBaseUrl).toBe("https://chancery.example/w");
  });
});
