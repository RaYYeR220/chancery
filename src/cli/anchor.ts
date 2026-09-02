#!/usr/bin/env node
/**
 * `pnpm anchor <keyword>` — register a domain and publish authority to it.
 *
 * This is the name.com integration end to end: search, register, write the
 * WRIT1 record, and read it back. It runs against the sandbox by default, where
 * registration is free against test credit and the zone is real but never
 * resolves publicly — so the record is read back through the registrar rather
 * than through DNS, and the script says which one it did.
 *
 * Set NAMECOM_ENV=production to do it for real. That spends money.
 */

import { NameComClient } from "../lib/adapters/namecom/client";
import { documentHash } from "../lib/core/bytes";
import { serializeWritRecord, writRecordName, parseWritRecord } from "../lib/core/writ-record";

try {
  process.loadEnvFile(".env.local");
} catch {
  // credentials may come from the ambient environment instead
}

const production = process.env.NAMECOM_ENV === "production";
const username = production ? process.env.NAMECOM_PROD_USERNAME : process.env.NAMECOM_USERNAME;
const token = production ? process.env.NAMECOM_PROD_TOKEN : process.env.NAMECOM_TOKEN;

async function main(): Promise<number> {
  if (!username || !token) {
    process.stderr.write("name.com credentials are not set\n");
    return 2;
  }

  const keyword = process.argv[2] ?? `chancery${Date.now().toString(36)}`;
  const client = new NameComClient({
    environment: production ? "production" : "sandbox",
    username,
    token,
  });

  const hello = await client.hello();
  process.stdout.write(
    `${production ? "PRODUCTION" : "sandbox"} as ${hello.username} on ${hello.serverName}\n\n`,
  );

  const search = await client.searchDomains({ keyword, tldFilter: ["com", "net", "xyz"] });
  const pick = search.results
    .filter((c) => c.purchasable && !c.premium)
    .sort((a, b) => (a.purchasePrice ?? 999) - (b.purchasePrice ?? 999))[0];
  if (!pick) {
    process.stderr.write("nothing purchasable came back\n");
    return 1;
  }
  process.stdout.write(`registering ${pick.domainName} at $${pick.purchasePrice}\n`);

  const registered = await client.registerDomain(
    { domain: { domainName: pick.domainName }, years: 1, purchasePrice: pick.purchasePrice ?? 0 },
    crypto.randomUUID() as never,
  );
  process.stdout.write(`  order ${registered.order}, paid $${registered.totalPaid}\n\n`);

  // A writ this script has not actually signed, so the hash is over a stand-in
  // document. The record shape and the publication path are the real things
  // being proven here.
  const stand_in = new TextEncoder().encode(`writ placeholder for ${pick.domainName}`);
  const value = serializeWritRecord({
    version: "WRIT1",
    status: "active",
    publicKey: "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE",
    documentHash: documentHash(stand_in),
    url: `https://chancery.dev/w/${pick.sld}`,
    expiresAt: Math.floor(Date.now() / 1000) + 90 * 86_400,
  });

  const fqdn = writRecordName(pick.domainName);
  process.stdout.write(`publishing ${fqdn} TXT\n  ${value}\n\n`);
  const record = await client.createRecord(pick.domainName, {
    host: "_writ",
    type: "TXT",
    answer: value,
    ttl: 300,
  });
  process.stdout.write(`  record id ${record.id}\n\n`);

  const readBack = await client.listRecords(pick.domainName);
  const found = readBack.records.find((r) => r.host === "_writ" && r.type === "TXT");
  if (!found) {
    process.stderr.write("the record did not read back\n");
    return 1;
  }
  const parsed = parseWritRecord(found.answer);
  process.stdout.write(
    `read back from the registrar: status=${parsed.status} hash=${parsed.documentHash}\n`,
  );
  process.stdout.write(
    production
      ? `\nNow verify it from outside:  pnpm verify ${pick.domainName}\n`
      : "\nThis is the sandbox: the zone is real but never resolves publicly, so this was read\n" +
        "back through the registrar API, which is NOT the verification path.\n",
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
