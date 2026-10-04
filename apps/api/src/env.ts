import { resolveDeploymentModel, resolveSandboxProvider } from "@aiden/adapters";
import {
  resolveAuthSecret,
  resolveEncryptionKey,
  resolveScreenProxySecret,
  resolveSupervisorToken,
} from "@aiden/core";

export { resolveSandboxProvider } from "@aiden/adapters";

export interface AppEnv {
  nodeEnv: string;
  desktopStackToken?: string;
  databaseUrl: string;
  realtimeDatabaseUrl: string;
  authSecret: string;
  authUrl: string;
  webOrigin: string;
  privacyPolicyUrl?: string;
  apiUrl: string;
  apiHost: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  encryptionKey: string;
  dataDir: string;
  sandboxSupervisorUrl: string;
  sandboxSupervisorToken: string | undefined;
  screenProxySecret: string;
  sandboxProvider: string;
  agentRuntime: string;
  deploymentModelKey: string | undefined;
  e2bApiKey: string | undefined;
  daytonaApiKey: string | undefined;
  daytonaApiUrl: string | undefined;
  daytonaTarget: string | undefined;
  boxApiKey: string | undefined;
  boxApiUrl: string | undefined;
  composioApiKey: string | undefined;
  /** Optional integrations.sh-compatible catalog base URL. */
  integrationsCatalogUrl: string | undefined;
  pipedreamClientId: string | undefined;
  pipedreamClientSecret: string | undefined;
  pipedreamProjectId: string | undefined;
  pipedreamEnvironment: "development" | "production";
  sendblueApiKeyId: string | undefined;
  sendblueApiSecret: string | undefined;
  sendblueSigningSecret: string | undefined;
  sendbluePhoneNumber: string | undefined;
  smtpUrl: string | undefined;
  emailFrom: string | undefined;
  emailEmulator: boolean;
  slackBotToken: string | undefined;
  slackSigningSecret: string | undefined;
  whatsappAccessToken: string | undefined;
  whatsappPhoneNumberId: string | undefined;
  whatsappAppSecret: string | undefined;
  whatsappVerifyToken: string | undefined;
  telegramBotToken: string | undefined;
  telegramWebhookSecret: string | undefined;
  larkAppId: string | undefined;
  larkAppSecret: string | undefined;
  larkVerificationToken: string | undefined;
  larkEncryptKey: string | undefined;
  larkDomain: string | undefined;
  /** Unknown chat senders auto-provision their own accounts when true. */
  messagingOpenSignup: boolean;
  /** Bot that owns team/external chat rooms on the messaging surface. */
  /** Optional model override for ambient engagement judging. */
  defaultProvider: string;
  defaultModel: string;
  wakeupDriver: string;
  mcpStdioEnabled: boolean;
  mcpStdioAllowedCommands: string[];
  /** Deployment-owner escape for remote MCP on RFC1918 / Docker-network hosts. */
  mcpAllowPrivateEndpoint: boolean;
  port: number;
  gitSha: string | undefined;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const authSecret = resolveAuthSecret(source);
  const sandboxProvider = resolveSandboxProvider(source);
  const deploymentModel = resolveDeploymentModel(source);
  return {
    nodeEnv: source.NODE_ENV ?? "",
    databaseUrl: required(source, "DATABASE_URL"),
    realtimeDatabaseUrl: source.REALTIME_DATABASE_URL ?? required(source, "DATABASE_URL"),
    desktopStackToken: optional(source.AIDEN_DESKTOP_STACK_TOKEN),
    authSecret,
    authUrl: source.BETTER_AUTH_URL ?? source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    webOrigin: source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    privacyPolicyUrl: optional(source.PRIVACY_POLICY_URL),
    apiUrl: source.API_URL ?? "http://127.0.0.1:3100",
    apiHost: source.API_HOST ?? "127.0.0.1",
    signupsEnabled: source.SIGNUPS_ENABLED,
    signupAllowlist: source.SIGNUP_ALLOWLIST,
    encryptionKey: resolveEncryptionKey(source),
    dataDir: source.DATA_DIR ?? "./data",
    sandboxSupervisorUrl: source.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    sandboxSupervisorToken:
      sandboxProvider === "docker" ? resolveSupervisorToken(source) : undefined,
    screenProxySecret: resolveScreenProxySecret(source),
    sandboxProvider,
    agentRuntime: source.AGENT_RUNTIME ?? "pi",
    // Provider, model and key resolve together: see resolveDeploymentModel.
    deploymentModelKey: deploymentModel.key,
    e2bApiKey: source.E2B_API_KEY,
    daytonaApiKey: source.DAYTONA_API_KEY,
    daytonaApiUrl: source.DAYTONA_API_URL,
    daytonaTarget: source.DAYTONA_TARGET,
    boxApiKey: source.BOX_API_KEY,
    boxApiUrl: source.BOX_API_URL ?? source.BOX_BASE_URL,
    composioApiKey: source.COMPOSIO_API_KEY,
    integrationsCatalogUrl: optional(source.INTEGRATIONS_CATALOG_URL),
    pipedreamClientId: optional(source.PIPEDREAM_CLIENT_ID),
    pipedreamClientSecret: optional(source.PIPEDREAM_CLIENT_SECRET),
    pipedreamProjectId: optional(source.PIPEDREAM_PROJECT_ID),
    pipedreamEnvironment:
      source.PIPEDREAM_ENVIRONMENT === "production" ? "production" : "development",
    sendblueApiKeyId: optional(source.SENDBLUE_API_KEY_ID),
    sendblueApiSecret: optional(source.SENDBLUE_API_SECRET),
    sendblueSigningSecret: optional(source.SENDBLUE_SIGNING_SECRET),
    sendbluePhoneNumber: optional(source.SENDBLUE_PHONE_NUMBER),
    smtpUrl: optional(source.SMTP_URL),
    emailFrom: optional(source.EMAIL_FROM),
    emailEmulator: source.EMAIL_EMULATOR === "true" && source.NODE_ENV !== "production",
    slackBotToken: optional(source.SLACK_BOT_TOKEN),
    slackSigningSecret: optional(source.SLACK_SIGNING_SECRET),
    whatsappAccessToken: optional(source.WHATSAPP_ACCESS_TOKEN),
    whatsappPhoneNumberId: optional(source.WHATSAPP_PHONE_NUMBER_ID),
    whatsappAppSecret: optional(source.WHATSAPP_APP_SECRET),
    whatsappVerifyToken: optional(source.WHATSAPP_VERIFY_TOKEN),
    telegramBotToken: optional(source.TELEGRAM_BOT_TOKEN),
    telegramWebhookSecret: optional(source.TELEGRAM_WEBHOOK_SECRET_TOKEN),
    larkAppId: optional(source.LARK_APP_ID),
    larkAppSecret: optional(source.LARK_APP_SECRET),
    larkVerificationToken: optional(source.LARK_VERIFICATION_TOKEN),
    larkEncryptKey: optional(source.LARK_ENCRYPT_KEY),
    larkDomain: optional(source.LARK_DOMAIN),
    messagingOpenSignup: source.MESSAGING_OPEN_SIGNUP === "true",
    defaultProvider: deploymentModel.provider,
    defaultModel: deploymentModel.model,
    wakeupDriver: source.WAKEUP_DRIVER ?? "graphile",
    mcpStdioEnabled: source.MCP_STDIO_ENABLED === "true",
    mcpStdioAllowedCommands: (source.MCP_STDIO_ALLOWED_COMMANDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    mcpAllowPrivateEndpoint: source.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    port: Number(source.API_PORT ?? 3100),
    gitSha: optional(source.GIT_SHA) ?? optional(source.AIDEN_GIT_SHA),
  };
}

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
