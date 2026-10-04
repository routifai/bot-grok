/** Readable text for one Activity Step's `detail`: what went in and what came out. */
export interface StepDetailText {
  input: string | null;
  output: string | null;
}

const MAX_CHARS = 4000;

function clip(text: string): string {
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}

/** Pretty-prints JSON held in a string; leaves any other text as it is. */
function readable(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object")
        return clip(JSON.stringify(parsed, null, 2));
    } catch {
      // Not JSON: plain text.
    }
    return clip(value);
  }
  return clip(JSON.stringify(value, null, 2));
}

function field(source: unknown, key: string): unknown {
  return source !== null && typeof source === "object"
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

export function stepDetailText(detail: Record<string, unknown> | null | undefined): StepDetailText {
  if (!detail) return { input: null, output: null };
  const call = detail.call;
  const result = detail.result;
  if (call === undefined && result === undefined) {
    return { input: readable(detail), output: null };
  }
  return {
    input: readable(field(call, "args") ?? field(call, "arguments") ?? call),
    output: readable(field(result, "content") ?? field(result, "output") ?? result),
  };
}
