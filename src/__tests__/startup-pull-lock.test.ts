import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

it.skipIf(process.platform === "win32")("releases the startup lock after a real child-process image pull failure and allows immediate retry", () => {
    const home = mkdtempSync(join(tmpdir(), "ccc-pull-lock-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!${process.execPath}
const args = process.argv.slice(2);
const command = args.find(value => ['context', '--version', 'info', 'images', 'pull'].includes(value));
if (command === 'context') console.log(JSON.stringify({Name: 'default', Endpoints: {docker: {Host: 'unix:///fixture/engine.sock'}}}));
else if (command === '--version') console.log('Docker version 27.0.0');
else if (command === 'info') console.log(args.includes('{{.OperatingSystem}}') ? 'Fixture Linux' : '[]');
else if (command === 'images') process.exit(0);
else if (command === 'pull') { require('node:fs').appendFileSync(process.env.CCC_TEST_CALLS, 'pull\\n'); process.exit(1); }
else process.exit(93);
`, { mode: 0o700 });
    const module = new URL("../docker.ts", import.meta.url).href;
    const imageBuilder = fileURLToPath(new URL("../../scripts/build-distribution-image.mjs", import.meta.url));
    const buildInstruction = `node '${imageBuilder.replaceAll("'", "'\\''")}' --runtime docker`;
    const script = `
        import { startProjectContainer } from ${JSON.stringify(module)};
        import { existsSync } from 'node:fs';
        import { join } from 'node:path';
        try {
            startProjectContainer(process.env.HOME, () => {
                if (!existsSync(join(process.env.HOME, '.ccc', 'codex-state.lock'))) throw new Error('lock not held');
            });
            process.exitCode = 94;
        } catch (error) {
            console.error(error.message);
            process.exitCode = error.message.includes('Failed to pull') ? 17 : 95;
        }
    `;
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
                cwd: fileURLToPath(new URL("../../", import.meta.url)),
                env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CCC_RUNTIME: "docker", CCC_TEST_CALLS: join(home, "calls"), container: "" },
                encoding: "utf8", timeout: 15_000,
            });
            expect(child.error).toBeUndefined();
            expect(child.status, child.stderr).toBe(17);
            expect(child.stderr).toContain(buildInstruction);
            expect(existsSync(join(home, ".ccc", "codex-state.lock"))).toBe(false);
        }
        expect(readFileSync(join(home, "calls"), "utf8")).toBe("pull\npull\n");
    } finally { rmSync(home, { recursive: true, force: true }); }
});
