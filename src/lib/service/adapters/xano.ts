/**
 * `WritStore`, backed by Xano — or by memory.
 *
 * Neither implementation needs a bridge: both already implement the port, and
 * both raise the same typed errors from the same module, so code that handles a
 * `NOT_FOUND` against one handles it unchanged against the other. Re-exporting
 * them here keeps every port reachable from one directory, so "which
 * implementation is wired for which seam" is answerable by reading one folder.
 *
 * `MemoryWritStore` is not a mock. It builds its chain with the same
 * `appendEntry` the HTTP store verifies against, so a ledger built in memory
 * passes `verifyChain` for the same reason one built in Xano does. What it does
 * not have is durability or an authenticated account, and the status report says
 * so rather than leaving it to be discovered after a restart.
 */

import {
  MemoryWritStore,
  XanoWritStore,
  type FetchLike,
  type MemoryWritStoreOptions,
  type XanoWritStoreOptions,
} from "../../adapters/xano";
import type { XanoSettings } from "../config";
import type { WritStore } from "../ports";

export {
  MemoryWritStore,
  XanoWritStore,
  XanoError,
  XanoAuthError,
  XanoLedgerError,
  XanoRateLimitError,
  isRateLimited,
  isXanoError,
} from "../../adapters/xano";
export type { MemoryWritStoreOptions, XanoWritStoreOptions } from "../../adapters/xano";

export interface XanoWritStoreFactoryOptions {
  settings: XanoSettings;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export function createXanoWritStore(options: XanoWritStoreFactoryOptions): WritStore {
  return new XanoWritStore({
    baseUrl: options.settings.baseUrl,
    token: options.settings.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

export function createMemoryWritStore(options: MemoryWritStoreOptions = {}): MemoryWritStore {
  return new MemoryWritStore(options);
}
