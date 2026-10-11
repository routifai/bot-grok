import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { lingui } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import type { DesktopStackProbeResponse } from "@superchat/contracts";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { PreviewServer, ViteDevServer } from "vite";
import { defineConfig, loadEnv } from "vite";
import { apiProxy } from "./src/api-proxy.js";

const webPort = Number(process.env.WEB_PORT ?? 5173);
const DESKTOP_STACK_PROBE_PATH = "/.well-known/superchat-desktop-stack";
const DESKTOP_STACK_TOKEN_HEADER = "x-superchat-desktop-stack-token";

function equalStackToken(expected: string, supplied: string | string[] | undefined) {
  if (expected === "" || typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function attachDesktopStackProbe(
  server: ViteDevServer | PreviewServer,
  token: string,
  imageTag: string,
) {
  server.middlewares.use((req, res, next) => {
    if (req.url?.split("?", 1)[0] !== DESKTOP_STACK_PROBE_PATH) {
      next();
      return;
    }
    if (!equalStackToken(token, req.headers[DESKTOP_STACK_TOKEN_HEADER])) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const body: DesktopStackProbeResponse = { ok: true, imageTag };
    res.statusCode = 200;
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  });
}

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, "../.."), "");
  const api = process.env.API_PROXY_TARGET ?? rootEnv.API_PROXY_TARGET ?? "http://127.0.0.1:3100";
  const previewHost = process.env.SUPERCHAT_HOST ?? rootEnv.SUPERCHAT_HOST ?? "localhost";
  const performanceAssetDelayMs = Number(process.env.SUPERCHAT_PERFORMANCE_ASSET_DELAY_MS ?? 0);
  const desktopStackToken =
    process.env.SUPERCHAT_DESKTOP_STACK_TOKEN ?? rootEnv.SUPERCHAT_DESKTOP_STACK_TOKEN ?? "";
  const imageTag = process.env.SUPERCHAT_IMAGE_TAG ?? rootEnv.SUPERCHAT_IMAGE_TAG ?? "edge";
  return {
    plugins: [
      react(),
      babel({ plugins: ["@lingui/babel-plugin-lingui-macro"] }),
      lingui(),
      tailwindcss(),
      {
        name: "superchat-desktop-stack-probe",
        configureServer: (server) => attachDesktopStackProbe(server, desktopStackToken, imageTag),
        configurePreviewServer: (server) =>
          attachDesktopStackProbe(server, desktopStackToken, imageTag),
      },
      {
        name: "superchat-performance-asset-delay",
        configurePreviewServer(server) {
          if (!Number.isFinite(performanceAssetDelayMs) || performanceAssetDelayMs <= 0) return;
          server.middlewares.use((req, _res, next) => {
            const pathname = req.url?.split("?", 1)[0] ?? "/";
            if (["/api", "/rpc", "/apps/"].some((prefix) => pathname.startsWith(prefix))) {
              next();
              return;
            }
            setTimeout(next, performanceAssetDelayMs);
          });
        },
      },
    ],
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      proxy: {
        "/api": apiProxy(api),
        "/rpc": apiProxy(api),
        // Published mini apps (`/apps/<slug>`); the API sets their sandbox headers.
        "^/apps/": apiProxy(api),
      },
    },
    preview: {
      host: "0.0.0.0",
      port: Number(process.env.WEB_PORT ?? 5173),
      allowedHosts: [previewHost],
      proxy: {
        "/api": apiProxy(api),
        "/rpc": apiProxy(api),
        // Published mini apps (`/apps/<slug>`); the API sets their sandbox headers.
        "^/apps/": apiProxy(api),
      },
    },
  };
});
