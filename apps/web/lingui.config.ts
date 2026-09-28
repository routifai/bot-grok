import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  sourceLocale: "en",
  // Untranslated strings show in English instead of their message ids.
  fallbackLocales: { default: "en" },
  locales: ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru", "fr"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src"],
      exclude: ["**/locales/**", "**/*.test.*"],
    },
  ],
  // No file:line origins: catalogs change only when messages do, so CI can diff them.
  format: formatter({ origins: false }),
  compileNamespace: "es",
});
