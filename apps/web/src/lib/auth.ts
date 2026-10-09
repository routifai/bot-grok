import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient, type ReactAuthClient } from "better-auth/react";

type AuthResult<T> = Promise<{
  data: T | null;
  error: { message?: string; code?: string; status: number } | null;
}>;

/**
 * The email-code endpoints, typed here because the plugin's inferred client types do not survive
 * this package's explicit client annotation (declaration emit).
 */
type WithFetchOptions = { fetchOptions?: { headers?: Record<string, string> } };

interface EmailCodeClient {
  emailOtp: {
    sendVerificationOtp(input: {
      email: string;
      type: "sign-in" | "email-verification";
    }): AuthResult<{ success: boolean }>;
    /** Signs in on success: the server creates the session once the mailbox is proved. */
    verifyEmail(input: {
      email: string;
      otp: string;
    }): AuthResult<{ user?: { createdAt?: string } }>;
  };
  signIn: {
    emailOtp(
      input: { email: string; otp: string } & WithFetchOptions,
    ): AuthResult<{ user?: { createdAt?: string } }>;
  };
}

type BaseClient = ReactAuthClient<{
  plugins: [ReturnType<typeof organizationClient>, ReturnType<typeof emailOTPClient>];
}>;

export const authClient = createAuthClient({
  plugins: [organizationClient(), emailOTPClient()],
}) as unknown as Omit<BaseClient, "signIn"> & {
  signIn: BaseClient["signIn"] & EmailCodeClient["signIn"];
} & Pick<EmailCodeClient, "emailOtp">;
