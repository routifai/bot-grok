import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface NamedPlugin {
  name?: string;
  configureServer?: unknown;
  configurePreviewServer?: unknown;
}

// Imported dynamically, via a URL (not a string literal), so tsc's apps/web program (rootDir:
// "src") never has to resolve vite.config.ts — it lives outside "src" on purpose. vite.config.ts's
// default export is the config factory itself (defineConfig with a function argument returns that
// function unchanged), so it's callable directly with a resolve context.
async function loadViteConfigFactory(): Promise<
  (ctx: { mode: string; command: string }) => unknown
> {
  const module = (await import(new URL("../vite.config.ts", import.meta.url).href)) as {
    default: (ctx: { mode: string; command: string }) => unknown;
  };
  return module.default;
}

/**
 * `vite preview` is how every Compose/Docker/production path in this repo serves the built web
 * app (there is no separate production server). The noVNC disconnect-recovery script
 * (injectScreenLifecycle, ./novnc-html.ts) only helps a bot's computer pane recover on its own if
 * it is injected there too, not just under `vite dev`. Lock that both hooks stay wired to the same
 * proxy implementation so a future refactor can't silently drop it from production.
 */
describe("vite.config novnc proxy wiring", () => {
  it("wires the same noVNC proxy (and its lifecycle injection) into dev and preview servers", async () => {
    const configFactory = await loadViteConfigFactory();
    const config = (await configFactory({ mode: "production", command: "serve" })) as {
      plugins?: NamedPlugin[];
    };
    const plugins = config.plugins ?? [];
    const novncPlugin = plugins.find((plugin) => plugin?.name === "aiden-novnc-proxy");
    expect(novncPlugin, "expected a plugin named aiden-novnc-proxy").toBeTruthy();
    expect(typeof novncPlugin?.configureServer).toBe("function");
    expect(typeof novncPlugin?.configurePreviewServer).toBe("function");
    // Both hooks must delegate to the same attachNovncProxy implementation (which performs
    // injectScreenLifecycle on every /novnc/* HTML response) rather than a stripped-down copy.
    expect(String(novncPlugin?.configureServer)).toContain("attachNovncProxy");
    expect(String(novncPlugin?.configurePreviewServer)).toContain("attachNovncProxy");
  });
});

describe("vite.config novnc html rewrite", () => {
  it("injects the disconnect hook for every host, not only CreateOS (local Docker computers went black for good)", () => {
    const source = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    // The rewrite gate must not depend on the upstream hostname...
    expect(source).toMatch(/function shouldRewriteNovncHtml\(headers: [^,)]*\)/);
    // ...and only the storage shim stays CreateOS-specific.
    expect(source).toMatch(/injectScreenLifecycle\(\s*isCreateOSNovncHost\(target\.hostname\) \? injectNovncStorageShim\(html\) : html/);
  });
});
