#!/usr/bin/env node
/**
 * `pnpm boundary` — make Foxit refuse us, live, and print what it said.
 *
 * The product's central claim about signing is that an agent cannot send a
 * document for signature, and that this is a fact about the wire rather than a
 * policy in our code. A refusal we produced ourselves would be worth nothing as
 * evidence, so this fires a real `createfolder` and reports the answer verbatim.
 *
 * Two attempts, answering different questions.
 *
 * The first sends nothing. Foxit refuses it, and that refusal is what the design
 * actually rests on: the agent process is built holding no Foxit credential of
 * any kind, so this is the request it would make.
 *
 * The second sends the agent's own PDF Services credentials, to test whether
 * Foxit's key scoping separates the two services by itself. On a standard
 * developer account it does not — the same pair authenticates to eSign, which
 * then answers with a validation complaint rather than a refusal. That is
 * reported rather than hidden, because it is precisely why the boundary has to
 * be structural in our own process instead of delegated to a vendor's key scope.
 *
 * Exits non-zero only if the first attempt is accepted. That would mean the
 * boundary genuinely does not hold, and we would want to know today.
 */

import {
  proveESignIsUnreachable,
  type ESignRefusalProof,
} from "../lib/adapters/foxit/agent-surface";

try {
  process.loadEnvFile(".env.local");
} catch {
  // The no-credentials attempt needs nothing; the second is skipped without it.
}

function report(proof: ESignRefusalProof): void {
  const label =
    proof.credentialsSent === "none"
      ? "sending no credentials at all"
      : "sending the agent's own PDF Services credentials";

  process.stdout.write(`\n${label}\n`);
  process.stdout.write(`  POST    ${proof.url}\n`);
  process.stdout.write(`  status  ${proof.status ?? "no answer"}\n`);
  process.stdout.write(`  body    ${proof.bodyText.trim()}\n`);
  if (proof.bodyResult) process.stdout.write(`  result  ${proof.bodyResult}\n`);
  process.stdout.write(`  verdict ${proof.outcome}\n`);
}

async function main(): Promise<number> {
  process.stdout.write("\nCan an agent send a document for signature?\n");

  const proofs: ESignRefusalProof[] = [];
  proofs.push(await proveESignIsUnreachable({ attempt: "no-credentials" }));

  const id = process.env.FOXIT_CLIENT_ID;
  const secret = process.env.FOXIT_CLIENT_SECRET;
  if (id && secret) {
    proofs.push(
      await proveESignIsUnreachable({
        attempt: "pdf-services-credentials",
        credentials: { scope: "pdf-services", clientId: id, clientSecret: secret },
      }),
    );
  }

  for (const proof of proofs) report(proof);

  const withoutCredentials = proofs[0];
  const withAgentCredentials = proofs[1];

  process.stdout.write("\n");

  if (withoutCredentials.outcome === "accepted-by-foxit") {
    process.stdout.write(
      "FAILED   Foxit accepted a caller with no credentials at all. The boundary the\n" +
        "         product rests on does not hold, and nothing else here matters.\n\n",
    );
    return 1;
  }

  if (withoutCredentials.outcome !== "refused-by-foxit") {
    // A 404 or a timeout means the probe never reached what it was testing, and
    // must not be allowed to read as a pass.
    process.stdout.write(
      "UNPROVEN the unauthenticated attempt produced no refusal, so nothing was shown.\n" +
        `         Foxit answered ${withoutCredentials.outcome}.\n\n`,
    );
    return 1;
  }

  process.stdout.write(
    "PROVEN   An agent holding no Foxit credential cannot send anything for signature.\n" +
      "         The refusal above is Foxit's, not ours, and the agent surface is built so\n" +
      "         that a credential field on it will not compile.\n",
  );

  if (withAgentCredentials === undefined) {
    process.stdout.write(
      "\n         Set FOXIT_CLIENT_ID and FOXIT_CLIENT_SECRET to also test whether Foxit's\n" +
        "         own key scoping separates PDF Services from eSign.\n\n",
    );
    return 0;
  }

  if (withAgentCredentials.outcome === "accepted-by-foxit") {
    process.stdout.write(
      "\nFINDING  Foxit's key scoping does NOT separate the two services on this account.\n" +
        "         The PDF Services credentials authenticated to eSign and came back with a\n" +
        "         validation complaint, not a refusal.\n" +
        "         So the boundary cannot be delegated to a vendor's key scope. It has to be\n" +
        "         about who holds a credential at all — which is why ours is.\n\n",
    );
    return 0;
  }

  process.stdout.write(
    "\n         Foxit also refused the agent's own PDF Services credentials, so its key\n" +
      "         scoping separates the two services on this account.\n\n",
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  });
