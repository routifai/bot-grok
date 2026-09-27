/**
 * Time-of-day greeting for the empty Conversation (docs/muse/DESIGN.md
 * "Conversation"): "Good morning, {name}." — morning 05:00–11:59, afternoon
 * 12:00–17:59, evening otherwise.
 */
export function greetingForHour(hour: number): "Good morning" | "Good afternoon" | "Good evening" {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

export function greetingLead(now: Date, name: string): string {
  const trimmed = name.trim();
  return `${greetingForHour(now.getHours())}${trimmed ? `, ${trimmed}` : ""}.`;
}
