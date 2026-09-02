/**
 * Foxit adapter.
 *
 * Two clients, and the split between them is the argument: `pdf-services` is
 * the reversible half an agent may hold, `esign` is the irreversible half it
 * cannot construct. `agent-surface` is where that becomes a compile error
 * rather than a convention.
 */

export * from "./types";
export * from "./errors";
export {
  FoxitPdfServicesClient,
  FUSION_GATEWAY_BASE_URL,
  PDF_SERVICES_PREFIX,
  DOCUMENT_GENERATION_PREFIX,
  PDF_SERVICES_PATHS,
  REVERSIBLE_PREFIXES,
  ESIGN_PATH_MARKER,
  assertReversiblePath,
  base64ToBytes,
  bytesToBase64,
} from "./pdf-services";
export type {
  AwaitTaskOptions,
  FoxitPdfServicesOptions,
  ShareLinkOptions,
} from "./pdf-services";
export {
  FoxitESignClient,
  ESIGN_SURFACES,
  ESIGN_OPERATIONS,
  REQUIRED_FIELD_KEYS,
  assertSendableRequest,
  assertSurfacePairing,
  isCompletedStatus,
  unpackCompletedFolder,
  validateFields,
} from "./esign";
export type { ESignAuth, ESignOperations, FoxitESignOptions } from "./esign";
export {
  FoxitSignatureService,
  InMemoryApprovalRegistry,
  inspectPdfSignature,
} from "./signature-service";
export type {
  ApprovalRecord,
  ApprovalRegistry,
  FoxitSignatureServiceOptions,
} from "./signature-service";
export {
  AGENT_SURFACE_CANNOT_REACH_ESIGN,
  AGENT_SURFACE_HOLDS_NO_DATA,
  agentSurfaceFrom,
  agentSurfaceMembers,
  createAgentSurface,
  proveESignIsUnreachable,
} from "./agent-surface";
export type {
  AgentSurface,
  AgentSurfaceCanReachESign,
  AgentSurfaceHoldsOnlyFunctions,
  AgentSurfaceOptions,
  ESignRefusalProof,
  RefusalAttempt,
  RefusalOutcome,
  RefusalProbeOptions,
} from "./agent-surface";
export {
  FoxitMcpClient,
  FoxitIrreversibleToolError,
  FOXIT_MCP_ADVERTISED_TOOL_COUNT,
  FOXIT_MCP_SERVER_REPO,
  classifyTool,
  textOf,
} from "./mcp-client";
export type { FoxitMcpClientOptions, FoxitMcpTool, FoxitMcpToolResult } from "./mcp-client";
