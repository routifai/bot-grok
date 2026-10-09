// The artifacts capability's public entry point: what the capabilities built on it (apps, sheets)
// may use.
export {
  type EngineArtifactsDeps,
  emailOf,
  engineGetArtifact,
  notFound,
  toArtifact,
  toPublish,
} from "./service.js";
