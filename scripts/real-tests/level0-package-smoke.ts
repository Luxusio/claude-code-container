import assert from "assert";
import { existsSync } from "fs";
import { join } from "path";
import { repoRoot } from "./helpers.ts";
import { runInstalledMcpSmoke } from "./installed-mcp-smoke.ts";

export const name = "level 0 package smoke";

export async function run() {
    assert.strictEqual(existsSync(join(repoRoot, "dist", "index.js")), true);
    assert.strictEqual(existsSync(join(repoRoot, "dist", "device-lab-mcp", "server.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "host-control", "hyper-v", "Ccc.HyperV.Core.psm1")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "host-control", "hyper-v", "Get-LinuxBootstrapNetwork.ps1")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "host-control", "hyper-v", "Get-GuestBootDiagnostic.ps1")), true);
    assert.strictEqual(existsSync(join(repoRoot, "dist", "lab-mcp", "server.mjs")), false);
    assert.strictEqual(existsSync(join(repoRoot, "device-lab-mcp", "src", "state", "ios-state.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "device-lab-mcp", "src", "state", "macos-state.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "device-lab-mcp", "src", "state", "ios-device-state.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "device-lab-mcp", "src", "state", "physical-lease-store.mjs")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "test-level.js")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "run.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "assert-json.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "assert-matrix.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "summarize-json.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "installed-mcp-smoke.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "helpers.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "android-emulator-e2e.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "ios-e2e.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "macos-vm-e2e.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "windows-sandbox-e2e.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level0-package-smoke.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level1-real-provider-readiness.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level1-dist-real-provider-readiness.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "provider-mcp-matrix.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level1-display-e2e.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-host-integration-slots.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-dist-broker-e2e.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-ios-e2e.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-android-emulator-e2e.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-macos-vm-e2e.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-windows-sandbox.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-hyper-v-windows-vm.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-hyper-v-linux-vm.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level2-real-linux-vm.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level3-real-destructive.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level3.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "level3-vitest.ts")), true);
    assert.strictEqual(existsSync(join(repoRoot, "scripts", "real-tests", "vitest.level3.config.ts")), true);
    const installedMcpSmoke = await runInstalledMcpSmoke({
        name: "ccc-level0-installed-device-lab-mcp-smoke",
        serverPath: join(repoRoot, "dist", "device-lab-mcp", "server.mjs"),
    });
    assert.strictEqual(installedMcpSmoke.status, "PASS");
    assert.strictEqual(installedMcpSmoke.publicDispatchTools, installedMcpSmoke.tools);
    assert.ok(installedMcpSmoke.currentDisplayAliases.includes("device_status"));
    return { status: "PASS", installedMcpSmoke };
}
