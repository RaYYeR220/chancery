/**
 * One bridge per port, and the stand-in that answers when its vendor is not
 * configured. Nothing in here reaches past a vendor adapter into a vendor API.
 */

export { DoctavianDocumentGenerator, derivedWritId, writFromSpec } from "./doctavian";
export type { DoctavianDocumentGeneratorOptions } from "./doctavian";

export { createFoxitSignatureService, FoxitSignatureService } from "./foxit";
export type { FoxitSignatureServiceFactoryOptions } from "./foxit";

export { NutrientTermsExtractor, projectWrit, toCondition, toLimit } from "./nutrient";
export type { NutrientTermsExtractorOptions } from "./nutrient";

export { NameComDomainRegistry } from "./namecom";
export type { NameComDomainRegistryOptions } from "./namecom";

export { DohWritResolver } from "./resolver";
export type { DohWritResolverOptions } from "./resolver";

export { SerpApiDiligenceService, SUBJECT_FIELDS, toSerpApiSubject } from "./serpapi";

export { createMemoryWritStore, createXanoWritStore, MemoryWritStore, XanoWritStore } from "./xano";
export type { XanoWritStoreFactoryOptions } from "./xano";

export {
  StandInDiligenceService,
  StandInDocumentDesk,
  StandInDomainRegistry,
  StandInWritResolver,
  StandInZone,
  STAND_IN_BANNER,
  STAND_IN_RESOLVER,
} from "./stand-ins";
export type { StandInDocumentDeskOptions } from "./stand-ins";
