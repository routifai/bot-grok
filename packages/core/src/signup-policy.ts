export const SIGNUP_MODES = ["closed", "invite", "domain", "approval", "open"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** How a deployment admits new accounts; one source of truth in DeploymentSettings. */
export interface SignupPolicy {
  mode: SignupMode;
  /** `invite` mode: addresses (or `@domain` entries) allowed to register. */
  invites: string[];
  /** `domain` mode: email domains allowed to register. */
  domains: string[];
}

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** Domains without a leading `@`, lower-cased and de-duplicated. */
export function parseDomains(raw: string | readonly string[] | undefined): string[] {
  const items = typeof raw === "string" ? raw.split(",") : [...(raw ?? [])];
  return [
    ...new Set(
      items
        .map((item) => item.trim().toLowerCase().replace(/^@/, ""))
        .filter((item) => item.includes(".") && !item.includes("@") && !/\s/.test(item)),
    ),
  ];
}

/** Does the address match an exact entry or an `@domain` entry? An empty list matches nothing. */
export function emailAllowed(email: string, allowlist: string[]): boolean {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@")[1];
  return allowlist.some((entry) => {
    if (entry.startsWith("@")) return domain === entry.slice(1);
    return normalized === entry;
  });
}

export function emailDomainAllowed(email: string, domains: string[]): boolean {
  const domain = email.trim().toLowerCase().split("@")[1];
  return Boolean(domain) && domains.includes(domain!);
}

/** Internal messaging users have no mailbox and cannot authenticate by email. */
export function isMessagingEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith("@messaging.invalid");
}

/** A successful signup with an explicit null token awaits mailbox proof. */
export function signupRequiresEmailVerification(response: unknown): boolean {
  return Boolean(
    response && typeof response === "object" && "token" in response && response.token === null,
  );
}

export function parseSignupMode(raw: string | undefined): SignupMode | undefined {
  const mode = raw?.trim().toLowerCase();
  return SIGNUP_MODES.find((candidate) => candidate === mode);
}

export interface SignupPolicyEnv {
  signupMode?: string | undefined;
  /** Legacy switch: "false" or "0" closes signup when no mode is set. */
  signupsEnabled?: string | undefined;
  signupAllowlist?: string | undefined;
  signupDomains?: string | undefined;
}

/**
 * Seed policy for a deployment that has none stored. An explicit mode wins; otherwise the
 * legacy variables keep their meaning: disabled closes, a non-empty allow-list is an invite
 * list, and nothing set is open signup.
 */
export function signupPolicyFromEnv(input: SignupPolicyEnv): SignupPolicy {
  const invites = parseAllowlist(input.signupAllowlist);
  const closed = input.signupsEnabled === "false" || input.signupsEnabled === "0";
  const mode =
    parseSignupMode(input.signupMode) ??
    (closed ? "closed" : invites.length > 0 ? "invite" : "open");
  return { mode, invites, domains: parseDomains(input.signupDomains) };
}

/**
 * Non-empty SIGNUP_ALLOWLIST replaces the stored invite list on each API start.
 * A blank or unset value does not clear a stored list.
 */
export function signupAllowlistBootUpdate(
  storedAllowlist: string,
  envAllowlist: string | undefined,
  policyInitialized: boolean,
): string | null {
  if (!policyInitialized) return null;
  const next = parseAllowlist(envAllowlist).join(",");
  if (!next) return null;
  if (next === parseAllowlist(storedAllowlist).join(",")) return null;
  return next;
}

export type SignupAdmission =
  | { ok: true; status: "active" | "pending" }
  | { ok: false; message: string };

/**
 * Whether an address may create an account, and in what state. In `approval` mode the very first
 * account of a deployment (no owner yet) is active so someone exists to approve the rest.
 */
export function admitSignup(
  policy: SignupPolicy,
  email: string,
  options: { firstAccount?: boolean } = {},
): SignupAdmission {
  switch (policy.mode) {
    case "closed":
      return { ok: false, message: "Registration is closed" };
    case "invite":
      return emailAllowed(email, policy.invites)
        ? { ok: true, status: "active" }
        : { ok: false, message: "Email is not allowed to register" };
    case "domain":
      return emailDomainAllowed(email, policy.domains)
        ? { ok: true, status: "active" }
        : { ok: false, message: "Email is not allowed to register" };
    case "approval":
      return { ok: true, status: options.firstAccount ? "active" : "pending" };
    case "open":
      return { ok: true, status: "active" };
  }
}

/** Modes that let strangers create accounts need a way to prove the mailbox. */
export function signupNeedsEmailDelivery(mode: SignupMode): boolean {
  return mode !== "closed";
}
