import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The web project loads the Lingui vite plugin, which finds its config from here when the run
// starts at the repo root.
process.env.LINGUI_CONFIG ??= fileURLToPath(
  new URL("./apps/web/lingui.config.ts", import.meta.url),
);

const alias = [
  {
    // The published dist keeps JSX inside .js files, which vite cannot parse;
    // tests load the package's shipped TypeScript source instead.
    find: /^@ronradtke\/react-native-markdown-display$/,
    replacement: fileURLToPath(
      new URL(
        "./packages/chat-ui/node_modules/@ronradtke/react-native-markdown-display/src/index.tsx",
        import.meta.url,
      ),
    ),
  },
  // Native-only transitive deps of the renderer contain uncompiled Flow
  // source; stub them out in tests (they never render anyway).
  ...["react-native-fit-image", "@react-native-vector-icons/material-design-icons"].map((dep) => ({
    find: new RegExp(`^${dep.replace(/[/]/g, "\\/")}$`),
    replacement: fileURLToPath(
      new URL("./packages/chat-ui/src/native-test-stubs.tsx", import.meta.url),
    ),
  })),
];

const shared = {
  // Load the markdown renderer's shipped TypeScript source through vite so
  // react-native can be mocked in node tests.
  server: { deps: { inline: [/react-native-markdown-display/] } },
  environment: "node",
  setupFiles: ["./packages/testkit/src/pin-test-env.ts"],
  testTimeout: 30_000,
  hookTimeout: 60_000,
} as const;

export default defineConfig({
  resolve: { alias },
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
            "infra/sandboxes/supervisor/src/**/*.test.ts",
            "apps/desktop/src/**/*.test.ts",
            "apps/mobile/lib/**/*.test.ts",
            "apps/mobile/plugins/**/*.test.js",
            "apps/api/src/**/*.test.ts",
            "apps/www/src/**/*.test.ts",
          ],
        },
      },
      {
        // The web tests run through the web app's own vite config, which carries the Lingui
        // macro transform; without it a test that does not mock `@lingui/*/macro` cannot load.
        extends: "./apps/web/vite.config.ts",
        resolve: { alias },
        test: {
          ...shared,
          name: "web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
