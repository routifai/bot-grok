// The artifacts capability's public entry point: what the capabilities built on it (apps, sheets)
// and the places that draw a file (transcript, Computer panel) may use.
export { ArtifactFileCard } from "./ArtifactFileCard";
export { ArtifactPreview } from "./Artifacts";
export { ArtifactFileCard as ReplyArtifactFileCard } from "./cards/ArtifactFileCard";
export { PanelOverflowMenu } from "./PanelOverflowMenu";
export {
  type ArtifactCardParts,
  type ArtifactExtension,
  type ArtifactInlineArgs,
  type ArtifactPanelArgs,
  type ArtifactPanelParts,
  ArtifactRegistryProvider,
  type ArtifactResultArgs,
  type ArtifactThumbnailArgs,
  type ArtifactViewProps,
  useArtifactCardParts,
  useArtifactExtensions,
  useArtifactPanelParts,
} from "./registry";
