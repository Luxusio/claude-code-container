import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { sshCredentialCopyShell } from "../docker.js";

const marker = ".ccc-known-hosts-origin.json";
const authorityHost = "git.example.test";
const learnedHost = "learned.independent.test";

describe.skipIf(process.platform === "win32")("SSH snapshot authoritative and learned trust", () => {
    let keyRoot: string;
    const keys: string[] = [];
    const roots: string[] = [];
    beforeAll(() => {
        keyRoot = mkdtempSync(join(tmpdir(), "ccc-hostkeys-"));
        for (let index = 0; index < 3; index += 1) {
            const file = join(keyRoot, `key${index}`);
            const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", file], { encoding: "utf8", timeout: 10000 });
            expect(result.status, result.stderr).toBe(0);
            keys.push(readFileSync(`${file}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" "));
        }
    });
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
    afterAll(() => rmSync(keyRoot, { recursive: true, force: true }));

    function fixture() {
        const root = mkdtempSync(join(tmpdir(), "ccc-ssh-trust-"));
        roots.push(root);
        const source = join(root, "source");
        const copied = join(root, "copied");
        mkdirSync(source);
        writeFileSync(join(source, "id_ed25519"), readFileSync(join(keyRoot, "key0")), { mode: 0o600 });
        const run = () => spawnSync("sh", ["-c", sshCredentialCopyShell(), "ccc-ssh-copy", source, copied], { encoding: "utf8", timeout: 5000 });
        const refresh = () => {
            const result = run();
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toBe("");
            expect(result.stderr).toBe("");
            expect(readFileSync(join(copied, ".ccc-copy-complete"), "utf8")).toBe("complete\n");
        };
        return { root, source, copied, run, refresh };
    }
    function entry(root: string, host: string, key: number, hashed = false): string {
        const text = `${host} ${keys[key]}\n`;
        if (!hashed) return text;
        const file = join(root, "hash-input");
        writeFileSync(file, text);
        const result = spawnSync("ssh-keygen", ["-H", "-f", file], { encoding: "utf8", timeout: 5000 });
        expect(result.status, result.stderr).toBe(0);
        return readFileSync(file, "utf8");
    }
    function trusted(copied: string, host: string, key: number): boolean {
        const file = join(copied, "known_hosts");
        if (!existsSync(file)) return false;
        const result = spawnSync("ssh-keygen", ["-F", host, "-f", file], { encoding: "utf8", timeout: 5000 });
        return result.status === 0 && result.stdout.includes(keys[key]);
    }

    it.each([false, true])("preserves locally learned entries while authority is unchanged (hashed=%s)", hashed => {
        const f = fixture();
        writeFileSync(join(f.source, "known_hosts"), entry(f.root, authorityHost, 0, hashed));
        f.refresh();
        appendFileSync(join(f.copied, "known_hosts"), entry(f.root, learnedHost, 2, hashed));
        f.refresh();
        expect(trusted(f.copied, authorityHost, 0)).toBe(true);
        expect(trusted(f.copied, learnedHost, 2)).toBe(true);
        expect(statSync(join(f.copied, marker)).mode & 0o777).toBe(0o600);
    });

    it.each(["plain", "hashed", "wildcard"])("drops superseded authority and ambiguous learned entries on %s key rotation", form => {
        const f = fixture();
        const host = form === "wildcard" ? "*.example.test" : authorityHost;
        writeFileSync(join(f.source, "known_hosts"), entry(f.root, host, 0, form === "hashed"));
        f.refresh();
        appendFileSync(join(f.copied, "known_hosts"), entry(f.root, learnedHost, 2, true));
        writeFileSync(join(f.source, "known_hosts"), entry(f.root, host, 1, form === "hashed"));
        f.refresh();
        expect(trusted(f.copied, authorityHost, 1)).toBe(true);
        expect(trusted(f.copied, authorityHost, 0)).toBe(false);
        expect(trusted(f.copied, learnedHost, 2)).toBe(false);
    });

    it.each(["remove file", "empty file", "remove hashed entry"])("cannot resurrect deleted authoritative trust: %s", action => {
        const f = fixture();
        const file = join(f.source, "known_hosts");
        writeFileSync(file, entry(f.root, authorityHost, 0, action === "remove hashed entry"));
        f.refresh();
        appendFileSync(join(f.copied, "known_hosts"), entry(f.root, learnedHost, 2, true));
        if (action === "remove file") rmSync(file);
        else writeFileSync(file, "");
        f.refresh();
        expect(trusted(f.copied, authorityHost, 0)).toBe(false);
        expect(trusted(f.copied, learnedHost, 2)).toBe(false);
    });

    it("preserves learned entries across stable absence of host authority", () => {
        const f = fixture();
        f.refresh();
        writeFileSync(join(f.copied, "known_hosts"), entry(f.root, learnedHost, 2, true));
        f.refresh();
        expect(trusted(f.copied, learnedHost, 2)).toBe(true);
        writeFileSync(join(f.source, "known_hosts"), entry(f.root, authorityHost, 1));
        f.refresh();
        expect(trusted(f.copied, learnedHost, 2)).toBe(false);
    });

    it.each(["missing", "malformed", "symlink", "writable", "wrong schema"])("uses only authority when previous provenance is %s", fault => {
        const f = fixture();
        writeFileSync(join(f.source, "known_hosts"), entry(f.root, authorityHost, 0));
        f.refresh();
        appendFileSync(join(f.copied, "known_hosts"), entry(f.root, learnedHost, 2));
        const provenance = join(f.copied, marker);
        const sentinel = join(f.root, "sentinel");
        writeFileSync(sentinel, readFileSync(provenance), { mode: 0o640 });
        const before = readFileSync(sentinel, "utf8");
        if (fault === "missing") rmSync(provenance);
        if (fault === "malformed") writeFileSync(provenance, "{bad-json");
        if (fault === "wrong schema") writeFileSync(provenance, JSON.stringify({ version: 1 }));
        if (fault === "writable") chmodSync(provenance, 0o666);
        if (fault === "symlink") { rmSync(provenance); symlinkSync(sentinel, provenance); }
        f.refresh();
        expect(trusted(f.copied, authorityHost, 0)).toBe(true);
        expect(trusted(f.copied, learnedHost, 2)).toBe(false);
        expect(readFileSync(sentinel, "utf8")).toBe(before);
        expect(statSync(sentinel).mode & 0o777).toBe(0o640);
    });

    it("does not follow source or copied known_hosts symlinks", () => {
        const f = fixture();
        writeFileSync(join(f.source, "known_hosts"), entry(f.root, authorityHost, 0));
        f.refresh();
        const sentinel = join(f.root, "sentinel");
        const bytes = entry(f.root, learnedHost, 2);
        writeFileSync(sentinel, bytes, { mode: 0o640 });
        rmSync(join(f.copied, "known_hosts"));
        symlinkSync(sentinel, join(f.copied, "known_hosts"));
        f.refresh();
        expect(trusted(f.copied, learnedHost, 2)).toBe(false);
        rmSync(join(f.source, "known_hosts"));
        symlinkSync(sentinel, join(f.source, "known_hosts"));
        f.refresh();
        expect(lstatSync(join(f.copied, "known_hosts")).isSymbolicLink()).toBe(true);
        expect(existsSync(join(f.copied, marker))).toBe(false);
        expect(readFileSync(sentinel, "utf8")).toBe(bytes);
        expect(statSync(sentinel).mode & 0o777).toBe(0o640);
    });

    it("invalidates old credentials on provenance-write failure without printing key material", () => {
        const f = fixture();
        writeFileSync(join(f.source, "known_hosts"), entry(f.root, authorityHost, 0));
        f.refresh();
        mkdirSync(join(f.source, marker));
        const result = f.run();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
        expect(existsSync(f.copied)).toBe(false);
    });
});
