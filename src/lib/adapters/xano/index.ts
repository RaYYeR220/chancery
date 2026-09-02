/**
 * Xano adapter: the registry, act history, receipts and ledger of record.
 *
 * Two implementations of one port. `XanoWritStore` talks to the deployed
 * XanoScript backend in `repo/xano`; `MemoryWritStore` is the same semantics
 * with no credentials, so the product runs before an instance exists and keeps
 * running if one goes away.
 */

export {
  FREE_TIER_REQUESTS,
  FREE_TIER_WINDOW_MS,
  TOO_MANY_REQUESTS_CODE,
  XanoAuthError,
  XanoError,
  XanoLedgerError,
  XanoRateLimitError,
  isRateLimited,
  isXanoError,
  xanoBodyCode,
  xanoErrorFromResponse,
  type XanoErrorCode,
} from "./errors";

export { MemoryWritStore, type MemoryWritStoreOptions } from "./memory-store";
export { XanoWritStore, type CallOptions, type XanoWritStoreOptions } from "./store";

export {
  actFromWire,
  actToWire,
  grantFromWire,
  grantToWire,
  ledgerEntryFromWire,
  ledgerEntryToWire,
  specFromWire,
  specToWire,
  toIso,
  writFromWire,
} from "./wire";

export type {
  FetchLike,
  WireAct,
  WireAgent,
  WireAuth,
  WireGrant,
  WireLedgerEntry,
  WirePrincipal,
  WireReceipt,
  WireSpec,
  WireTimestamp,
  WireVerification,
  WireWrit,
} from "./types";
