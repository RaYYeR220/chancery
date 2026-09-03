/**
 * `SignatureService`, backed by Foxit.
 *
 * There is no bridge here worth the name, because `FoxitSignatureService`
 * already implements the port exactly. What this file adds is the one thing a
 * caller cannot get wrong quietly: the two clients behind it take two different
 * piles of secret, the transport cannot tell them apart, and the type system
 * only stops the mix-up if the credentials are branded at the point they are
 * built. So they are built here, once, and the reversible half is constructed
 * from `FOXIT_CLIENT_*` while the irreversible half is constructed from
 * `FOXIT_ESIGN_CLIENT_*`.
 *
 * `approvals` has no default. `FoxitSignatureService` treats `null` as an
 * explicit opt-out of the bytes-bound human approval gate, and a gate that
 * defaults on is a gate nobody knows is there — so the caller states which it
 * wants and the reason travels with the call site.
 */

import {
  esignCredentials,
  FoxitESignClient,
  FoxitPdfServicesClient,
  FoxitSignatureService,
  pdfServicesCredentials,
  type ApprovalRegistry,
  type FetchLike,
} from "../../adapters/foxit";
import type { FoxitSettings } from "../config";

export {
  FoxitSignatureService,
  InMemoryApprovalRegistry,
  inspectPdfSignature,
} from "../../adapters/foxit";
export type { ApprovalRecord, ApprovalRegistry } from "../../adapters/foxit";

export interface FoxitSignatureServiceFactoryOptions {
  settings: FoxitSettings;
  /**
   * `null` opts out of the approval gate. Say which; there is no default,
   * because both answers are defensible and only one of them is what you meant.
   */
  approvals: ApprovalRegistry | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Bind the AcroForm fields already in the PDF instead of placing coordinates. */
  useAcroFields?: boolean;
  clock?: () => Date;
}

export function createFoxitSignatureService(
  options: FoxitSignatureServiceFactoryOptions,
): FoxitSignatureService {
  const { settings } = options;

  const pdf = new FoxitPdfServicesClient({
    credentials: pdfServicesCredentials(settings.pdfClientId, settings.pdfClientSecret),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const esign = new FoxitESignClient({
    auth: {
      surface: "gateway",
      credentials: esignCredentials(settings.esignClientId, settings.esignClientSecret),
    },
    // Only passed when set: the surface already pins the host it answers on, and
    // an override that disagrees with the prefix is rejected in the constructor.
    ...(settings.esignBaseUrl === null ? {} : { baseUrl: settings.esignBaseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  return new FoxitSignatureService({
    pdf,
    esign,
    approvals: options.approvals,
    ...(options.useAcroFields === undefined ? {} : { useAcroFields: options.useAcroFields }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}
