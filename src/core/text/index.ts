export { chunkMarkdown, markdownStructure } from "./chunk.js";
export type { ChunkOptions } from "./chunk.js";
export {
	documentHref,
	documentPath,
	linkName,
	markdownLinks,
	resolveLink,
} from "./links.js";
export { normalizeForSearch } from "./normalize.js";
export { byteOffsetOfIndex, buildByteMap, utf8ByteLength } from "./offsets.js";
export { verifyFragments } from "./verify.js";
export type {
	FragmentViolation,
	FragmentViolationCode,
	VerifyFragmentsOptions,
} from "./verify.js";
