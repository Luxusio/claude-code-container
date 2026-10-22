import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("unit temporary root", () => {
    it.skipIf(process.platform === "win32")("canonicalizes an aliased base and still rejects links inside a fixture", () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "ccc-temp-base-")));
        try {
            const target = join(root, "target"), alias = join(root, "alias");
            mkdirSync(target);
            symlinkSync(target, alias, "dir");
            const policy = pathToFileURL(join(import.meta.dirname, "../../packages/device-lab/providers/policy/files.mjs")).href;
            const result = spawnSync(process.execPath, ["--require", join(import.meta.dirname, "../../scripts/test-temp-root.cjs"), "--input-type=module", "-e", `
                import fs from 'node:fs';
                import os from 'node:os';
                import path from 'node:path';
                const {validateLocalInputPath,validateLocalOutputPath} = await import(${JSON.stringify(policy)});
                const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-'));
                const source = path.join(fixture, 'source.txt'), link = path.join(fixture, 'linked');
                fs.writeFileSync(source, 'safe');
                fs.symlinkSync(fixture, link, 'dir');
                process.stdout.write(JSON.stringify({
                    temporary: os.tmpdir(),
                    input: validateLocalInputPath(source),
                    output: validateLocalOutputPath(path.join(link, 'out.txt')),
                    traversal: validateLocalInputPath(link + '/../source.txt'),
                }));
            `], { env: { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias }, encoding: "utf8" });
            expect(result.status, result.stderr).toBe(0);
            const observed = JSON.parse(result.stdout);
            expect(observed.temporary).toBe(target);
            expect(observed.input).toMatchObject({ ok: true });
            expect(observed.output).toMatchObject({ ok: false, error: "local-output-path-symlink-ancestor-rejected" });
            expect(observed.traversal).toMatchObject({ ok: false, error: "local-input-path-symlink-ancestor-rejected" });
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
