import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as realFs from "fs";
import * as realProcess from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CODEX_CONFIG_FILE_ACL, codexConfigFileAclScript, CODEX_CONFIG_DIRECTORY_ACL, codexConfigDirectoryAclScript } from "../codex-config-acl.js";
const state = { home: "" };
let configDir: string;
let configFile: string;
const userConfig = 'model = "preserve-me"\n';
beforeEach(() => {
    state.home = mkdtempSync(join(tmpdir(), "ccc-config-acl-"));
    configDir = join(state.home, "codex");
    configFile = join(configDir, "config.toml");
    mkdirSync(configDir);
    writeFileSync(configFile, userConfig, { mode: 0o600 });
});
afterEach(() => rmSync(state.home, { recursive: true, force: true }));

describe.skipIf(process.platform !== "linux")("native config file ACL", () => {
    const undefinedId = 0xffffffff;
    type Entry = [number, number, number];
    const runPython = (script: string, ...args: string[]) => realProcess.spawnSync("python3", ["-c", script, ...args], { encoding: "utf8" });
    const grant = (prefix = "") => runPython(`${prefix}\n${CODEX_CONFIG_FILE_ACL.replace("/home/ccc/.codex", configDir)}`, "2001");
    const readAcl = (path = configFile): Entry[] | null => {
        const result = runPython(`import errno, json, os, struct, sys
try:
    data = os.getxattr(sys.argv[1], "system.posix_acl_access")
    print(json.dumps(list(struct.iter_unpack("<HHI", data[4:]))))
except OSError as error:
    if error.errno != errno.ENODATA: raise
    print("null")`, path);
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout);
    };
    const setAcl = (entries: Entry[]): void => {
        const result = runPython(`import json, os, struct, sys
os.setxattr(sys.argv[1], "system.posix_acl_access", struct.pack("<I", 2) + b"".join(
    struct.pack("<HHI", *entry) for entry in json.loads(sys.argv[2])))`, configFile, JSON.stringify(entries));
        expect(result.status, result.stderr).toBe(0);
    };
    const metadata = () => {
        const { uid, gid, mode } = realFs.statSync(configFile);
        return { uid, gid, mode };
    };

    it("adds shared access to an unreadable file, retaining owner execute, group rights and identities", () => {
        const original = metadata();
        chmodSync(configFile, 0o100);
        const result = grant();
        expect(result.status, result.stderr).toBe(0);
        expect(metadata()).toMatchObject({ uid: original.uid, gid: original.gid });
        expect(readAcl()).toEqual([
            [1, 7, undefinedId], [2, 6, 2001], [4, 0, undefinedId],
            [16, 6, undefinedId], [32, 0, undefinedId],
        ]);
        expect(readFileSync(configFile, "utf8")).toBe(userConfig);
    });

    it("preserves existing target execute and unrelated effective custom ACL rights", () => {
        setAcl([
            [1, 7, undefinedId], [2, 1, 2001], [2, 1, 3001], [4, 1, undefinedId],
            [8, 1, 3002], [16, 1, undefinedId], [32, 0, undefinedId],
        ]);
        const original = metadata();
        const result = grant();
        expect(result.status, result.stderr).toBe(0);
        expect(metadata()).toMatchObject({ uid: original.uid, gid: original.gid });
        expect(readAcl()).toEqual([
            [1, 7, undefinedId], [2, 7, 2001], [2, 1, 3001], [4, 1, undefinedId],
            [8, 1, 3002], [16, 7, undefinedId], [32, 0, undefinedId],
        ]);
    });

    it.each([
        [[1, 6, undefinedId], [2, 6, 3001], [4, 0, undefinedId], [16, 4, undefinedId], [32, 0, undefinedId]],
        [[1, 6, undefinedId], [4, 2, undefinedId], [16, 0, undefinedId], [32, 0, undefinedId]],
        [[1, 6, undefinedId], [4, 0, undefinedId], [8, 2, 3002], [16, 0, undefinedId], [32, 0, undefinedId]],
    ] as Entry[][])("refuses mask expansion that unmasks unrelated permissions: %j", (...entries: Entry[]) => {
        setAcl(entries);
        const original = metadata();
        const originalAcl = readAcl();
        const result = grant();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("mask expansion would grant unrelated access");
        expect(metadata()).toEqual(original);
        expect(readAcl()).toEqual(originalAcl);
        expect(readFileSync(configFile, "utf8")).toBe(userConfig);
    });

    it.each(["getxattr", "setxattr"])("does not change mode or ownership when %s rejects unsupported ACLs", (operation) => {
        chmodSync(configFile, 0o640);
        const original = metadata();
        const result = grant(`import errno, os
def unsupported(*args):
    raise OSError(errno.ENOTSUP, "ACL filesystem unsupported")
os.${operation} = unsupported`);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("ACL filesystem unsupported");
        expect(metadata()).toEqual(original);
        expect(readAcl()).toBeNull();
        expect(readFileSync(configFile, "utf8")).toBe(userConfig);
    });

    it.each([
        "b'bad'",
        "struct.pack('<I', 3)",
        "struct.pack('<IHHI', 2, 1, 6, 0xffffffff)",
        "struct.pack('<I', 2) + struct.pack('<HHI', 1, 6, 0xffffffff) * 2",
        "struct.pack('<IHHI', 2, 2, 6, 0xffffffff)",
        "struct.pack('<IHHI', 2, 1, 8, 0xffffffff)",
    ])("rejects malformed ACL data without a mutation: %s", (data) => {
        const original = metadata();
        const result = grant(`import os, struct
os.getxattr = lambda *args: ${data}
def unexpected_write(*args):
    raise AssertionError("attempted ACL mutation")
os.setxattr = unexpected_write`);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("malformed config ACL");
        expect(result.stderr).not.toContain("attempted ACL mutation");
        expect(metadata()).toEqual(original);
        expect(readAcl()).toBeNull();
    });

    it("refuses a replaced entry without changing the pinned inode or symlink target", () => {
        const outside = join(state.home, "outside");
        const previous = join(configDir, "config.previous");
        writeFileSync(outside, "untouched", { mode: 0o400 });
        const original = metadata();
        const originalAcl = readAcl();
        const result = grant(`import os
original_getxattr = os.getxattr
def replace_path(*args):
    os.rename(${JSON.stringify(configFile)}, ${JSON.stringify(previous)})
    os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(configFile)})
    return original_getxattr(*args)
os.getxattr = replace_path`);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("config identity changed before ACL grant");
        expect(realFs.statSync(previous)).toMatchObject(original);
        expect(readAcl(previous)).toEqual(originalAcl);
        expect(readFileSync(previous, "utf8")).toBe(userConfig);
        expect(readAcl(outside)).toBeNull();
        expect(realFs.statSync(outside).mode & 0o777).toBe(0o400);
        expect(readFileSync(outside, "utf8")).toBe("untouched");
    });

    it("refuses an existing hardlink alias without changing either path's ACL, owner, mode or contents", () => {
        const alias = join(state.home, "external-alias");
        realFs.linkSync(configFile, alias);
        const before = metadata();
        const originalAcl = readAcl();
        expect(grant().status).toBe(1);
        for (const path of [configFile, alias]) {
            expect(realFs.statSync(path)).toMatchObject(before);
            expect(readAcl(path)).toEqual(originalAcl);
            expect(readFileSync(path, "utf8")).toBe(userConfig);
        }
    });

    it("refuses a hardlink added during ACL observation without mutating the pinned inode", () => {
        const alias = join(state.home, "late-alias");
        const before = metadata();
        const originalAcl = readAcl();
        const result = grant(`import os
original_getxattr = os.getxattr
def add_alias(*args):
    os.link(${JSON.stringify(configFile)}, ${JSON.stringify(alias)})
    return original_getxattr(*args)
os.getxattr = add_alias`);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("config identity changed before ACL grant");
        for (const path of [configFile, alias]) {
            expect(realFs.statSync(path)).toMatchObject(before);
            expect(readAcl(path)).toEqual(originalAcl);
            expect(readFileSync(path, "utf8")).toBe(userConfig);
        }
    });

    it("rejects an intermediate directory symlink before reading or granting target ACLs", () => {
        const linkedParent = join(state.home, "linked-parent");
        realFs.symlinkSync(state.home, linkedParent, "dir");
        const before = metadata();
        const originalAcl = readAcl();
        const result = runPython(CODEX_CONFIG_FILE_ACL.replace("/home/ccc/.codex", join(linkedParent, "codex")), "2001");
        expect(result.status).toBe(1);
        expect(metadata()).toEqual(before);
        expect(readAcl()).toEqual(originalAcl);
        expect(readFileSync(configFile, "utf8")).toBe(userConfig);
    });

    it("regrants access after atomic file replacement without changing either owner", () => {
        expect(grant().status).toBe(0);
        const replacement = join(configDir, "replacement");
        writeFileSync(replacement, userConfig + "# replaced\n", { mode: 0o600 });
        realFs.renameSync(replacement, configFile);
        const original = metadata();
        expect(readAcl()).toBeNull();
        const result = grant();
        expect(result.status, result.stderr).toBe(0);
        expect(metadata()).toMatchObject({ uid: original.uid, gid: original.gid });
        expect(readAcl()).toContainEqual([2, 6, 2001]);
        expect(readFileSync(configFile, "utf8")).toBe(userConfig + "# replaced\n");
    });
});

it.each(["", "-1", "4294967295", "2001; touch /tmp/unsafe"])("rejects unsafe or unmapped UID %j before building a privileged ACL script", (uid) => {
    expect(() => codexConfigFileAclScript(uid)).toThrow(/invalid container user identity/);
});

describe.skipIf(process.platform !== "linux")("pinned Codex directory ACL", () => {
    const undefinedId = 0xffffffff;
    const runPython = (script: string, ...args: string[]) => realProcess.spawnSync("python3", ["-c", script, ...args], { encoding: "utf8", timeout: 3000 });
    const grant = (prefix = "", uid = "2001") => runPython(`${prefix}\n${CODEX_CONFIG_DIRECTORY_ACL.replace("/home/ccc/.codex", configDir)}`, uid);
    const acl = (path = configDir) => {
        const result = runPython(`import errno, json, os, struct, sys
try:
 data = os.getxattr(sys.argv[1], "system.posix_acl_access")
 print(json.dumps(list(struct.iter_unpack("<HHI", data[4:]))))
except OSError as error:
 if error.errno != errno.ENODATA: raise
 print("null")`, path);
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout);
    };
    const metadata = (path = configDir) => {
        const { uid, gid, mode } = realFs.statSync(path);
        return { uid, gid, mode };
    };
    const setAcl = (name: string, entries: number[][]) => {
        const result = runPython(`import json, os, struct, sys
os.setxattr(sys.argv[1], sys.argv[2], struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in json.loads(sys.argv[3])))`, configDir, name, JSON.stringify(entries));
        expect(result.status, result.stderr).toBe(0);
    };

    it("grants only the mapped container user and accepts an identical prior grant", () => {
        chmodSync(configDir, 0o750);
        const before = metadata();
        expect(grant().status).toBe(0);
        expect(metadata()).toMatchObject({ uid: before.uid, gid: before.gid });
        expect(acl()).toEqual([[1, 7, undefinedId], [2, 7, 2001], [4, 5, undefinedId], [16, 7, undefinedId], [32, 0, undefinedId]]);
        const after = metadata();
        expect(grant().status).toBe(0);
        expect(metadata()).toEqual(after);
        expect(readFileSync(configFile, "utf8")).toBe(userConfig);
    });

    it.each([
        ["named user", "system.posix_acl_access", [[1, 7, undefinedId], [2, 7, 3001], [4, 0, undefinedId], [16, 0, undefinedId], [32, 0, undefinedId]]],
        ["masked group", "system.posix_acl_access", [[1, 7, undefinedId], [4, 7, undefinedId], [16, 0, undefinedId], [32, 0, undefinedId]]],
        ["default", "system.posix_acl_default", [[1, 7, undefinedId], [4, 0, undefinedId], [32, 0, undefinedId]]],
    ] as Array<[string, string, number[][]]>)("rejects %s ACL without changing metadata or access", (_kind, attribute, entries) => {
        setAcl(attribute, entries);
        const before = metadata();
        const beforeAcl = acl();
        const result = grant();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("requires manual inspection");
        expect(metadata()).toEqual(before);
        expect(acl()).toEqual(beforeAcl);
    });

    it.each(["getxattr", "setxattr"])("never falls back to chmod when %s is unsupported", operation => {
        const before = metadata();
        const result = grant(`import errno, os
def unsupported(*args): raise OSError(errno.ENOTSUP, "unsupported ACL")
os.${operation} = unsupported`);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("unsupported ACL");
        expect(metadata()).toEqual(before);
        expect(acl()).toBeNull();
    });

    it("refuses widening owner mode when the mapped owner itself lacks access", () => {
        chmodSync(configDir, 0o500);
        const before = metadata();
        try {
            const result = grant("", String(before.uid));
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("directory owner lacks access");
            expect(metadata()).toEqual(before);
            expect(acl()).toBeNull();
        } finally {
            chmodSync(configDir, 0o700);
        }
    });

    it.each(["leaf", "ancestor"])("does not traverse a symlinked %s", kind => {
        const originalDir = configDir;
        if (kind === "leaf") {
            realFs.renameSync(configDir, configDir + "-real");
            realFs.symlinkSync(configDir + "-real", configDir);
        } else {
            const alias = join(state.home, "alias");
            realFs.symlinkSync(state.home, alias);
            configDir = join(alias, "codex");
        }
        const result = grant();
        expect(result.status).toBe(1);
        configDir = originalDir;
        expect(acl(kind === "leaf" ? configDir + "-real" : configDir)).toBeNull();
    });

    it("keeps a substituted path target untouched while operating on its pinned inode", () => {
        const outside = join(state.home, "outside-dir");
        const previous = configDir + "-previous";
        mkdirSync(outside, { mode: 0o700 });
        const before = metadata(outside);
        const result = grant(`import os
original = os.getxattr
swapped = False
def replace_path(*args):
 global swapped
 if not swapped:
  os.rename(${JSON.stringify(configDir)}, ${JSON.stringify(previous)})
  os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(configDir)})
  swapped = True
 return original(*args)
os.getxattr = replace_path`);
        expect(result.status, result.stderr).toBe(0);
        expect(acl(previous)).toContainEqual([2, 7, 2001]);
        expect(acl(outside)).toBeNull();
        expect(metadata(outside)).toEqual(before);
    });
});

it.each(["", "-1", "4294967295", "2001; touch /tmp/unsafe"])("rejects unsafe directory ACL UID %j", uid => {
    expect(() => codexConfigDirectoryAclScript(uid)).toThrow(/invalid container user identity/);
});
