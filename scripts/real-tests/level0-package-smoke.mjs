import assert from "assert";
import { existsSync } from "fs";
import { join } from "path";
import { repoRoot } from "./helpers.mjs";
import { runInstalledMcpSmoke } from "./installed-mcp-smoke.mjs";

export const name = "level 0 package smoke";

export async function run() {
    assert.strictEqual(existsSync(join(repoRoot, "dist", "index.js")), true);
    assert.strictEqual(existsSync(join(repoRoot, "dist", "device-lab-mcp", "server.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "dist", "lab-mcp", "server.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "device-lab-mcp", "src", "state", "ios-state.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "device-lab-mcp", "src", "state", "macos-state.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "device-lab-mcp", "src", "state", "ios-device-state.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "device-lab-mcp", "src", "state", "physical-lease-store.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "test-level.js")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "run.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "assert-json.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "assert-matrix.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "summarize-json.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "installed-mcp-smoke.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "helpers.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "android-emulator-e2e.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "ios-e2e.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "macos-vm-e2e.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "windows-sandbox-e2e.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level0-package-smoke.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level1-real-provider-readiness.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level1-dist-real-provider-readiness.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "provider-mcp-matrix.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level1-display-e2e.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-host-integration-slots.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-dist-broker-e2e.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-ios-e2e.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-android-emulator-e2e.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-macos-vm-e2e.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-windows-sandbox.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-real-linux-vm.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level3-real-destructive.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level3.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level3-vitest.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "vitest.level3.config.mjs")), true);
    const installedMcpSmoke = await runInstalledMcpSmoke({
        name: "ccc-level0-installed-device-lab-mcp-smoke",
        serverPath: join(repoRoot, "dist", "device-lab-mcp", "server.mjs"),
    });
    assert.strictEqual(installedMcpSmoke.status, "PASS");
    assert.strictEqual(installedMcpSmoke.publicDispatchTools, installedMcpSmoke.tools);
    assert.ok(installedMcpSmoke.currentDisplayAliases.includes("device_status"));
    return { status: "PASS", installedMcpSmoke };
}
