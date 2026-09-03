/**
 * The boundary tests.
 *
 * Two claims are under test and they are different in kind. The first is that
 * the agent-facing object is structurally unable to reach eSign — asserted by
 * exercising every tool it has and watching what leaves the process. The second
 * is that Foxit, not us, refuses an agent that tries anyway; the assertions
 * there are deliberately about *where the refusal came from*, because a refusal
 * we produced ourselves would prove nothing.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_SURFACE_CANNOT_REACH_ESIGN,
  AGENT_SURFACE_HOLDS_NO_DATA,
  agentSurfaceMembers,
  createAgentSurface,
  proveESignIsUnreachable,
  type AgentSurface,
} from "../../src/lib/adapters/foxit/agent-surface";
import { FoxitScopeError } from "../../src/lib/adapters/foxit/errors";
import { bytesToBase64 } from "../../src/lib/adapters/foxit/pdf-services";
import { pdfServicesCredentials, type FetchLike } from "../../src/lib/adapters/foxit/types";
import { draftPdf } from "../fixtures/foxit/artefacts";
import { fakeFetch, routedFetch, type FakeFetch } from "../fixtures/foxit/fake-fetch";

import gateway401 from "../fixtures/foxit/gateway-401.json";
import legacyAuthError from "../fixtures/foxit/legacy-auth-error.json";
import shareLink from "../fixtures/foxit/share-link.json";
import taskCompleted from "../fixtures/foxit/task-completed.json";
import upload from "../fixtures/foxit/upload.json";

const AGENT_CREDENTIALS = pdfServicesCredentials("cid-pdf", "secret-pdf");

const REVERSIBLE_ROUTES = {
  "POST /pdf-services/api/documents/upload": { body: upload },
  "POST /pdf-services/api/documents/create/*": { body: taskCompleted },
  "POST /pdf-services/api/documents/modify/*": { body: taskCompleted },
  "POST /pdf-services/api/documents/*": { body: shareLink },
  "GET /pdf-services/api/documents/*": { bytes: draftPdf() },
  "GET /pdf-services/api/tasks/*": { body: taskCompleted },
  "POST /document-generation/api/GenerateDocumentBase64": {
    body: { base64FileString: bytesToBase64(draftPdf("generated")) },
  },
};

function surface(): { agent: AgentSurface; fake: FakeFetch } {
  const fake = routedFetch(REVERSIBLE_ROUTES);
  return {
    fake,
    agent: createAgentSurface({
      credentials: AGENT_CREDENTIALS,
      fetchImpl: fake,
      sleep: async () => {},
    }),
  };
}

/** Every tool on the surface, called once, with values an attacker would pick. */
async function exerciseEveryTool(agent: AgentSurface, documentId: string): Promise<void> {
  await agent.uploadDocument({ fileName: "writ.pdf", bytes: draftPdf() });
  await agent.generateDocument({
    base64FileString: bytesToBase64(draftPdf("template")),
    documentValues: { principal: documentId },
    outputFormat: "pdf",
  });
  await agent.convertToPdf("word", documentId);
  await agent.convertFromPdf("word", documentId);
  await agent.compressDocument(documentId);
  await agent.combineDocuments([documentId, documentId]);
  await agent.extractFromDocument(documentId);
  await agent.downloadDocument(documentId);
  await agent.createShareLink(documentId);
}

describe("the surface holds nothing", () => {
  it("proves at compile time that every member is a function", () => {
    // These constants do not typecheck if `AgentSurface` grows a data field or
    // a credential-shaped key, so the build is the real assertion here.
    expect(AGENT_SURFACE_HOLDS_NO_DATA).toBe(true);
    expect(AGENT_SURFACE_CANNOT_REACH_ESIGN).toBe(true);
  });

  it("has no member at runtime that is not a function", () => {
    const { agent } = surface();
    const members = agentSurfaceMembers(agent);

    expect(members.length).toBeGreaterThan(0);
    expect(members.filter((member) => !member.isFunction)).toEqual([]);
  });

  it("exposes exactly the reversible tools and nothing that sounds like signing", () => {
    const { agent } = surface();
    const names = agentSurfaceMembers(agent).map((member) => member.name);

    expect(names.sort()).toEqual([
      "combineDocuments",
      "compressDocument",
      "convertFromPdf",
      "convertToPdf",
      "createShareLink",
      "downloadDocument",
      "extractFromDocument",
      "generateDocument",
      "uploadDocument",
    ]);
    expect(names.filter((name) => /sign|send|envelope/i.test(name))).toEqual([]);
  });

  it("cannot have an eSign client bolted onto it after construction", () => {
    const { agent } = surface();
    expect(() => {
      (agent as unknown as Record<string, unknown>).esign = { createFolder: () => {} };
    }).toThrow(TypeError);
  });
});

describe("nothing the surface can do reaches eSign", () => {
  it("addresses only PDF Services and Document Generation, across every tool", async () => {
    const { agent, fake } = surface();
    await exerciseEveryTool(agent, upload.documentId);

    expect(fake.calls.length).toBeGreaterThan(8);
    for (const path of fake.paths()) {
      expect(path).not.toContain("/esign/");
      expect(
        path.startsWith("/pdf-services/api/") || path.startsWith("/document-generation/api/"),
      ).toBe(true);
    }
  });

  it("keeps a traversal-shaped document id inside one path segment", async () => {
    const { agent, fake } = surface();
    await exerciseEveryTool(agent, "../../../esign/api/v1/folders/createfolder");

    for (const call of fake.calls) {
      expect(call.pathname).not.toContain("/esign/");
      expect(new URL(call.url).pathname.startsWith("/pdf-services/api/")
        || new URL(call.url).pathname.startsWith("/document-generation/api/")).toBe(true);
    }
  });

  it("refuses outright if an eSign path ever reaches the transport", async () => {
    // Reaching past the surface into the client it closes over is the only way
    // to attempt this at all, and the guard still stops it before the wire.
    const fake = fakeFetch({ body: {} });
    const { FoxitPdfServicesClient } = await import(
      "../../src/lib/adapters/foxit/pdf-services"
    );
    const client = new FoxitPdfServicesClient({
      credentials: AGENT_CREDENTIALS,
      fetchImpl: fake,
    });
    const request = (
      client as unknown as {
        http: { json: (spec: { method: string; path: string }) => Promise<unknown> };
      }
    ).http;

    await expect(
      request.json({ method: "POST", path: "/esign/api/v1/folders/createfolder" }),
    ).rejects.toBeInstanceOf(FoxitScopeError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("the refusal is Foxit's, not ours", () => {
  const at = () => new Date("2026-09-02T09:00:00.000Z");

  it("sends a real createfolder with no credentials and reports the 401", async () => {
    const fake = fakeFetch({ status: 401, body: gateway401 });
    const proof = await proveESignIsUnreachable({
      attempt: "no-credentials",
      fetchImpl: fake,
      now: at,
    });

    // The request actually left. A local refusal would have recorded no call.
    expect(fake.calls).toHaveLength(1);
    expect(fake.last().pathname).toBe("/esign/api/v1/folders/createfolder");
    expect(fake.last().headers.get("client_id")).toBeNull();
    expect(fake.last().headers.get("client_secret")).toBeNull();
    expect(fake.last().headers.get("authorization")).toBeNull();

    expect(proof.outcome).toBe("refused-by-foxit");
    expect(proof.status).toBe(401);
    expect(proof.credentialsSent).toBe("none");
    expect(proof.url).toBe("https://na1.fusion.foxit.com/esign/api/v1/folders/createfolder");
    expect(proof.bodyText).toContain("Invalid client_id");
    expect(proof.at).toBe("2026-09-02T09:00:00.000Z");
  });

  it("gets the same answer when the agent sends its own PDF Services key", async () => {
    const fake = fakeFetch({ status: 401, body: gateway401 });
    const proof = await proveESignIsUnreachable({
      attempt: "pdf-services-credentials",
      credentials: AGENT_CREDENTIALS,
      fetchImpl: fake,
      now: at,
    });

    // Note what this does and does not establish. It shows the probe sends the
    // agent's own key when asked to, and reports whatever comes back. It does
    // NOT show that a PDF Services key is refused by eSign — on a real Foxit
    // developer account it is not. See the live-shapes block below.
    expect(fake.last().headers.get("client_id")).toBe("cid-pdf");
    expect(proof.credentialsSent).toBe("pdf-services");
    expect(proof.outcome).toBe("refused-by-foxit");
  });

  it("reads the legacy host's 200-with-an-error-body as the refusal it is", async () => {
    const fake = fakeFetch({ status: 200, body: legacyAuthError });
    const proof = await proveESignIsUnreachable({
      attempt: "no-credentials",
      surface: "legacy",
      fetchImpl: fake,
      now: at,
    });

    expect(proof.url).toBe("https://na1.foxitesign.foxit.com/api/v1/folders/createfolder");
    expect(proof.status).toBe(200);
    expect(proof.bodyResult).toBe("error");
    expect(proof.outcome).toBe("refused-by-foxit");
  });

  it("says so loudly if Foxit ever accepts the call", async () => {
    const fake = fakeFetch({ status: 200, body: { folderId: "folder_oops" } });
    const proof = await proveESignIsUnreachable({
      attempt: "no-credentials",
      fetchImpl: fake,
      now: at,
    });

    expect(proof.outcome).toBe("accepted-by-foxit");
  });

  it("distinguishes a non-auth error from a refusal", async () => {
    const fake = fakeFetch({ status: 500, body: { message: "upstream" } });
    const proof = await proveESignIsUnreachable({
      attempt: "no-credentials",
      fetchImpl: fake,
      now: at,
    });

    expect(proof.outcome).toBe("other-foxit-error");
    expect(proof.status).toBe(500);
  });

  it("proves nothing, and says it proves nothing, when the call never landed", async () => {
    const dead: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    const proof = await proveESignIsUnreachable({
      attempt: "no-credentials",
      fetchImpl: dead,
      now: at,
    });

    expect(proof.outcome).toBe("no-answer");
    expect(proof.status).toBeNull();
    expect(proof.transportError).toContain("fetch failed");
  });

  it("will not run the credentialled attempt without credentials to run it with", async () => {
    await expect(
      proveESignIsUnreachable({
        attempt: "pdf-services-credentials",
        fetchImpl: fakeFetch({ status: 401 }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

/**
 * Shapes captured from the live gateway on 2026-09-03. The first version of the
 * classifier read any `{"result":"error"}` as a refusal and therefore reported a
 * proof that was not there — these pin the distinction so it cannot regress.
 */
describe("telling a refusal apart from a complaint, on live-observed shapes", () => {
  const at = () => new Date("2026-09-03T01:00:00.000Z");

  it("counts the gateway's 400 with allow:false as a refusal", async () => {
    const fake = fakeFetch({
      status: 400,
      body: {
        allow: false,
        reason: "Missing credentials: provide both 'client_id' and 'client_secret' headers.",
      },
    });
    const proof = await proveESignIsUnreachable({
      attempt: "no-credentials",
      fetchImpl: fake,
      now: at,
    });
    expect(proof.outcome).toBe("refused-by-foxit");
  });

  it("does NOT count a validation complaint as a refusal", async () => {
    // Reaching the endpoint and being told the request is malformed means the
    // caller authenticated. Counting this as a refusal would turn the whole
    // boundary proof into a formality that always passes.
    const fake = fakeFetch({
      status: 200,
      body: { result: "error", error_description: "fileNames cannot be empty" },
    });
    const proof = await proveESignIsUnreachable({
      attempt: "pdf-services-credentials",
      credentials: AGENT_CREDENTIALS,
      fetchImpl: fake,
      now: at,
    });
    expect(proof.outcome).toBe("accepted-by-foxit");
    expect(proof.bodyResult).toBe("error");
  });

  it("still counts the legacy host's auth-shaped error body as a refusal", async () => {
    const fake = fakeFetch({
      status: 200,
      body: { result: "error", error_description: "Invalid credentials" },
    });
    const proof = await proveESignIsUnreachable({
      attempt: "no-credentials",
      surface: "legacy",
      fetchImpl: fake,
      now: at,
    });
    expect(proof.outcome).toBe("refused-by-foxit");
  });
});
