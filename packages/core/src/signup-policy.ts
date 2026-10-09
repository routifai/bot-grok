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

/** The domain after the last `@`, lower-cased; empty when there is none. */
export function emailDomainOf(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at < 0 ? "" : normalized.slice(at + 1);
}

/** Does the address match an exact entry or an `@domain` entry? An empty list matches nothing. */
export function emailAllowed(email: string, allowlist: string[]): boolean {
  const normalized = email.trim().toLowerCase();
  const domain = emailDomainOf(normalized);
  return allowlist.some((entry) => {
    if (entry.startsWith("@")) return domain === entry.slice(1);
    return normalized === entry;
  });
}

export function emailDomainAllowed(email: string, domains: string[]): boolean {
  const domain = emailDomainOf(email);
  return domain !== "" && domains.includes(domain);
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
 * Whether an address may create an account, and in what state. `approval` always creates a
 * pending account: the owner seat is claimed separately (see the auth session hook), never by
 * being first through this door.
 */
export function admitSignup(policy: SignupPolicy, email: string): SignupAdmission {
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
      return { ok: true, status: "pending" };
    case "open":
      return { ok: true, status: "active" };
  }
}

/**
 * Modes that let people in on their own need a way to prove the mailbox. `approval` does not: an
 * admin vets every account, so a deployment can run it before it has a mail domain.
 */
export function signupNeedsEmailDelivery(mode: SignupMode): boolean {
  return mode !== "closed" && mode !== "approval";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A production process that is reachable beyond this machine. A production build served only on
 * loopback (a local Docker install) is a personal install, not a hosted one. Hosted requires
 * NODE_ENV=production.
 */
export function isHostedDeployment(env: {
  nodeEnv?: string | undefined;
  webOrigin: string;
}): boolean {
  if (env.nodeEnv !== "production") return false;
  try {
    return !LOOPBACK_HOSTS.has(new URL(env.webOrigin).hostname);
  } catch {
    return true;
  }
}

/**
 * May an account whose mailbox was never proved hold access? Only where nothing can send mail and
 * either an admin vets every account (approval) or a personal install opted in. One rule, used by
 * the session lookup, background jobs, messaging, streams and the screen proxy.
 */
export function unverifiedAccessAllowed(input: {
  hasEmailDelivery: boolean;
  mode: SignupMode | undefined;
  devFlagAllowed: boolean;
}): boolean {
  if (input.hasEmailDelivery) return false;
  return input.devFlagAllowed || input.mode === "approval";
}

/**
 * Address used only as a rate-limit key: lower-case, with a `+tag` dropped from the local part so
 * one mailbox cannot be multiplied into many counters. Never used to identify a person.
 */
export function quotaEmailKey(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at < 0) return normalized;
  const local = normalized.slice(0, at).split("+")[0] ?? "";
  return `${local}${normalized.slice(at)}`;
}

/** The /24 (IPv4) or /64 (IPv6) a client IP belongs to; "unknown" when there is none. */
export function ipPrefix(ip: string | null | undefined): string {
  if (!ip) return "unknown";
  if (ip.includes(":")) {
    const groups = ip.toLowerCase().split("::")[0]?.split(":") ?? [];
    return `${groups.slice(0, 4).join(":")}::/64`;
  }
  const parts = ip.split(".");
  return parts.length === 4 ? `${parts.slice(0, 3).join(".")}.0/24` : "unknown";
}

/** Whether any mail provider is configured for this process (shared by the API and the worker). */
export function emailDeliveryConfigured(source: {
  SMTP_URL?: string | undefined;
  EMAIL_API_URL?: string | undefined;
  EMAIL_EMULATOR?: string | undefined;
  NODE_ENV?: string | undefined;
}): boolean {
  if (source.SMTP_URL?.trim() || source.EMAIL_API_URL?.trim()) return true;
  return (
    source.NODE_ENV !== "production" &&
    (source.EMAIL_EMULATOR === "true" ||
      (source.NODE_ENV === "development" && source.EMAIL_EMULATOR !== "false"))
  );
}
