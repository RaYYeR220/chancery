import { describe, expect, it } from "vitest";

import {
  FoxitAuthError,
  FoxitError,
  FoxitScopeError,
  FoxitTaskError,
} from "../../src/lib/adapters/foxit/errors";
import {
  FUSION_GATEWAY_BASE_URL,
  FoxitPdfServicesClient,
  PDF_SERVICES_PATHS,
  assertReversiblePath,
  base64ToBytes,
  bytesToBase64,
} from "../../src/lib/adapters/foxit/pdf-services";
import { pdfServicesCredentials, type FetchLike } from "../../src/lib/adapters/foxit/types";
import { draftPdf } from "../fixtures/foxit/artefacts";
import { fakeFetch, routedFetch, type FakeFetch } from "../fixtures/foxit/fake-fetch";

import shareLink from "../fixtures/foxit/share-link.json";
import taskCompleted from "../fixtures/foxit/task-completed.json";
import taskFailed from "../fixtures/foxit/task-failed.json";
import taskProcessing from "../fixtures/foxit/task-processing.json";
import upload from "../fixtures/foxit/upload.json";

const CREDENTIALS = pdfServicesCredentials("cid-pdf", "secret-pdf");

function client(fetchImpl: FakeFetch | FetchLike, sleep = async () => {}): FoxitPdfServicesClient {
  return new FoxitPdfServicesClient({ credentials: CREDENTIALS, fetchImpl, sleep });
}

describe("transport", () => {
  it("authenticates with the gateway's header pair and no bearer token", async () => {
    const fake = fakeFetch({ body: upload });
    await client(fake).upload({ fileName: "writ.pdf", bytes: draftPdf() });

    const call = fake.last();
    expect(call.url.startsWith(FUSION_GATEWAY_BASE_URL)).toBe(true);
    expect(call.headers.get("client_id")).toBe("cid-pdf");
    expect(call.headers.get("client_secret")).toBe("secret-pdf");
    expect(call.headers.get("authorization")).toBeNull();
  });

  it("uploads multipart, since it is the one endpoint that is not JSON", async () => {
    const fake = fakeFetch({ body: upload });
    const result = await client(fake).upload({
      fileName: "writ-of-authority.pdf",
      bytes: draftPdf(),
    });

    expect(result.documentId).toBe(upload.documentId);
    const file = fake.last().form?.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("writ-of-authority.pdf");
    // fetch generates the multipart boundary; a hand-set header would not match.
    expect(fake.last().headers.get("content-type")).toBeNull();
  });

  it("refuses to treat an upload without a documentId as a success", async () => {
    const fake = fakeFetch({ body: { status: "ok" } });
    await expect(client(fake).upload({ fileName: "w.pdf", bytes: draftPdf() })).rejects.toMatchObject(
      { code: "MALFORMED_RESPONSE" },
    );
  });

  it("raises a typed auth error from a gateway 401", async () => {
    const fake = fakeFetch({ status: 401, body: { message: "Invalid client_id" } });
    const error = await client(fake)
      .download("doc-1")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FoxitAuthError);
    expect((error as FoxitAuthError).detectedFrom).toBe("status");
    expect((error as FoxitAuthError).status).toBe(401);
    expect((error as FoxitAuthError).body).toEqual({ message: "Invalid client_id" });
  });

  it('treats a 200 carrying {"result":"error"} as the failure it is', async () => {
    const fake = fakeFetch({ status: 200, body: { result: "error", errorMessage: "no" } });
    const error = await client(fake)
      .createShareLink("doc-1")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FoxitAuthError);
    expect((error as FoxitAuthError).detectedFrom).toBe("body");
    expect((error as FoxitAuthError).status).toBe(200);
  });

  it("does not hand back a JSON error object as though it were downloaded bytes", async () => {
    const fake = fakeFetch({
      status: 200,
      rawBody: JSON.stringify({ result: "error", message: "session expired" }),
      headers: { "content-type": "application/octet-stream" },
    });
    await expect(client(fake).download("doc-1")).rejects.toBeInstanceOf(FoxitAuthError);
  });

  it("reports a timeout as a timeout rather than as a transport failure", async () => {
    const hanging: FetchLike = (_url, init = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const slow = new FoxitPdfServicesClient({
      credentials: CREDENTIALS,
      fetchImpl: hanging,
      timeoutMs: 5,
    });
    await expect(slow.download("doc-1")).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("requires both halves of the credential", () => {
    expect(
      () => new FoxitPdfServicesClient({ credentials: pdfServicesCredentials("cid", "") }),
    ).toThrow(FoxitError);
  });
});

describe("documents", () => {
  it("percent-encodes a document id into a single path segment", async () => {
    const fake = fakeFetch({ bytes: draftPdf() });
    await client(fake).download("../../esign/api/v1/createfolder");

    const { pathname } = fake.last();
    expect(pathname.startsWith("/pdf-services/api/documents/")).toBe(true);
    expect(pathname).not.toContain("/esign/");
    expect(pathname.endsWith("/download")).toBe(true);
  });

  it("returns the share link that is the only bridge to eSign", async () => {
    const fake = fakeFetch({ body: shareLink });
    const link = await client(fake).createShareLink("doc_01HZWRITDRAFT0001", {
      expiresInSeconds: 604_800,
    });

    expect(fake.last().pathname).toBe(
      PDF_SERVICES_PATHS.shareLink("doc_01HZWRITDRAFT0001"),
    );
    expect(fake.last().body).toMatchObject({
      documentId: "doc_01HZWRITDRAFT0001",
      expiresIn: 604_800,
    });
    expect(link.url).toBe(shareLink.url);
    expect(link.expiresAt).toBe(shareLink.expiresAt);
  });

  it("fails loudly when create-share-link answers without a url", async () => {
    const fake = fakeFetch({ body: { documentId: "doc-1" } });
    await expect(client(fake).createShareLink("doc-1")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });
});

describe("document generation", () => {
  it("renders a template and decodes the base64 it hands straight back", async () => {
    const rendered = draftPdf("generated writ");
    const fake = fakeFetch({ body: { base64FileString: bytesToBase64(rendered) } });

    const result = await client(fake).generateDocument({
      base64FileString: bytesToBase64(draftPdf("template")),
      documentValues: { principal: "Acme GmbH" },
      outputFormat: "pdf",
    });

    expect(fake.last().pathname).toBe(PDF_SERVICES_PATHS.generateDocument);
    expect(result.bytes).toEqual(rendered);
  });

  it("round-trips bytes through base64 without Buffer", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe("tasks", () => {
  it("polls a conversion to completion and hands back the produced document", async () => {
    const fake = routedFetch({
      "POST /pdf-services/api/documents/modify/pdf-to-word": { body: taskProcessing },
      "GET /pdf-services/api/tasks/*": [
        { body: taskProcessing },
        { body: taskProcessing },
        { body: taskCompleted },
      ],
    });
    const pdf = client(fake);
    const document = await pdf.runToDocument(pdf.convertPdfTo("word", "doc-1"));

    expect(document.documentId).toBe(taskCompleted.resultDocumentId);
    expect(fake.paths().filter((path) => path.startsWith("/pdf-services/api/tasks/"))).toHaveLength(
      3,
    );
  });

  it("throws on a FAILED task instead of resolving with a null document", async () => {
    const fake = routedFetch({
      "POST /pdf-services/api/documents/modify/pdf-compress": { body: taskProcessing },
      "GET /pdf-services/api/tasks/*": { body: taskFailed },
    });
    const pdf = client(fake);
    const error = await pdf
      .runToDocument(pdf.compress("doc-1"))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FoxitTaskError);
    expect((error as FoxitTaskError).taskStatus).toBe("FAILED");
    expect((error as FoxitTaskError).message).toContain("password protected");
  });

  it("treats an unrecognised status as still running, never as done", async () => {
    const fake = routedFetch({
      "GET /pdf-services/api/tasks/*": { body: { taskId: "t1", status: "WARMING_UP" } },
    });
    const task = await client(fake).getTask("t1");
    expect(task.status).toBe("PROCESSING");
  });

  it("gives up on a task that never leaves PENDING", async () => {
    const fake = routedFetch({ "GET /pdf-services/api/tasks/*": { body: taskProcessing } });
    await expect(
      client(fake).awaitTask("t1", { timeoutMs: 0, pollIntervalMs: 0 }),
    ).rejects.toBeInstanceOf(FoxitTaskError);
  });
});

describe("path scope", () => {
  it("permits only PDF Services and Document Generation", () => {
    expect(() => assertReversiblePath(PDF_SERVICES_PATHS.upload)).not.toThrow();
    expect(() => assertReversiblePath(PDF_SERVICES_PATHS.generateDocument)).not.toThrow();
  });

  it("refuses an eSign path however it is reached", () => {
    expect(() => assertReversiblePath("/esign/api/v1/createfolder")).toThrow(FoxitScopeError);
    expect(() => assertReversiblePath("/pdf-services/api/../esign/api/v1/createfolder")).toThrow(
      FoxitScopeError,
    );
    expect(() => assertReversiblePath("/api/v1/createfolder")).toThrow(FoxitScopeError);
  });
});
