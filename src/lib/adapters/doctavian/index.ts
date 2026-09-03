export {
  DoctavianClient,
  areaForPath,
  assertPathInArea,
  defaultDoctavianBaseUrl,
} from "./client";
export {
  DOCTAVIAN_CLIENT_ID,
  DOCTAVIAN_DEMO_BASE_URL,
  DOCTAVIAN_SCOPE,
  DOCTAVIAN_TOKEN_PATH,
  doctavianTokenUrl,
  refreshAccessToken,
} from "./auth";
export type { DoctavianTokenSet, RefreshAccessTokenInput } from "./auth";
export type {
  RunGenerationFlowInput,
  RunGenerationFlowResult,
} from "./client";
export {
  DoctavianApiError,
  DoctavianKeyScopeError,
  DoctavianResponseError,
} from "./errors";
export * from "./types";
// `./env` is deliberately not re-exported: it reads the filesystem, so pulling
// it into the barrel would drag `node:fs` into any browser bundle that imports
// this module. Import it directly from Node-only code.
export { sampleWrit } from "./sample-writ";
export { buildWritData, clauseRef } from "./writ-data";
export type {
  BuildWritDataOptions,
  WritGrantRow,
  WritLimitRow,
  WritRow,
  WritTemplateData,
} from "./writ-data";
export {
  WRIT_CONDITIONS,
  WRIT_EXPRESSIONS,
  buildWritTemplateDocument,
  buildWritTemplateDocx,
  expr,
  field,
  loopField,
  loopRef,
  mdocRepeaterClose,
  mdocRepeaterOpen,
  mdocText,
  writTemplateBlocks,
  writTemplateSummaryRows,
  writTemplateText,
} from "./writ-template";
export type { BlockStyle, TemplateBlock } from "./writ-template";
export { emitWritTemplate } from "./build-template";
