import { describe, expect, it } from "vitest";

import { documentHash } from "../../src/lib/core/bytes";
import type { SigningRequest } from "../../src/lib/service/ports";
import { FoxitApprovalRequiredError } from "../../src/lib/adapters/foxit/errors";
import { FoxitESignClient } from "../../src/lib/adapters/foxit/esign";
import { FoxitPdfServicesClient } from "../../src/lib/adapters/foxit/pdf-services";
import {
  FoxitSignatureService,
  InMemoryApprovalRegistry,
  inspectPdfSignature,
} from "../../src/lib/adapters/foxit/signature-service";
import {
  esignCredentials,
  pdfServicesCredentials,
} from "../../src/lib/adapters/foxit/types";
import {
  completionArchive,
  draftPdf,
  signedPdf,
  unsignedPdf,
} from "../fixtures/foxit/artefacts";
import { routedFetch, type FakeFetch, type Responder } from "../fixtures/foxit/fake-fetch";

import createFolder from "../fixtures/foxit/create-folder.json";
import folderCompleted from "../fixtures/foxit/folder-status-completed.json";
import folderOut from "../fixtures/foxit/folder-status-out-for-signature.json";
import shareLink from "../fixtures/foxit/share-link.json";
import upload from "../fixtures/foxit/upload.json";

const DRAFT = draftPdf("writ of authority for ops-agent");
const CLOCK = () => new Date("2026-09-02T09:00:00.000Z");

const SIGNING_REQUEST: SigningRequest = {
  document: {
    reference: "urn:doctavian:writ:0001",
    bytes: DRAFT,
    contentType: "application/pdf",
  },
  signerEmail: "principal@example.com",
  signerName: "Ada Lovelace",
  subject: "Writ of authority for ops-agent",
};

function service(
  routes: Record<string, Responder>,
  options: { approvals?: InMemoryApprovalRegistry | null; useAcroFields?: boolean } = {},
): { signatures: FoxitSignatureService; fake: FakeFetch } {
  const fake = routedFetch(routes);
  const pdf = new FoxitPdfServicesClient({
    credentials: pdfServicesCredentials("cid-pdf", "secret-pdf"),
    fetchImpl: fake,
    sleep: async () => {},
  });
  const esign = new FoxitESignClient({
    auth: { surface: "gateway", credentials: esignCredentials("cid-esign", "secret-esign") },
    fetchImpl: fake,
  });
  return {
    fake,
    signatures: new FoxitSignatureService({
      pdf,
      esign,
      approvals: options.approvals ?? null,
      useAcroFields: options.useAcroFields,
      clock: CLOCK,
    }),
  };
}

const SEND_ROUTES: Record<string, Responder> = {
  "POST /pdf-services/api/documents/upload": { body: upload },
  "POST /pdf-services/api/documents/*": { body: shareLink },
  "POST /esign/api/v1/folders/createfolder": { body: createFolder },
};

describe("requestSignature", () => {
  it("publishes the draft, then fires exactly one createfolder", async () => {
    const { signatures, fake } = service(SEND_ROUTES);
    const session = await signatures.requestSignature(SIGNING_REQUEST);

    expect(fake.paths()).toEqual([
      "/pdf-services/api/documents/upload",
      `/pdf-services/api/documents/${upload.documentId}/create-share-link`,
      "/esign/api/v1/folders/createfolder",
    ]);
    expect(session.envelopeId).toBe(createFolder.folderId);
    expect(session.signingUrl).toBe(
      createFolder.embeddedSigningSessions[0].embeddedSessionURL,
    );
    expect(session.expiresAt).toBe("2026-09-03T09:00:00.000Z");
  });

  it("sends the share link as fileUrls and asks for an embedded session", async () => {
    const { signatures, fake } = service(SEND_ROUTES);
    await signatures.requestSignature(SIGNING_REQUEST);

    expect(fake.last().body).toMatchObject({
      sendNow: true,
      inputType: "url",
      fileUrls: [shareLink.url],
      createEmbeddedSigningSession: true,
      embeddedSignersEmailIds: ["principal@example.com"],
      signers: [{ emailId: "principal@example.com", firstName: "Ada", lastName: "Lovelace", party: 1 }],
    });
  });

  it("places default fields that are complete and 1-based", async () => {
    const { signatures, fake } = service(SEND_ROUTES);
    await signatures.requestSignature(SIGNING_REQUEST);

    const fields = (fake.last().body as { fields: Record<string, unknown>[] }).fields;
    expect(fields).toHaveLength(2);
    for (const field of fields) {
      expect(field).toMatchObject({ documentNumber: 1, pageNumber: 1, party: 1 });
      for (const key of ["type", "x", "y", "width", "height"]) {
        expect(field[key]).toBeDefined();
      }
    }
  });

  it("binds to existing AcroForm fields instead, when asked", async () => {
    const { signatures, fake } = service(SEND_ROUTES, { useAcroFields: true });
    await signatures.requestSignature(SIGNING_REQUEST);

    const body = fake.last().body as Record<string, unknown>;
    expect(body.processAcroFields).toBe(true);
    expect(body.fields).toBeUndefined();
  });

  it("refuses a folder that came back with no session URL to send a human to", async () => {
    const { signatures } = service({
      ...SEND_ROUTES,
      "POST /esign/api/v1/folders/createfolder": {
        body: { folderId: "folder_x", embeddedSigningSessions: [] },
      },
    });
    await expect(signatures.requestSignature(SIGNING_REQUEST)).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });
});

describe("the approval gate is bound to bytes", () => {
  it("sends nothing at all when no human approved these bytes", async () => {
    const approvals = new InMemoryApprovalRegistry();
    const { signatures, fake } = service(SEND_ROUTES, { approvals });

    const error = await signatures
      .requestSignature(SIGNING_REQUEST)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FoxitApprovalRequiredError);
    expect((error as FoxitApprovalRequiredError).documentHash).toBe(documentHash(DRAFT));
    // The point of a gate in front of eSign: not one request left the process.
    expect(fake.calls).toHaveLength(0);
  });

  it("sends the approved share link rather than re-uploading the file", async () => {
    const approvals = new InMemoryApprovalRegistry();
    approvals.approve(DRAFT, {
      shareUrl: "https://na1.fusion.foxit.com/pdf-services/share/approved-copy",
      approvedBy: "principal@example.com",
      approvedAt: "2026-09-02T08:59:00.000Z",
    });
    const { signatures, fake } = service(SEND_ROUTES, { approvals });

    await signatures.requestSignature(SIGNING_REQUEST);

    expect(fake.paths()).toEqual(["/esign/api/v1/folders/createfolder"]);
    expect(fake.last().body).toMatchObject({
      fileUrls: ["https://na1.fusion.foxit.com/pdf-services/share/approved-copy"],
    });
  });

  it("revokes the approval when a single byte of the writ changes", async () => {
    const approvals = new InMemoryApprovalRegistry();
    approvals.approve(DRAFT, {
      shareUrl: "https://na1.fusion.foxit.com/pdf-services/share/approved-copy",
      approvedBy: "principal@example.com",
      approvedAt: "2026-09-02T08:59:00.000Z",
    });
    const { signatures, fake } = service(SEND_ROUTES, { approvals });

    const tampered = new Uint8Array(DRAFT);
    tampered[tampered.length - 4] ^= 0x01;

    await expect(
      signatures.requestSignature({
        ...SIGNING_REQUEST,
        document: { ...SIGNING_REQUEST.document, bytes: tampered },
      }),
    ).rejects.toBeInstanceOf(FoxitApprovalRequiredError);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("fetchCompleted", () => {
  it("returns null and downloads nothing while a human has not finished", async () => {
    const { signatures, fake } = service({
      "GET /esign/api/v1/getfolderstatus": { body: folderOut },
    });

    expect(await signatures.fetchCompleted("folder_01HZWRIT0001")).toBeNull();
    expect(fake.paths()).toEqual(["/esign/api/v1/getfolderstatus"]);
  });

  it("hashes the bytes it was handed and returns the certificate from the same ZIP", async () => {
    const zip = await completionArchive();
    const { signatures } = service({
      "GET /esign/api/v1/getfolderstatus": { body: folderCompleted },
      "GET /esign/api/v1/downloadfolderdocuments": {
        bytes: zip,
        headers: { "content-type": "application/zip" },
      },
    });

    const signed = await signatures.fetchCompleted("folder_01HZWRIT0001");

    expect(signed).not.toBeNull();
    expect(signed?.envelopeId).toBe("folder_01HZWRIT0001");
    expect(signed?.bytes).toEqual(signedPdf({ covered: true }));
    expect(signed?.sha256).toBe(documentHash(signedPdf({ covered: true })));
    expect(signed?.signedAt).toBe(folderCompleted.completedDate);
    expect(signed?.certificate).toBeDefined();
  });

  it("refuses an archive that reports completion but holds no document", async () => {
    const zip = await completionArchive([
      { name: "Certificate Of Completion.pdf", bytes: draftPdf("cert") },
    ]);
    const { signatures } = service({
      "GET /esign/api/v1/getfolderstatus": { body: folderCompleted },
      "GET /esign/api/v1/downloadfolderdocuments": { bytes: zip },
    });

    await expect(signatures.fetchCompleted("folder_01HZWRIT0001")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });
});

describe("verifySignature", () => {
  it("reports a signature whose ByteRange covers the whole document", async () => {
    const { signatures } = service({});
    const result = await signatures.verifySignature(signedPdf({ covered: true }));

    expect(result.verified).toBe(true);
    expect(result.method).toContain("byterange-covers-document");
    expect(result.profile).toBe("adbe.pkcs7.detached");
  });

  it("refuses a ByteRange that stops short of the end of the file", async () => {
    const result = inspectPdfSignature(signedPdf({ covered: false }));

    expect(result.verified).toBe(false);
    expect(result.method).toContain("leaves-document-uncovered");
    // The dictionary is genuinely there; it just does not cover everything.
    expect(result.profile).toBe("adbe.pkcs7.detached");
  });

  it("reports no signature at all for a plain PDF", () => {
    const result = inspectPdfSignature(unsignedPdf());

    expect(result.verified).toBe(false);
    expect(result.method).toContain("absent");
    expect(result.profile).toBeUndefined();
  });
});
