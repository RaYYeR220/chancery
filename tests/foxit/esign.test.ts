import { describe, expect, it } from "vitest";

import {
  ESIGN_SURFACES,
  FoxitESignClient,
  assertSendableRequest,
  assertSurfacePairing,
  isCompletedStatus,
  unpackCompletedFolder,
  validateFields,
} from "../../src/lib/adapters/foxit/esign";
import {
  FoxitAuthError,
  FoxitFieldError,
  FoxitSurfaceError,
} from "../../src/lib/adapters/foxit/errors";
import {
  esignCredentials,
  esignLegacyCredentials,
  type CreateFolderRequest,
  type ESignField,
} from "../../src/lib/adapters/foxit/types";
import {
  completionArchive,
  draftPdf,
  signedPdf,
} from "../fixtures/foxit/artefacts";
import { fakeFetch, routedFetch } from "../fixtures/foxit/fake-fetch";

import createFolder from "../fixtures/foxit/create-folder.json";
import folderCompleted from "../fixtures/foxit/folder-status-completed.json";
import folderOut from "../fixtures/foxit/folder-status-out-for-signature.json";
import gateway401 from "../fixtures/foxit/gateway-401.json";
import legacyAuthError from "../fixtures/foxit/legacy-auth-error.json";

const TOMCAT_404 = `<!doctype html><html><head><title>HTTP Status 404 - Not Found</title></head>
<body><h1>HTTP Status 404 - Not Found</h1><h3>Apache Tomcat/9.0.83</h3></body></html>`;

const SIGNATURE_FIELD: ESignField = {
  documentNumber: 1,
  pageNumber: 1,
  party: 1,
  type: "signature",
  x: 72,
  y: 620,
  width: 220,
  height: 44,
};

function request(overrides: Partial<CreateFolderRequest> = {}): CreateFolderRequest {
  return {
    folderName: "Writ of authority",
    sendNow: true,
    inputType: "url",
    fileUrls: ["https://na1.fusion.foxit.com/pdf-services/share/8f2c1d9a4b6e"],
    signers: [{ emailId: "principal@example.com", firstName: "Ada", party: 1 }],
    fields: [SIGNATURE_FIELD],
    ...overrides,
  };
}

describe("surfaces", () => {
  it("pairs the gateway host with the gateway prefix", () => {
    const client = new FoxitESignClient({
      auth: { surface: "gateway", credentials: esignCredentials("cid", "secret") },
      fetchImpl: fakeFetch({ body: createFolder }),
    });
    expect(client.baseUrl).toBe(ESIGN_SURFACES.gateway.baseUrl);
    expect(client.prefix).toBe("/esign/api/v1");
  });

  it("rejects the published-but-broken legacy-host + gateway-prefix combination", () => {
    expect(() =>
      new FoxitESignClient({
        auth: { surface: "gateway", credentials: esignCredentials("cid", "secret") },
        baseUrl: "https://na1.foxitesign.foxit.com",
      }),
    ).toThrow(FoxitSurfaceError);
  });

  it("rejects the mirror mistake: gateway host with the legacy prefix", () => {
    expect(() =>
      new FoxitESignClient({
        auth: { surface: "legacy", credentials: esignLegacyCredentials("tok") },
        baseUrl: "https://na1.fusion.foxit.com",
      }),
    ).toThrow(FoxitSurfaceError);
  });

  it("names both halves of the mismatch so the fix is obvious", () => {
    expect(() =>
      assertSurfacePairing("legacy", "https://na1.foxitesign.foxit.com", "/esign/api/v1"),
    ).toThrow(/Tomcat 404/);
  });

  it("reads an HTML 404 on an eSign path as a surface mismatch, not a missing route", async () => {
    const client = new FoxitESignClient({
      auth: { surface: "gateway", credentials: esignCredentials("cid", "secret") },
      fetchImpl: fakeFetch({
        status: 404,
        rawBody: TOMCAT_404,
        headers: { "content-type": "text/html" },
      }),
    });
    await expect(client.createFolder(request())).rejects.toBeInstanceOf(FoxitSurfaceError);
  });
});

describe("createfolder", () => {
  it("sends one call with sendNow, a share url, and header auth", async () => {
    const fake = fakeFetch({ body: createFolder });
    const client = new FoxitESignClient({
      auth: { surface: "gateway", credentials: esignCredentials("cid-esign", "secret-esign") },
      fetchImpl: fake,
    });

    const created = await client.createFolder(request());

    expect(fake.calls).toHaveLength(1);
    expect(fake.last().pathname).toBe("/esign/api/v1/createfolder");
    expect(fake.last().headers.get("client_id")).toBe("cid-esign");
    expect(fake.last().body).toMatchObject({
      sendNow: true,
      inputType: "url",
      fileUrls: ["https://na1.fusion.foxit.com/pdf-services/share/8f2c1d9a4b6e"],
    });
    expect(created.folderId).toBe(createFolder.folderId);
  });

  it("passes the embedded session URL through verbatim, legacy host and all", async () => {
    const client = new FoxitESignClient({
      auth: { surface: "gateway", credentials: esignCredentials("cid", "secret") },
      fetchImpl: fakeFetch({ body: createFolder }),
    });

    const created = await client.createFolder(
      request({
        createEmbeddedSigningSession: true,
        embeddedSignersEmailIds: ["principal@example.com"],
      }),
    );

    const url = created.embeddedSigningSessions[0].embeddedSessionURL;
    expect(url).toBe(createFolder.embeddedSigningSessions[0].embeddedSessionURL);
    // Called through the gateway, answered with the legacy host. Rewriting it
    // breaks signing silently, so nothing rewrites it.
    expect(new URL(url).host).toBe("na1.foxitesign.foxit.com");
    expect(new URL(url).host).not.toBe(new URL(client.baseUrl).host);
  });

  it("refuses a folder that came back without a folderId", async () => {
    const client = new FoxitESignClient({
      auth: { surface: "gateway", credentials: esignCredentials("cid", "secret") },
      fetchImpl: fakeFetch({ body: { status: "OUT_FOR_SIGNATURE" } }),
    });
    await expect(client.createFolder(request())).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });

  it("surfaces a gateway 401 as an auth failure detected from the status", async () => {
    const client = new FoxitESignClient({
      auth: { surface: "gateway", credentials: esignCredentials("cid", "wrong") },
      fetchImpl: fakeFetch({ status: 401, body: gateway401 }),
    });
    const error = await client.createFolder(request()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FoxitAuthError);
    expect((error as FoxitAuthError).detectedFrom).toBe("status");
  });
});

describe("the legacy host's 200-on-failure convention", () => {
  it("detects the failure from the body, because the status says 200", async () => {
    const fake = fakeFetch({ status: 200, body: legacyAuthError });
    const client = new FoxitESignClient({
      auth: { surface: "legacy", credentials: esignLegacyCredentials("stale-token") },
      fetchImpl: fake,
    });

    const error = await client.createFolder(request()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FoxitAuthError);
    expect((error as FoxitAuthError).status).toBe(200);
    expect((error as FoxitAuthError).detectedFrom).toBe("body");
    expect((error as FoxitAuthError).message).toContain("Authentication failed");
  });

  it("uses the legacy prefix and a bearer token resolved per request", async () => {
    const tokens = ["token-1", "token-2"];
    const fake = fakeFetch({ body: createFolder });
    const client = new FoxitESignClient({
      auth: {
        surface: "legacy",
        credentials: esignLegacyCredentials(() => tokens.shift() ?? "exhausted"),
      },
      fetchImpl: fake,
    });

    await client.createFolder(request());
    await client.createFolder(request());

    expect(fake.nth(0).pathname).toBe("/api/v1/createfolder");
    expect(fake.nth(0).headers.get("authorization")).toBe("Bearer token-1");
    expect(fake.nth(1).headers.get("authorization")).toBe("Bearer token-2");
  });
});

describe("field validation", () => {
  it("rejects a field missing a required key rather than letting it vanish", () => {
    const incomplete = { ...SIGNATURE_FIELD } as Partial<ESignField>;
    delete incomplete.height;
    const error = catchThrown(() => validateFields([incomplete as ESignField], 1));

    expect(error).toBeInstanceOf(FoxitFieldError);
    expect((error as FoxitFieldError).missingKeys).toEqual(["height"]);
    expect((error as FoxitFieldError).fieldIndex).toBe(0);
  });

  it("treats a zero index as the 0-based mistake it is", () => {
    expect(() => validateFields([{ ...SIGNATURE_FIELD, pageNumber: 0 }], 1)).toThrow(
      /1-based/,
    );
  });

  it("rejects a field pointing at a party that has no signer", () => {
    expect(() => validateFields([{ ...SIGNATURE_FIELD, party: 2 }], 1)).toThrow(
      FoxitFieldError,
    );
  });

  it("accepts a complete field", () => {
    expect(() => validateFields([SIGNATURE_FIELD], 1)).not.toThrow();
  });
});

describe("request validation", () => {
  it("refuses an envelope with no signers", () => {
    expect(() => assertSendableRequest(request({ signers: [] }))).toThrow(/no signers/);
  });

  it('refuses inputType "url" with no fileUrls', () => {
    expect(() => assertSendableRequest(request({ fileUrls: [] }))).toThrow(/fileUrls/);
  });

  it("refuses base64 input whose names and bodies do not line up", () => {
    expect(() =>
      assertSendableRequest(
        request({
          inputType: "base64",
          fileUrls: undefined,
          base64FileString: ["AAA", "BBB"],
          fileNames: ["one.pdf"],
        }),
      ),
    ).toThrow(/same length/);
  });

  it("refuses an embedded session with nobody to embed", () => {
    expect(() =>
      assertSendableRequest(request({ createEmbeddedSigningSession: true })),
    ).toThrow(/embeddedSignersEmailIds/);
  });

  it("refuses an embedded signer who is not one of the signers", () => {
    expect(() =>
      assertSendableRequest(
        request({
          createEmbeddedSigningSession: true,
          embeddedSignersEmailIds: ["someone.else@example.com"],
        }),
      ),
    ).toThrow(/not one of the signers/);
  });
});

describe("folder status", () => {
  it("counts EXECUTED as completion, and OUT_FOR_SIGNATURE as not", async () => {
    const fake = routedFetch({
      "GET /esign/api/v1/getfolderstatus": [{ body: folderOut }, { body: folderCompleted }],
    });
    const client = new FoxitESignClient({
      auth: { surface: "gateway", credentials: esignCredentials("cid", "secret") },
      fetchImpl: fake,
    });

    expect(await client.getFolderStatus("folder_01HZWRIT0001")).toMatchObject({
      completed: false,
      status: "OUT_FOR_SIGNATURE",
    });
    expect(await client.getFolderStatus("folder_01HZWRIT0001")).toMatchObject({
      completed: true,
      completedAt: folderCompleted.completedDate,
    });
    expect(fake.nth(0).query.get("folderId")).toBe("folder_01HZWRIT0001");
  });

  it("recognises every spelling of done and nothing else", () => {
    expect(isCompletedStatus("completed")).toBe(true);
    expect(isCompletedStatus(" EXECUTED ")).toBe(true);
    expect(isCompletedStatus("OUT_FOR_SIGNATURE")).toBe(false);
    expect(isCompletedStatus("DECLINED")).toBe(false);
  });
});

describe("completion archive", () => {
  it("splits the ZIP into the instrument and the certificate", async () => {
    const zip = await completionArchive();
    const fake = routedFetch({
      "GET /esign/api/v1/downloadfolderdocuments": {
        bytes: zip,
        headers: { "content-type": "application/zip" },
      },
    });
    const client = new FoxitESignClient({
      auth: { surface: "gateway", credentials: esignCredentials("cid", "secret") },
      fetchImpl: fake,
    });

    const contents = await client.downloadCompleted("folder_01HZWRIT0001");

    expect(contents.documents.map((doc) => doc.fileName)).toEqual([
      "writ-of-authority-signed.pdf",
    ]);
    expect(contents.certificate?.fileName).toBe("Certificate Of Completion.pdf");
    expect(contents.documents[0].bytes).toEqual(signedPdf({ covered: true }));
    expect(contents.entryNames).toHaveLength(2);
  });

  it("reports no certificate rather than mislabelling a document as one", async () => {
    const zip = await completionArchive([
      { name: "writ-signed.pdf", bytes: signedPdf({ covered: true }) },
    ]);
    const contents = await unpackCompletedFolder(zip);

    expect(contents.certificate).toBeNull();
    expect(contents.documents).toHaveLength(1);
  });

  it("says so when the download was not a ZIP at all", async () => {
    await expect(unpackCompletedFolder(draftPdf())).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });
});

function catchThrown(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (thrown) {
    return thrown;
  }
}
