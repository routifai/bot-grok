import { DEFAULT_COMPOSE_PROJECT_NAME, isLocalImageTag } from "@aiden/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPOSE_FILE,
  DEFAULT_UPDATER_PORT,
  readEnvAssignment,
  readTagState,
  resolveUpdaterConfig,
  truncateOutput,
} from "./updater-logic.js";

const base = {
  AIDEN_DEPLOY_DIR: "/srv/aiden",
  AIDEN_UPDATER_TOKEN: "fake-review-updater-token-000000000000",
} as const;

describe("resolveUpdaterConfig", () => {
  it("derives the compose file, env file, and defaults from the deployment directory", () => {
    const config = resolveUpdaterConfig({ ...base });
    expect(config).toMatchObject({
      deployDir: "/srv/aiden",
      composeFiles: [`/srv/aiden/${DEFAULT_COMPOSE_FILE}`],
      updateServices: ["api", "worker", "web"],
      envFile: "/srv/aiden/.env",
      projectName: DEFAULT_COMPOSE_PROJECT_NAME,
      token: base.AIDEN_UPDATER_TOKEN,
      port: DEFAULT_UPDATER_PORT,
    });
  });

  it("uses the Compose-injected project name so -p matches the running stack", () => {
    expect(
      resolveUpdaterConfig({ ...base, COMPOSE_PROJECT_NAME: "operator-stack" }).projectName,
    ).toBe("operator-stack");
    expect(
      resolveUpdaterConfig({ ...base, AIDEN_COMPOSE_PROJECT_NAME: "manual-stack" }).projectName,
    ).toBe("manual-stack");
  });

  it("refuses a project name it would not pass as a single -p argument", () => {
    expect(() => resolveUpdaterConfig({ ...base, COMPOSE_PROJECT_NAME: "-f" })).toThrow(
      /project name/,
    );
  });

  it("binds to loopback unless the deployment says otherwise, so a stray port is not a door", () => {
    expect(resolveUpdaterConfig({ ...base }).host).toBe("127.0.0.1");
    expect(resolveUpdaterConfig({ ...base, AIDEN_UPDATER_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  it("refuses a deployment directory that is missing or relative", () => {
    expect(() => resolveUpdaterConfig({ AIDEN_UPDATER_TOKEN: "t" })).toThrow(/AIDEN_DEPLOY_DIR/);
    expect(() => resolveUpdaterConfig({ ...base, AIDEN_DEPLOY_DIR: "srv/aiden" })).toThrow(
      /AIDEN_DEPLOY_DIR/,
    );
  });

  it("refuses a compose path that escapes the deployment directory", () => {
    for (const composeFile of ["/etc/compose.yml", "../../etc/compose.yml", "a/../../b.yml"]) {
      expect(() => resolveUpdaterConfig({ ...base, AIDEN_COMPOSE_FILE: composeFile })).toThrow(
        /AIDEN_COMPOSE_FILE/,
      );
    }
  });

  it("resolves a Compose file list in order, against the deployment directory", () => {
    expect(
      resolveUpdaterConfig({
        ...base,
        AIDEN_COMPOSE_FILE: "infra/compose/docker-compose.prod.yml:ops/overlay.yml",
      }).composeFiles,
    ).toEqual(["/srv/aiden/infra/compose/docker-compose.prod.yml", "/srv/aiden/ops/overlay.yml"]);
  });

  it("honours COMPOSE_PATH_SEPARATOR the way Compose does", () => {
    expect(
      resolveUpdaterConfig({
        ...base,
        COMPOSE_PATH_SEPARATOR: ",",
        AIDEN_COMPOSE_FILE: "a.yml,b.yml",
      }).composeFiles,
    ).toEqual(["/srv/aiden/a.yml", "/srv/aiden/b.yml"]);
  });

  it("checks every entry in a list, not just the first", () => {
    expect(() =>
      resolveUpdaterConfig({
        ...base,
        AIDEN_COMPOSE_FILE: "infra/compose/docker-compose.prod.yml:../../etc/compose.yml",
      }),
    ).toThrow(/AIDEN_COMPOSE_FILE/);
    expect(() =>
      resolveUpdaterConfig({
        ...base,
        AIDEN_COMPOSE_FILE: "infra/compose/docker-compose.prod.yml:/etc/compose.yml",
      }),
    ).toThrow(/AIDEN_COMPOSE_FILE/);
  });

  it("refuses a Compose file list that names nothing", () => {
    expect(() => resolveUpdaterConfig({ ...base, AIDEN_COMPOSE_FILE: ":  :" })).toThrow(
      /AIDEN_COMPOSE_FILE/,
    );
  });

  it("appends the deployment's extra services to the built-in set", () => {
    expect(
      resolveUpdaterConfig({ ...base, AIDEN_UPDATE_SERVICES: "supervisor, caddy" }).updateServices,
    ).toEqual(["api", "worker", "web", "supervisor", "caddy"]);
  });

  it("cannot drop a built-in service, however AIDEN_UPDATE_SERVICES is written", () => {
    const services = resolveUpdaterConfig({
      ...base,
      AIDEN_UPDATE_SERVICES: "web,supervisor",
    }).updateServices;
    expect(services).toEqual(["api", "worker", "web", "supervisor"]);
  });

  it("refuses to recreate the updater, which would kill the run mid-flight", () => {
    expect(() =>
      resolveUpdaterConfig({ ...base, AIDEN_UPDATE_SERVICES: "supervisor,updater" }),
    ).toThrow(/updater/);
  });

  it("refuses a service name it would not hand to compose as one argument", () => {
    for (const service of ["--build", "a b", "-f", "api;rm"]) {
      expect(() =>
        resolveUpdaterConfig({ ...base, AIDEN_UPDATE_SERVICES: `supervisor,${service}` }),
      ).toThrow(/AIDEN_UPDATE_SERVICES/);
    }
  });

  it("refuses an image name it would not be willing to hand to compose", () => {
    expect(() => resolveUpdaterConfig({ ...base, AIDEN_IMAGE: "Bad Name" })).toThrow(/AIDEN_IMAGE/);
    expect(resolveUpdaterConfig({ ...base, AIDEN_IMAGE: "ghcr.io/me/app" }).image).toBe(
      "ghcr.io/me/app",
    );
  });

  it("refuses a port that is not a port", () => {
    expect(() => resolveUpdaterConfig({ ...base, AIDEN_UPDATER_PORT: "0" })).toThrow(/port/);
    expect(() => resolveUpdaterConfig({ ...base, AIDEN_UPDATER_PORT: "seven" })).toThrow(/port/);
  });
});

describe("readEnvAssignment", () => {
  it("reads the last assignment, ignoring comments and blank lines", () => {
    const contents = ["# AIDEN_IMAGE_TAG=commented", "", "A=1", "A=2"].join("\n");
    expect(readEnvAssignment(contents, "A")).toBe("2");
    expect(readEnvAssignment(contents, "AIDEN_IMAGE_TAG")).toBeNull();
  });

  it("removes one layer of quoting", () => {
    expect(readEnvAssignment('A="v1.0.0"', "A")).toBe("v1.0.0");
    expect(readEnvAssignment("A='v1.0.0'", "A")).toBe("v1.0.0");
  });

  it("does not match a key that merely shares a prefix", () => {
    expect(readEnvAssignment("AIDEN_IMAGE_TAG_PREVIOUS=v1", "AIDEN_IMAGE_TAG")).toBeNull();
  });
});

describe("readTagState", () => {
  it("reads the pinned tag and the rollback tag", () => {
    const contents = "AIDEN_IMAGE_TAG=v1.1.0\nAIDEN_IMAGE_TAG_PREVIOUS=v1.0.0\n";
    expect(readTagState(contents)).toEqual({ currentTag: "v1.1.0", previousTag: "v1.0.0" });
  });

  it("falls back to the locally built tag when nothing is pinned yet", () => {
    expect(readTagState("")).toEqual({ currentTag: "local", previousTag: null });
  });

  it("ignores values in the file that are not usable tags", () => {
    const contents = "AIDEN_IMAGE_TAG=-rm\nAIDEN_IMAGE_TAG_PREVIOUS=$(id)\n";
    expect(readTagState(contents)).toEqual({ currentTag: "local", previousTag: null });
  });

  /**
   * The fallback has to be a tag no registry serves. A deployment that has never been pinned has
   * only ever built its images locally, so a fallback of `latest` would send both a first
   * `docker compose up` and a rollback to a registry that may have nothing under that name.
   */
  it("falls back to a tag that is local-only, so nothing tries to pull it", () => {
    expect(isLocalImageTag(readTagState("").currentTag)).toBe(true);
  });
});

describe("truncateOutput", () => {
  it("keeps short output as-is and keeps the tail of long output", () => {
    expect(truncateOutput("done\n")).toBe("done");
    const long = truncateOutput("x".repeat(20_000));
    expect(long.startsWith("…")).toBe(true);
    expect(long.length).toBeLessThan(9_000);
  });
});
