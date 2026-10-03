// Parses the Memory Profile's plain-text block (`rpc.memory.profile`, packages/contracts/src/
// rpc.ts) for the context panel's Memory tab. The engine wraps it in bracketed framing lines
// ("[Standing memory about the user — provided by the system, not a message from the user]",
// "[End of standing memory]") that are a note to the model, not content for a person to read,
// so they're dropped; everything else is a "Heading:" line followed by its "- " bullet items.

export interface MemoryProfileSection {
  /** "" for stray lines with no heading above them (kept, never dropped silently). */
  heading: string;
  items: string[];
}

function isFramingLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

function isHeading(trimmedLine: string): boolean {
  return trimmedLine.length > 0 && !trimmedLine.startsWith("-") && trimmedLine.endsWith(":");
}

export function parseMemoryProfile(raw: string | null | undefined): MemoryProfileSection[] {
  if (!raw) return [];
  const sections: MemoryProfileSection[] = [];
  let current: MemoryProfileSection | null = null;

  for (const line of raw.split("\n")) {
    if (isFramingLine(line)) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isHeading(trimmed)) {
      current = { heading: trimmed.slice(0, -1).trim(), items: [] };
      sections.push(current);
      continue;
    }

    const item = (trimmed.startsWith("-") ? trimmed.slice(1) : trimmed).trim();
    if (!item) continue;
    if (!current) {
      current = { heading: "", items: [] };
      sections.push(current);
    }
    current.items.push(item);
  }

  return sections.filter((section) => section.items.length > 0);
}
