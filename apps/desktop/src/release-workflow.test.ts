import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-desktop.yml"),
  "utf8",
);

const expression = (inner: string) => `\${{ ${inner} }}`;

describe("desktop release workflow", () => {
  it("cannot execute contributor pull-request code with release credentials", () => {
    expect(workflow).not.toMatch(/^\s*pull_request:/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("requires signed platform builds and never publishes a release", () => {
    expect(workflow).toContain("-c.forceCodeSigning=true");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("needs: [validate, build]");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("actions/attest-build-provenance@");
    expect(workflow).not.toContain("--publish always");
    expect(workflow).not.toContain("gh release");
    expect(workflow).not.toContain("--draft");
    expect(workflow).toContain("DESKTOP_MAC_CSC_LINK");
    expect(workflow).toContain("DESKTOP_WIN_CSC_LINK");
    expect(workflow).not.toMatch(/secrets\.DESKTOP_CSC_(?:LINK|KEY_PASSWORD)/);
    expect(workflow).not.toContain("cache: pnpm");
  });

  it("notarizes macOS with a short-lived App Store Connect API key file", () => {
    for (const secret of ["APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_API_KEY_P8"]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).not.toMatch(/secrets\.(?:APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD)\b/);
    // The same temp path is declared by the setup, packaging, and cleanup steps.
    const keyFile = `APPLE_API_KEY: ${expression("runner.temp")}/apple-api-key.p8`;
    expect(workflow.split(keyFile)).toHaveLength(4);
    expect(workflow).toContain(`printf '%s\\n' "$APPLE_API_KEY_P8" > "$APPLE_API_KEY"`);
    expect(workflow).toContain('chmod 600 "$APPLE_API_KEY"');
    expect(workflow).toMatch(
      /if: always\(\) && runner\.os == 'macOS'\n(?:.*\n){3}\s+run: rm -f "\$APPLE_API_KEY"/,
    );
  });

  it("builds Windows only when an Authenticode certificate is configured", () => {
    expect(workflow).toContain(
      `WINDOWS_SIGNING: ${expression("secrets.DESKTOP_WIN_CSC_LINK != ''")}`,
    );
    expect(workflow).toContain(
      `include: ${expression("fromJSON(needs.validate.outputs.platforms)")}`,
    );
    expect(workflow).toContain(
      `include='[{"os":"macos-26","artifact":"macos"},{"os":"ubuntu-24.04","artifact":"linux"}]'`,
    );
    expect(workflow).toMatch(
      /if \[\[ "\$WINDOWS_SIGNING" == "true" \]\]; then\n\s+include=.*\{"os":"windows-2022","artifact":"windows"\}/,
    );
    expect(workflow.split("windows-2022")).toHaveLength(2);
    expect(workflow).toContain(`WINDOWS_BUILT: ${expression("needs.validate.outputs.windows")}`);
    expect(workflow).toContain('if [[ "$WINDOWS_BUILT" == "true" ]]; then');
    expect(workflow).toContain("compgen -G 'release-artifacts/*.exe' >/dev/null");
  });

  it("has no reference to the original upstream repository", () => {
    expect(workflow).not.toMatch(/elie222/);
  });

  it("builds artifacts only: no GitHub release, no update feed", () => {
    expect(workflow).toContain("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)$");
    expect(workflow).not.toContain("app-update.yml");
    expect(workflow).not.toContain("latest.yml");
    expect(workflow).not.toContain("latest-mac.yml");
    expect(workflow).not.toContain("latest-linux.yml");
    expect(workflow).not.toContain("release create");
    expect(workflow).not.toContain("release edit");
    expect(workflow).toContain("compgen -G 'release-artifacts/*.dmg' >/dev/null");
    expect(workflow).toContain("compgen -G 'release-artifacts/*.zip' >/dev/null");
    expect(workflow).toContain("compgen -G 'release-artifacts/*.AppImage' >/dev/null");
    expect(workflow).toContain("sha256sum > SHA256SUMS");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain("name: desktop-release-");
  });
});
