import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import {
    commitLocalOutputStage,
    createLocalOutputStage,
    populateLocalOutputStage,
    restoreLocalOutputStage,
    stageLocalInputFile,
} from "@ccc/device-lab/providers/transfer-file.mjs";

describe("device-lab transfer file boundaries", () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    function tempRoot() {
        const root = mkdtempSync(join(tmpdir(), "ccc-transfer-file-"));
        roots.push(root);
        return root;
    }

    it("stages a stable upload snapshot and removes it on cleanup", () => {
        const source = join(tempRoot(), "upload.txt");
        writeFileSync(source, "before");
        const staged = stageLocalInputFile(source);
        expect(staged.ok).toBe(true);
        if (!staged.ok) return;

        writeFileSync(source, "after");
        expect(readFileSync(staged.stagedPath, "utf8")).toBe("before");
        staged.cleanup();
        expect(existsSync(staged.stagedPath)).toBe(false);
    });

    it("supports owned transfer stages under an aliased system temporary directory without accepting caller aliases", (context) => {
        const root = realpathSync(tempRoot());
        const actual = join(root, "actual");
        const alias = join(root, "temporary-alias");
        mkdirSync(actual);
        try { symlinkSync(actual, alias, "junction"); }
        catch (error) {
            if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) {
                context.skip(true, "Windows directory links require privilege"); return;
            }
            throw error;
        }
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
const { stageLocalInputFile, createLocalOutputStage, populateLocalOutputStage, commitLocalOutputStage,
    restoreLocalOutputStage, discardLocalOutputStage } = await import(process.argv[1]);
const actual = process.argv[2], alias = process.argv[3];
const source = join(actual, 'source.txt'), destination = join(actual, 'destination.bin');
fs.writeFileSync(source, 'before');
const input = stageLocalInputFile(source);
assert.equal(input.ok, true);
assert.equal(input.stagedPath, fs.realpathSync(input.stagedPath));
fs.writeFileSync(source, 'after');
assert.equal(fs.readFileSync(input.stagedPath, 'utf8'), 'before');
input.cleanup();
assert.equal(fs.existsSync(input.stagedPath), false);

const output = createLocalOutputStage(destination);
assert.equal(output.ok, true);
assert.equal(output.stageRoot, fs.realpathSync(output.stageRoot));
assert.equal(populateLocalOutputStage(source, output).ok, true);
const restored = restoreLocalOutputStage(destination, output.stagedPath);
assert.equal(restored.ok, true);
assert.equal(commitLocalOutputStage(restored).ok, true);
assert.equal(fs.readFileSync(destination, 'utf8'), 'after');
assert.equal(discardLocalOutputStage(restored.stagedPath).ok, true);
assert.equal(fs.existsSync(restored.stageRoot), false);
assert.equal(fs.readFileSync(destination, 'utf8'), 'after');

assert.equal(stageLocalInputFile(join(alias, 'source.txt')).error, 'upload-local-path-symlink-ancestor-rejected');
assert.equal(createLocalOutputStage(join(alias, 'caller-output.bin')).error, 'download-local-path-symlink-ancestor-rejected');
const explicitOptions = { stageParent: alias, stagePrefix: '.explicit-stage-' };
const explicit = createLocalOutputStage(destination, explicitOptions);
assert.equal(explicit.ok, true);
assert.equal(dirname(explicit.stageRoot), alias);
fs.writeFileSync(explicit.stagedPath, 'unpublished');
assert.equal(restoreLocalOutputStage(destination, explicit.stagedPath, explicitOptions).ok, true);
assert.equal(commitLocalOutputStage(explicit).error, 'download-local-path-stage-symlink-ancestor-rejected');
assert.equal(discardLocalOutputStage(explicit.stagedPath, explicitOptions).ok, true);
assert.equal(fs.existsSync(explicit.stageRoot), false);
assert.equal(fs.readFileSync(destination, 'utf8'), 'after');
console.log(JSON.stringify({ completed: true }));
`, new URL("../../packages/device-lab/providers/transfer-file.mjs", import.meta.url).href, actual, alias], {
            encoding: "utf8", timeout: 15000,
            env: {...process.env, HOME: root, USERPROFILE: root, TMPDIR: alias, TMP: alias, TEMP: alias},
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({completed: true});
    });

    it("fails without creating a missing default temporary parent or publishing a destination", () => {
        const root = realpathSync(tempRoot());
        const missing = join(root, "missing-temporary-parent");
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import fs from 'node:fs';
import { join } from 'node:path';
const { stageLocalInputFile, createLocalOutputStage, restoreLocalOutputStage,
    discardLocalOutputStage } = await import(process.argv[1]);
const root = process.argv[2], missing = process.argv[3];
const source = join(root, 'source.txt'), destination = join(root, 'destination.bin');
fs.writeFileSync(source, 'safe source');
fs.writeFileSync(destination, 'original destination');
const unallocatedPayload = join(missing, 'ccc-device-download-unallocated', 'payload');
const results = [stageLocalInputFile(source), createLocalOutputStage(destination),
    restoreLocalOutputStage(destination, unallocatedPayload), discardLocalOutputStage(unallocatedPayload)];
console.log(JSON.stringify({ ok: results.map(result => result.ok), parentCreated: fs.existsSync(missing),
    source: fs.readFileSync(source, 'utf8'), destination: fs.readFileSync(destination, 'utf8') }));
`, new URL("../../packages/device-lab/providers/transfer-file.mjs", import.meta.url).href, root, missing], {
            encoding: "utf8", timeout: 15000,
            env: {...process.env, HOME: root, USERPROFILE: root, TMPDIR: missing, TMP: missing, TEMP: missing},
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ok: [false, false, false, false], parentCreated: false,
            source: "safe source", destination: "original destination"});
    });

    it("regression: native transfer cleanup reports a failed owned removal", () => {
        const root = tempRoot();
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const { stageLocalInputFile } = await import(process.argv[1]);
const source = join(process.argv[2], 'source.txt');
fs.writeFileSync(source, 'snapshot');
const stage = stageLocalInputFile(source);
if (!stage.ok) throw new Error('fixture staging failed');
const ownedRoot = dirname(stage.stagedPath), originalRemove = fs.rmSync;
const removalError = Object.assign(new Error('private removal failure'), { code: 'EPERM' });
let attempts = 0, caught = false, code, sameError = false;
try {
    fs.rmSync = (target, options) => {
        if (String(target) === ownedRoot) { attempts++; throw removalError; }
        return originalRemove(target, options);
    };
    syncBuiltinESMExports();
    try { stage.cleanup(); } catch (error) { caught = true; code = error?.code; sameError = error === removalError; }
    console.log(JSON.stringify({ caught, code, sameError, attempts, retainedBytes: fs.readFileSync(stage.stagedPath, 'utf8') }));
} finally {
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    originalRemove(ownedRoot, { recursive: true, force: true });
}
`, new URL("../../packages/device-lab/providers/transfer-file.mjs", import.meta.url).href, root], {
            encoding: "utf8", timeout: 15000,
            env: {...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root},
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({caught: true, code: "EPERM", sameError: true, attempts: 1, retainedBytes: "snapshot"});
    });

    it.each(["output", "restored"])("reports %s stage cleanup failure without removing or undoing owned output", mode => {
        const root = tempRoot();
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const { createLocalOutputStage, restoreLocalOutputStage, commitLocalOutputStage } = await import(process.argv[1]);
const parent = process.argv[2], mode = process.argv[3], destination = join(parent, 'destination.bin');
fs.writeFileSync(destination, 'original');
const options = { stageParent: parent, stagePrefix: '.owned-stage-' };
const allocated = createLocalOutputStage(destination, options);
if (!allocated.ok) throw new Error('fixture allocation failed');
fs.writeFileSync(allocated.stagedPath, 'snapshot');
const stage = mode === 'restored' ? restoreLocalOutputStage(destination, allocated.stagedPath, options) : allocated;
if (!stage.ok) throw new Error('fixture restore failed');
if (mode === 'output' && !commitLocalOutputStage(stage).ok) throw new Error('fixture publication failed');
const originalRemove = fs.rmSync, removalError = Object.assign(new Error('private removal'), { code: 'EPERM' });
let attempts = 0, sameError = false;
try {
    fs.rmSync = (target, options) => {
        if (String(target) === allocated.stageRoot) { attempts++; throw removalError; }
        return originalRemove(target, options);
    };
    syncBuiltinESMExports();
    try { stage.cleanup(); } catch (error) { sameError = error === removalError; }
    console.log(JSON.stringify({ sameError, attempts, retainedBytes: fs.readFileSync(stage.stagedPath, 'utf8'), destinationBytes: fs.readFileSync(destination, 'utf8') }));
} finally {
    fs.rmSync = originalRemove; syncBuiltinESMExports();
    originalRemove(allocated.stageRoot, { recursive: true, force: true });
}
`, new URL("../../packages/device-lab/providers/transfer-file.mjs", import.meta.url).href, root, mode], {
            encoding: "utf8", timeout: 15000,
            env: {...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root},
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({sameError: true, attempts: 1, retainedBytes: "snapshot", destinationBytes: mode === "output" ? "snapshot" : "original"});
    });

    it("retains the failed input staging result and cleanup error with exactly one removal attempt", () => {
        const root = tempRoot();
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const { stageLocalInputFile } = await import(process.argv[1]);
const parent = process.argv[2], source = join(parent, 'source.txt');
fs.writeFileSync(source, 'api_key=abcdefghijklmnop');
const originalCreate = fs.mkdtempSync, originalRemove = fs.rmSync;
const removalError = Object.assign(new Error('private removal failure'), { code: 'EPERM' });
let ownedRoot, attempts = 0, failure;
try {
    fs.mkdtempSync = (...args) => {
        const created = originalCreate(...args);
        if (String(args[0]).startsWith(join(parent, 'ccc-device-upload-'))) ownedRoot = created;
        return created;
    };
    fs.rmSync = (target, options) => {
        if (ownedRoot && String(target) === ownedRoot) { attempts++; throw removalError; }
        return originalRemove(target, options);
    };
    syncBuiltinESMExports();
    try { stageLocalInputFile(source); } catch (error) { failure = error; }
    console.log(JSON.stringify({ aggregate: failure instanceof AggregateError, message: failure?.message,
        errorCount: failure?.errors?.length, causeSame: failure?.cause === failure?.errors?.[0],
        primary: { ok: failure?.cause?.ok, error: failure?.cause?.error, sourceMatches: failure?.cause?.path === source },
        cleanupSame: failure?.errors?.[1] === removalError, attempts,
        retainedBytes: ownedRoot && fs.readFileSync(join(ownedRoot, 'payload'), 'utf8') }));
} finally {
    fs.mkdtempSync = originalCreate; fs.rmSync = originalRemove; syncBuiltinESMExports();
    if (ownedRoot) originalRemove(ownedRoot, { recursive: true, force: true });
}
`, new URL("../../packages/device-lab/providers/transfer-file.mjs", import.meta.url).href, root], {
            encoding: "utf8", timeout: 15000,
            env: {...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root},
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({aggregate: true, message: "Transfer staging and cleanup failed.", errorCount: 2,
            causeSame: true, primary: {ok: false, error: "upload-local-path-secret-content", sourceMatches: true},
            cleanupSame: true, attempts: 1, retainedBytes: "api_key=abcdefghijklmnop"});
    });

    it("reports failed discard and refuses foreign stage paths before removal", () => {
        const root = tempRoot();
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const { createLocalOutputStage, discardLocalOutputStage } = await import(process.argv[1]);
const parent = process.argv[2], options = { stageParent: parent, stagePrefix: '.owned-stage-' };
const stage = createLocalOutputStage(join(parent, 'destination.bin'), options);
if (!stage.ok) throw new Error('fixture allocation failed');
fs.writeFileSync(stage.stagedPath, 'owned bytes');
const foreign = join(parent, 'foreign'), foreignPayload = join(foreign, 'payload');
fs.mkdirSync(foreign); fs.writeFileSync(foreignPayload, 'foreign bytes');
const originalRemove = fs.rmSync;
let attempts = 0;
try {
    fs.rmSync = (target, options) => {
        if (String(target) === stage.stageRoot) { attempts++; throw Object.assign(new Error('private stage ' + stage.stageRoot), { code: 'EPERM' }); }
        if (String(target) === foreign) throw new Error('foreign removal attempted');
        return originalRemove(target, options);
    };
    syncBuiltinESMExports();
    const refused = discardLocalOutputStage(foreignPayload, options);
    const failed = discardLocalOutputStage(stage.stagedPath, options);
    console.log(JSON.stringify({ refused, failed, attempts, ownedBytes: fs.readFileSync(stage.stagedPath, 'utf8'), foreignBytes: fs.readFileSync(foreignPayload, 'utf8') }));
} finally {
    fs.rmSync = originalRemove; syncBuiltinESMExports();
    originalRemove(stage.stageRoot, { recursive: true, force: true });
    originalRemove(foreign, { recursive: true, force: true });
}
`, new URL("../../packages/device-lab/providers/transfer-file.mjs", import.meta.url).href, root], {
            encoding: "utf8", timeout: 15000,
            env: {...process.env, HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root},
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            refused: {ok: false, error: "download-local-path-stage-path-invalid", message: "download-local-path-stage-path-invalid"},
            failed: {ok: false, error: "download-local-path-stage-cleanup-failed", message: "download-local-path-stage-cleanup-failed"},
            attempts: 1, ownedBytes: "owned bytes", foreignBytes: "foreign bytes",
        });
    });

    it("rejects linked and secret upload content after staging", () => {
        const root = tempRoot();
        const source = join(root, "upload.txt");
        const hard = join(root, "hard.txt");
        writeFileSync(source, "safe");
        linkSync(source, hard);
        expect(stageLocalInputFile(source)).toEqual(expect.objectContaining({ ok: false, error: "upload-local-path-state-invalid" }));

        const secret = join(root, "payload.txt");
        writeFileSync(secret, "api_key=abcdefghijklmnop");
        expect(stageLocalInputFile(secret)).toEqual(expect.objectContaining({ ok: false, error: "upload-local-path-secret-content" }));
    });

    it("preserves an existing destination on failed commit", () => {
        const destination = join(tempRoot(), "download.bin");
        writeFileSync(destination, "original");
        const stage = createLocalOutputStage(destination);
        expect(stage.ok).toBe(true);
        if (!stage.ok) return;
        writeFileSync(stage.stagedPath, "too-large");

        expect(commitLocalOutputStage(stage, { limitBytes: 3 })).toEqual(expect.objectContaining({ ok: false }));
        expect(readFileSync(destination, "utf8")).toBe("original");
        stage.cleanup();
    });

    it("rejects a replaced final destination link without changing its target", (context) => {
        const root = tempRoot();
        const external = join(root, "external.bin");
        const destination = join(root, "download.bin");
        const source = join(root, "remote.bin");
        writeFileSync(external, "external");
        writeFileSync(source, "downloaded");
        const stage = createLocalOutputStage(destination);
        expect(stage.ok).toBe(true);
        if (!stage.ok) return;
        const populated = populateLocalOutputStage(source, stage);
        expect(populated.ok).toBe(true);
        try { symlinkSync(external, destination); }
        catch (error) {
            stage.cleanup();
            if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) {
                context.skip(true, "Windows file symlinks require Developer Mode or privilege"); return;
            }
            throw error;
        }

        expect(commitLocalOutputStage(stage)).toEqual(expect.objectContaining({ ok: false, error: "download-local-path-symlink-rejected" }));
        expect(readFileSync(external, "utf8")).toBe("external");
        stage.cleanup();
    });

    it("restores only an expected persistent stage and enforces recording minimum size", () => {
        const root = tempRoot();
        const destination = join(root, "recording.mp4");
        const stageParent = join(root, "recordings");
        const stage = createLocalOutputStage(destination, {
            stageParent,
            stagePrefix: ".recording-stage-",
        });
        expect(stage.ok).toBe(true);
        if (!stage.ok) return;
        writeFileSync(stage.stagedPath, "");

        const restored = restoreLocalOutputStage(destination, stage.stagedPath, {
            stageParent,
            stagePrefix: ".recording-stage-",
        });
        expect(restored.ok).toBe(true);
        if (!restored.ok) return;
        expect(commitLocalOutputStage(restored, { minBytes: 1 })).toEqual(expect.objectContaining({
            ok: false,
            error: "download-local-path-stage-file-too-small",
        }));
        expect(existsSync(destination)).toBe(false);
        expect(restoreLocalOutputStage(destination, join(root, "foreign", "payload"), {
            stageParent,
            stagePrefix: ".recording-stage-",
        })).toEqual(expect.objectContaining({ ok: false, error: "download-local-path-stage-path-invalid" }));
        restored.cleanup();
        expect(existsSync(stage.stagedPath)).toBe(false);
    });
});
