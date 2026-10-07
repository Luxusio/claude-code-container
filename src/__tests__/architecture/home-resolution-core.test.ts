import { describe, expect, it } from "vitest";
import { posix } from "node:path";
import { createHomeLayoutPaths } from "../../application/home/layout-paths.js";
import type { HomePathPorts } from "../../ports/home/layout-paths.js";

function fixture(entries: string[] = ["claude", "claude.json", "codex"]) {
    const trace: unknown[][] = [], present = new Set<string>(); let home = "/home/one";
    const ports: HomePathPorts = {
        homeDirectory() { expect(this).toBe(ports); trace.push(["home"]); return home; },
        joinHostPath(...parts) { expect(this).toBe(ports); trace.push(["join", ...parts]); return posix.join(...parts); },
        entryExists(path) { expect(this).toBe(ports); trace.push(["exists", path]); return present.has(path); },
        createDirectory(path, options) { expect(this).toBe(ports); trace.push(["mkdir", path, options]); return undefined; },
        writeMarker(path, content, options) { expect(this).toBe(ports); trace.push(["write", path, content, options]); return undefined; },
    };
    const paths = createHomeLayoutPaths(ports, "default", ".marker", entries);
    return { paths, ports, trace, present, changeHome(value: string) { home = value; } };
}
const base = "/home/one/.ccc", next = `${base}/profiles/default`;
const profiles = [ ["profileClaudeDir", "claude"], ["profileClaudeJsonFile", "claude.json"], ["profileCodexDir", "codex"] ] as const;
describe("home resolution complete policy", () => {
    it("constructs without observing ports and keeps live homes and sixteen operations", () => {
        const f = fixture(); expect(f.trace).toEqual([]); expect(Object.keys(f.paths)).toHaveLength(16);
        const simple = { cccHome: base, profilesDir: `${base}/profiles`, defaultProfileDir: next, runDir: `${base}/run`, configFile: `${base}/config.json`, legacyRemoteConfigDir: `${base}/remote` };
        for (const [name, expected] of Object.entries(simple)) expect(f.paths[name as keyof typeof simple]()).toBe(expected);
        f.changeHome("/home/two"); expect(f.paths.configFile()).toBe("/home/two/.ccc/config.json");
    });
    for (const [method, entry] of profiles) {
        it(`${method} named profiles bypass all existence queries`, () => {
            const f = fixture(); expect(f.paths[method]("work")).toBe(`${base}/profiles/work/${entry}`);
            expect(f.trace).toEqual([["home"], ["join", "/home/one", ".ccc"], ["join", base, "profiles"], ["join", `${base}/profiles`, "work", entry]]);
        });
        it.each([undefined, "", "default"])(`${method} fresh default alias %s probes ordered provenance`, alias => {
            const f = fixture(); expect(f.paths[method](alias)).toBe(`${next}/${entry}`);
            expect(f.trace.filter(([name]) => name === "exists")).toEqual([["exists", `${next}/.marker`], ...["claude", "claude.json", "codex"].map(e => ["exists", `${base}/${e}`])]);
        });
        it.each(["claude", "claude.json", "codex"])(`${method} any unmarked legacy %s preserves even absent requested entry`, legacy => {
            const f = fixture(); f.present.add(`${base}/${legacy}`); expect(f.paths[method]()).toBe(`${base}/${entry}`);
            expect(f.trace.filter(([name]) => name === "exists")).toEqual([["exists", `${next}/.marker`], ...["claude", "claude.json", "codex"].slice(0, ["claude", "claude.json", "codex"].indexOf(legacy) + 1).map(e => ["exists", `${base}/${e}`])]);
        });
        it.each([[false, false], [false, true], [true, false], [true, true]])(`${method} marked old/new %s/%s is lazy`, (old, migrated) => {
            const f = fixture(); f.present.add(`${next}/.marker`); if (old) f.present.add(`${base}/${entry}`); if (migrated) f.present.add(`${next}/${entry}`);
            expect(f.paths[method]()).toBe(old && !migrated ? `${base}/${entry}` : `${next}/${entry}`);
            expect(f.trace.filter(([name]) => name === "exists")).toEqual([["exists", `${next}/.marker`], ["exists", `${base}/${entry}`], ...(old ? [["exists", `${next}/${entry}`]] : [])]);
        });
    }
    for (const [method, entry] of [["locksDir", "locks"], ["clipboardFilesDir", "clipboard-files"], ["helperBinDir", "bin"]] as const) {
        it.each([[false, false], [false, true], [true, false], [true, true]])(`${method} legacy/run %s/%s`, (old, migrated) => {
            const f = fixture(); if (old) f.present.add(`${base}/${entry}`); if (migrated) f.present.add(`${base}/run/${entry}`);
            expect(f.paths[method]()).toBe(old && !migrated ? `${base}/${entry}` : `${base}/run/${entry}`);
            expect(f.trace[0]).toEqual(["join", "run", entry]);
            expect(f.trace.filter(([name]) => name === "exists")).toEqual([["exists", `${base}/${entry}`], ...(old ? [["exists", `${base}/run/${entry}`]] : [])]);
        });
    }
    it("retains the original entries reference", () => { const entries: string[] = []; const f = fixture(entries); entries.push("custom"); f.present.add(`${base}/custom`); expect(f.paths.profileClaudeDir()).toBe(`${base}/claude`); });
    it.each([false, true])("ensures directory twice and writes only an absent marker (%s)", exists => {
        const f = fixture(); if (exists) f.present.add(`${next}/.marker`); expect(f.paths.ensureDefaultProfileDir()).toBeUndefined();
        expect(f.trace.filter(([name]) => name === "home")).toHaveLength(2);
        expect(f.trace.filter(([name]) => ["mkdir", "exists", "write"].includes(name as string))).toEqual([["mkdir", next, { recursive: true, mode: 0o700 }], ["exists", `${next}/.marker`], ...(exists ? [] : [["write", `${next}/.marker`, "", { mode: 0o600 }]])]);
    });
    it.each(["legacy", "run", "none"])("clipboard port %s inode priority and startup namespace", kind => {
        const f = fixture(); if (kind !== "none") f.present.add(kind === "legacy" ? `${base}/clipboard.port` : `${base}/run/clipboard.port`);
        expect(f.paths.clipboardPortFile()).toBe(`${base}${kind === "legacy" ? "" : "/run"}/clipboard.port`);
        expect(f.trace.filter(([name]) => name === "exists").slice(0, kind === "legacy" ? 1 : 2)).toEqual([["exists", `${base}/clipboard.port`], ...(kind === "legacy" ? [] : [["exists", `${base}/run/clipboard.port`]])]);
        f.present.add(`${base}/locks`); expect(f.paths.clipboardStateDir()).toBe(base); expect(f.paths.clipboardStartingLock()).toBe(`${base}/clipboard.starting.v2`);
        f.present.add(`${base}/run/locks`); expect(f.paths.clipboardStartingLock()).toBe(`${base}/run/clipboard.starting.v2`);
    });
    it("compares locks with a freshly resolved home and resolves the chosen output again", () => {
        const f = fixture(); f.present.add(`${base}/locks`); let n = 0;
        Object.defineProperty(f.ports, "homeDirectory", { value() { return ["/home/one", "/home/two", "/home/three"][n++]!; } });
        expect(f.paths.clipboardStateDir()).toBe("/home/three/.ccc/run"); expect(n).toBe(3);
    });
    it.each(["homeDirectory", "joinHostPath", "entryExists", "createDirectory", "writeMarker"] as const)("propagates %s failure by identity", key => {
        const f = fixture(), error = { key }; Object.defineProperty(f.ports, key, { value() { throw error; } });
        let caught: unknown; try { f.paths.ensureDefaultProfileDir(); } catch (value) { caught = value; } expect(caught).toBe(error);
        expect(f.trace.some(([name]) => name === "write")).toBe(false);
    });
    it("looks up path ports lazily and propagates throwing capability getters", () => {
        for (const key of ["homeDirectory", "joinHostPath", "entryExists", "createDirectory", "writeMarker"] as const) {
            const f = fixture(), error = { getter: key }; let reads = 0;
            Object.defineProperty(f.ports, key, { get() { reads++; throw error; } });
            const paths = createHomeLayoutPaths(f.ports, "default", ".marker", []); expect(reads).toBe(0);
            let caught: unknown; try { paths.ensureDefaultProfileDir(); } catch (value) { caught = value; }
            expect(caught).toBe(error); expect(reads).toBe(1);
        }
    });

});
