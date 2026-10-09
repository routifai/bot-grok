import { emailDomainOf, parseDomains } from "@nova/core";
import { APIError } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";

/** The one provider id every OIDC sign-in uses; the button label comes from `name`. */
export const OIDC_PROVIDER_ID = "sso";

/**
 * A single generic OIDC connection (any issuer with discovery): Google Workspace, Microsoft
 * Entra, Okta, Keycloak. Google's `hd` and Entra's tenant semantics are derived from the issuer.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Button label; defaults from the issuer. */
  name?: string;
  /** Verified email domains allowed to sign in; empty allows any the provider vouches for. */
  allowedDomains?: string[];
}

const ENTRA_HOST = "login.microsoftonline.com";
const GOOGLE_ISSUER = "https://accounts.google.com";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MULTI_TENANT = new Set(["common", "organizations", "consumers"]);

/** The Entra tenant GUID in an issuer, undefined for other issuers. Throws for multi-tenant ones. */
export function entraTenantOf(issuer: string): string | undefined {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return undefined;
  }
  if (url.hostname !== ENTRA_HOST) return undefined;
  const tenant = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  if (MULTI_TENANT.has(tenant) || !GUID.test(tenant)) {
    throw new Error(
      "AUTH_OIDC_ISSUER for Microsoft must name one tenant by GUID, not common, organizations or consumers",
    );
  }
  return tenant;
}

/** Startup validation: throws a clear, admin-facing error for an unsafe connection. */
export function assertOidcConfig(config: OidcConfig): void {
  let url: URL;
  try {
    url = new URL(config.issuer);
  } catch {
    throw new Error("AUTH_OIDC_ISSUER must be a URL");
  }
  if (url.protocol !== "https:") throw new Error("AUTH_OIDC_ISSUER must use https://");
  entraTenantOf(config.issuer);
}

export function oidcLabel(config: OidcConfig): string {
  if (config.name?.trim()) return config.name.trim();
  if (config.issuer.replace(/\/$/, "") === GOOGLE_ISSUER) return "Google";
  if (new URL(config.issuer).hostname === ENTRA_HOST) return "Microsoft";
  return "SSO";
}

const deny = () => new APIError("FORBIDDEN", { message: "This account is not allowed" });

/**
 * Decide from the verified ID-token claims whether the provider's email can be trusted and
 * allowed. Returns the `emailVerified` to record; throws to refuse the sign-in.
 */
export function checkOidcProfile(
  config: OidcConfig,
  profile: { email?: unknown; email_verified?: unknown; hd?: unknown; tid?: unknown },
): { emailVerified: boolean } {
  const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
  if (!email) throw deny();
  const tenant = entraTenantOf(config.issuer);
  let emailVerified: boolean;
  if (tenant) {
    // Entra's email claim is not proof of ownership in general (nOAuth). Inside the one tenant
    // we named, the organization itself administers the address.
    if (typeof profile.tid !== "string" || profile.tid.toLowerCase() !== tenant) throw deny();
    emailVerified = true;
  } else {
    emailVerified = profile.email_verified === true;
  }
  if (!emailVerified) throw deny();
  const domains = parseDomains(config.allowedDomains ?? []);
  if (domains.length > 0) {
    if (!domains.includes(emailDomainOf(email))) throw deny();
    if (config.issuer.replace(/\/$/, "") === GOOGLE_ISSUER) {
      // Workspace accounts only: a consumer Google account has no `hd`.
      if (typeof profile.hd !== "string" || !domains.includes(profile.hd.toLowerCase())) {
        throw deny();
      }
    }
  }
  return { emailVerified };
}

export function oidcPlugin(config: OidcConfig | undefined) {
  if (!config) return [];
  assertOidcConfig(config);
  const domains = parseDomains(config.allowedDomains ?? []);
  const google = config.issuer.replace(/\/$/, "") === GOOGLE_ISSUER;
  return [
    genericOAuth({
      config: [
        {
          providerId: OIDC_PROVIDER_ID,
          name: oidcLabel(config),
          discoveryUrl: `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          scopes: ["openid", "email", "profile"],
          pkce: true,
          requireIdTokenVerification: true,
          ...(google && domains.length === 1
            ? { authorizationUrlParams: { hd: domains[0]! } }
            : {}),
          mapProfileToUser: (profile) => checkOidcProfile(config, profile),
        },
      ],
    }),
  ];
}
