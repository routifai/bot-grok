import { BoxSandboxProvider, CreateOSSandboxProvider, E2BSandboxProvider } from "@aiden/adapters";
import { loadRootEnv } from "@aiden/core/node/load-root-env";
import { describe, expect, it } from "vitest";

if (process.env.VERIFY_PROVIDERS) loadRootEnv();

const liveE2b = Boolean(process.env.VERIFY_PROVIDERS && process.env.E2B_API_KEY);
const liveBox = Boolean(process.env.VERIFY_PROVIDERS && process.env.BOX_API_KEY);
const liveCreateos = Boolean(process.env.VERIFY_PROVIDERS && process.env.CREATEOS_SANDBOX_API_KEY);

const describeE2b = liveE2b ? describe : describe.skip;
const describeBox = liveBox ? describe : describe.skip;
const describeCreateos = liveCreateos ? describe : describe.skip;

describeE2b("live E2B canary", () => {
  it("provisions a desktop, runs a command, and destroys it", async () => {
    const sandbox = new E2BSandboxProvider(process.env.E2B_API_KEY!);
    const ctx = {
      operationId: "canary",
      traceId: "canary",
      spaceId: "canary",
      userId: "canary",
      signal: new AbortController().signal,
    };
    const computer = await sandbox.provision(
      { botId: "canary", homePath: "/home/user/aiden-home" },
      ctx,
    );
    try {
      await sandbox.prepare(computer, ctx);
      let stdout = "";
      for await (const event of sandbox.execute(computer, { argv: ["echo", "e2b-ok"] }, ctx)) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      expect(stdout).toContain("e2b-ok");
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 120_000);
});

describeBox("live Box canary", () => {
  it("provisions a desktop, observes it, preserves a file across stop/resume, and destroys it", async () => {
    const sandbox = new BoxSandboxProvider({
      apiKey: process.env.BOX_API_KEY!,
      apiUrl: process.env.BOX_API_URL ?? process.env.BOX_BASE_URL,
    });
    const ctx = {
      operationId: "box-canary",
      traceId: "box-canary",
      spaceId: "box-canary",
      userId: "box-canary",
      signal: new AbortController().signal,
    };
    const request = { botId: "box-canary", homePath: "/home/user/aiden-home" };
    let computer = await sandbox.provision(request, ctx);
    try {
      await sandbox.prepare(computer, ctx);
      let stdout = "";
      for await (const event of sandbox.execute(computer, { argv: ["echo", "box-ok"] }, ctx)) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      expect(stdout).toContain("box-ok");
      await sandbox.writeFile(
        computer,
        { path: "canary.txt", content: new TextEncoder().encode("preserved") },
        ctx,
      );
      expect((await sandbox.observe(computer, ctx)).image.byteLength).toBeGreaterThan(0);

      await sandbox.stop(computer, ctx);
      computer = await sandbox.provision(
        { ...request, providerRef: computer.providerRef, providerKind: computer.kind },
        ctx,
      );
      expect(computer.fresh).toBe(false);
      await sandbox.prepare(computer, ctx);
      expect(new TextDecoder().decode(await sandbox.readFile(computer, "canary.txt", ctx))).toBe(
        "preserved",
      );
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 240_000);
});

describeCreateos("live CreateOS canary", () => {
  it("provisions a desktop, exports GUI-only work, survives pause, and destroys it", async () => {
    const sandbox = new CreateOSSandboxProvider({
      apiKey: process.env.CREATEOS_SANDBOX_API_KEY!,
      baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL,
      shape: process.env.CREATEOS_SANDBOX_SHAPE,
      rootfs: process.env.CREATEOS_SANDBOX_ROOTFS,
    });
    const ctx = {
      operationId: "createos-canary",
      traceId: "createos-canary",
      spaceId: "createos-canary",
      userId: "createos-canary",
      signal: new AbortController().signal,
    };
    const request = { botId: "createos-canary", homePath: "/home/desktop/aiden-home" };
    let computer = await sandbox.provision(request, ctx);
    try {
      await sandbox.prepare(computer, ctx);
      let stdout = "";
      for await (const event of sandbox.execute(
        computer,
        { argv: ["echo", "createos-ok"], cwd: "notes", env: { CANARY: "works" } },
        ctx,
      )) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      expect(stdout).toContain("createos-ok");

      expect((await sandbox.observe(computer, ctx)).image.byteLength).toBeGreaterThan(0);
      expect(
        (await sandbox.connectScreen(computer, { view: "stream", interactive: true }, ctx)).url,
      ).toBeTruthy();

      await sandbox.writeFile(
        computer,
        { path: "canary.txt", content: new TextEncoder().encode("preserved") },
        ctx,
      );

      // A GUI-only action must still mark the workspace exportable.
      await sandbox.act(computer, { actions: [{ kind: "wait", ms: 0 }], observe: false }, ctx);
      const exported: string[] = [];
      for await (const file of sandbox.exportWorkspace(computer, ctx)) exported.push(file.path);
      expect(exported).toContain("canary.txt");

      await sandbox.stop(computer, ctx);
      computer = await sandbox.provision(
        { ...request, providerRef: computer.providerRef, providerKind: computer.kind },
        ctx,
      );
      expect(computer.fresh).toBe(false);
      await sandbox.prepare(computer, ctx);
      expect(new TextDecoder().decode(await sandbox.readFile(computer, "canary.txt", ctx))).toBe(
        "preserved",
      );
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 600_000);
});
