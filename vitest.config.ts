import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The web project loads the Lingui vite plugin, which finds its config from here when the run
// starts at the repo root.
process.env.LINGUI_CONFIG ??= fileURLToPath(
  new URL("./apps/web/lingui.config.ts", import.meta.url),
);

const shared = {
  environment: "node",
  setupFiles: ["./vitest.setup.ts"],
  testTimeout: 30_000,
  hookTimeout: 60_000,
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: "workspace",
          include: [
            ".agents/skills/pr-watch/*.test.ts",
            "packages/*/src/**/*.test.{ts,tsx}",
            "infra/sandboxes/computer/deck-export/*.test.ts",
            "infra/sandboxes/computer/pptx/*.test.ts",
          ],
        },
      },
      {
        // The web tests run through the web app's own vite config, which carries the Lingui
        // macro transform; without it a test that does not mock `@lingui/*/macro` cannot load.
        extends: "./apps/web/vite.config.ts",
        test: {
          ...shared,
          name: "web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
