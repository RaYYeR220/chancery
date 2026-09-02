export { DoctavianClient, areaForPath, assertPathInArea } from "./client";
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
