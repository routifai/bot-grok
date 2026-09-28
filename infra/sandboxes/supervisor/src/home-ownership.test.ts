import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertComputerHomeWritable,
  assertOpenedDirectoryBeneathRoot,
  homeWritableAsUser,
} from "./home-ownership.js";

const roots: string[] = [];
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("computer home ownership", () => {
  it("rejects a missing home instead of creating it as root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-missing-"));
    roots.push(parent);

    await expect(
      assertComputerHomeWritable(path.join(parent, "missing"), 1000, 1000),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects a symlink as the home root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-root-link-"));
    roots.push(parent);
    const outside = path.join(parent, "outside");
    const home = path.join(parent, "home");
    await mkdir(outside);
    await symlink(outside, home);

    await expect(assertComputerHomeWritable(home, 1000, 1000)).rejects.toThrow(/symbolic link/);
  });

  it("rejects a writable regular file as the home root", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-file-root-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    await writeFile(home, "{}");
    await chmod(home, 0o600);

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(
      /must be a directory/,
    );
  });

  it("rejects an existing entry that the host-run computer cannot write", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-writable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await chmod(home, 0o777);
    await writeFile(file, "{}");
    await chmod(file, 0o400);

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid + 1, stat.gid + 1)).rejects.toThrow(
      /chown -R/,
    );
  });

  it("accepts writable files owned by the sandbox user", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-writable-file-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await writeFile(file, "{}");
    await chmod(file, 0o644);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).resolves.toBeUndefined();
  });

  it("accepts sandbox-owned read-only git object files", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-git-object-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const object = path.join(home, "repo", ".git", "objects", "ab", "cdef");
    await mkdir(path.dirname(object), { recursive: true });
    await writeFile(object, "blob");
    await chmod(object, 0o444);

    const stat = await lstat(object);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).resolves.toBeUndefined();
  });

  it("rejects a read-only file owned by someone else", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-foreign-readonly-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "object");
    await mkdir(home);
    await chmod(home, 0o777);
    await writeFile(file, "blob");
    await chmod(file, 0o444);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid + 1, stat.gid + 1)).rejects.toThrow(
      /chown -R/,
    );
  });

  it("rejects an owner-owned file the owner cannot read", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-unreadable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await writeFile(file, "{}");
    await chmod(file, 0o000);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(/chown -R/);
  });

  it("rejects an owner-owned world-writable file the owner cannot write", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-world-writable-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const file = path.join(home, "profile.json");
    await mkdir(home);
    await writeFile(file, "{}");
    await chmod(file, 0o002);

    const stat = await lstat(file);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(/chown -R/);
  });

  it("rejects an owner-owned directory that is not writable", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-dir-mode-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    await mkdir(home);
    await chmod(home, 0o555);

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).rejects.toThrow(/chown -R/);
  });

  it("does not follow symlinks while checking host-run compatibility", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-writable-link-"));
    roots.push(parent);
    const home = path.join(parent, "home");
    const outside = path.join(parent, "outside");
    await mkdir(home);
    await writeFile(outside, "outside");
    await chmod(outside, 0o400);
    await symlink(outside, path.join(home, "link"));

    const stat = await lstat(home);
    await expect(assertComputerHomeWritable(home, stat.uid, stat.gid)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "linux")(
    "rejects an opened directory that was moved outside the home",
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), "aiden-home-moved-"));
      roots.push(parent);
      const home = path.join(parent, "home");
      const outside = path.join(parent, "outside");
      const child = path.join(home, "nested");
      await mkdir(child, { recursive: true });
      await mkdir(outside, { recursive: true });
      const handle = await open(child, DIRECTORY_OPEN_FLAGS);
      try {
        await rename(child, path.join(outside, "nested"));
        await expect(assertOpenedDirectoryBeneathRoot(handle, home)).rejects.toThrow(
          /escaped validated root/,
        );
      } finally {
        await handle.close();
      }
    },
  );
});

describe("homeWritableAsUser", () => {
  it("asks as the computer user whether the home is its own and writable", () => {
    const calls: Array<{ args: string[]; uid: number; gid: number }> = [];
    const ok = homeWritableAsUser("/data/homes/team-1", 1000, 1000, (_command, args, options) => {
      calls.push({ args, uid: options.uid, gid: options.gid });
      return { status: 0 };
    });
    expect(ok).toBe(true);
    expect(calls[0]).toMatchObject({ uid: 1000, gid: 1000 });
    expect(calls[0]?.args.at(-1)).toBe("/data/homes/team-1");
    expect(calls[0]?.args[1]).toContain('= "1000"');
  });

  it("says no when the probe fails or cannot run", () => {
    expect(homeWritableAsUser("/h", 1000, 1000, () => ({ status: 1 }))).toBe(false);
    expect(homeWritableAsUser("/h", 1000, 1000, () => ({ status: null }))).toBe(false);
    expect(
      homeWritableAsUser("/h", 1000, 1000, () => {
        throw new Error("EPERM");
      }),
    ).toBe(false);
  });
});
