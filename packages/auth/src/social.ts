import { APIError } from "better-auth/api";

export interface SocialConfig {
  google?: {
    clientId: string;
    clientSecret: string;
    /** Google Workspace domain: Google restricts the picker and the token's `hd` is checked. */
    hostedDomain?: string;
  };
  microsoft?: {
    clientId: string;
    clientSecret: string;
    /** A specific Entra tenant id; its emails are administered, so they count as verified. */
    tenantId: string;
  };
}

export function socialProviderIds(config: SocialConfig | undefined): Array<"google" | "microsoft"> {
  return [
    ...(config?.google ? (["google"] as const) : []),
    ...(config?.microsoft ? (["microsoft"] as const) : []),
  ];
}

/**
 * The email's domain must match the configured Workspace domain and Google must vouch for the
 * address, in addition to better-auth's own check of the token's `hd` claim.
 */
export function assertGoogleHostedDomain(
  profile: { email?: string; email_verified?: boolean; hd?: string },
  hostedDomain: string | undefined,
): void {
  if (!hostedDomain) return;
  const domain = profile.email?.trim().toLowerCase().split("@")[1];
  if (!profile.email_verified || domain !== hostedDomain.toLowerCase()) {
    throw new APIError("FORBIDDEN", { message: "This Google account is not allowed" });
  }
}

export function socialProviders(config: SocialConfig | undefined) {
  return {
    ...(config?.google
      ? {
          google: {
            clientId: config.google.clientId,
            clientSecret: config.google.clientSecret,
            ...(config.google.hostedDomain ? { hd: config.google.hostedDomain } : {}),
            mapProfileToUser: (profile: {
              email?: string;
              email_verified?: boolean;
              hd?: string;
            }) => {
              assertGoogleHostedDomain(profile, config.google?.hostedDomain);
              return {};
            },
          },
        }
      : {}),
    ...(config?.microsoft
      ? {
          microsoft: {
            clientId: config.microsoft.clientId,
            clientSecret: config.microsoft.clientSecret,
            tenantId: config.microsoft.tenantId,
            mapProfileToUser: (profile: { email?: string }) => ({
              emailVerified: Boolean(profile.email),
            }),
          },
        }
      : {}),
  };
}
