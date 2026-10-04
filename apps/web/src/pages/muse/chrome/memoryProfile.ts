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

const IRREGULAR_VERB: Record<string, string> = {
  is: "are",
  was: "were",
  has: "have",
  does: "do",
  goes: "go",
  isn: "aren",
  doesn: "don",
  hasn: "haven",
  wasn: "weren",
};

function secondPersonVerb(verb: string): string {
  const lower = verb.toLowerCase();
  const irregular = IRREGULAR_VERB[lower];
  if (irregular) return irregular;
  if (/(ch|sh|ss|x|z)es$/.test(lower)) return lower.slice(0, -2);
  if (/[^aeiou]ies$/.test(lower)) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1);
  return lower;
}

const USER_POSSESSIVE = /^(?:the\s+)?user[’']s\s+/i;
const USER_SUBJECT = /^(?:the\s+)?user\s+([A-Za-z]+)(?:([’']t)\b)?/i;

/**
 * The Memory Profile is written about the person in the third person ("The user's
 * favourite fruit is mango."). The person reads it, so show it to them in second person.
 * A deterministic, display-only rewrite of the common leading "The user …" / "User …"
 * forms; anything else, and the stored data, is left untouched.
 */
export function addressMemoryItem(item: string): string {
  if (USER_POSSESSIVE.test(item)) return item.replace(USER_POSSESSIVE, "Your ");
  const match = USER_SUBJECT.exec(item);
  if (!match) return addressMidSentence(item);
  const [whole, verb = "", contraction] = match;
  const converted = secondPersonVerb(verb);
  const rest = item.slice(whole.length);
  let result = `You ${converted}${contraction ?? ""}${rest}`;
  // Fix "and is" (or similar third-person verbs) after "You are" → "and are"
  if (converted === "are") {
    result = result.replace(/and is\b/gi, "and are");
    result = result.replace(/and has\b/gi, "and have");
    result = result.replace(/and does\b/gi, "and do");
    result = result.replace(/and was\b/gi, "and were");
  }
  return result;
}

/** "This month the user is focused on X" → "This month you're focused on X". */
function addressMidSentence(item: string): string {
  return item
    .replace(/\bthe user's\b/gi, "your")
    .replace(/\bthe user is\b/gi, "you're")
    .replace(/\bthe user has\b/gi, "you have")
    .replace(/\bthe user was\b/gi, "you were")
    .replace(/\bthe user\b/gi, "you");
}
