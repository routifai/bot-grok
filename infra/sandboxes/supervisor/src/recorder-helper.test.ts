import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const computer = (name: string) =>
  fileURLToPath(new URL(`../../computer/${name}`, import.meta.url));

it("checks the teaching recorder helper offline", () => {
  expect(() =>
    execFileSync("python3", [computer("test_recorder.py")], { timeout: 10_000, stdio: "pipe" }),
  ).not.toThrow();
});

it("ships the recorder and its injected script in the computer image", () => {
  const dockerfile = readFileSync(computer("Dockerfile"), "utf8");
  expect(dockerfile).toMatch(/nova-recorder \/usr\/local\/bin\/nova-recorder/);
  expect(dockerfile).toMatch(/nova-recorder\.js \/usr\/local\/share\/nova\/nova-recorder\.js/);
});
