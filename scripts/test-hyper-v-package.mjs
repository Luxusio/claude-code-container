import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { pathToFileURL } from "url";

const root = new URL("../", import.meta.url);
const temporaryRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-package-"));

function run(executable, args, cwd = root) {
    const result = spawnSync(executable, args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        throw new Error(result.error?.message || result.stderr || `${executable} exited ${result.status}`);
    }
    return result.stdout;
}

try {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm CLI path is unavailable for packaged Hyper-V probe");
    const packed = JSON.parse(run(process.execPath, [
        npmCli,
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        temporaryRoot,
    ]));
    const filename = packed?.[0]?.filename;
    if (typeof filename !== "string" || !filename.endsWith(".tgz")) throw new Error("npm pack returned no archive");

    run("tar", ["-xzf", join(temporaryRoot, filename), "-C", temporaryRoot]);
    const packageRoot = join(temporaryRoot, "package");
    const compiledStandalone = join("dist", "real-tests", "hyper-v-windows-library.mjs");
    for (const relativePath of [
        compiledStandalone,
        join("dist", "real-tests", "hyper-v-windows-library-privileged.mjs"),
        join("scripts", "real-tests", "hyper-v-windows-library-command.mjs"),
        join("scripts", "real-tests", "hyper-v-windows-library-elevation.mjs"),
        join("scripts", "real-tests", "hyper-v-windows-library.ts"),
        join("scripts", "real-tests", "hyper-v-windows-library-real.ts"),
        join("scripts", "real-tests", "hyper-v-windows-library-host.test.ts"),
        join("scripts", "real-tests", "hyper-v-windows-library-fixture.ps1"),
    ]) {
        if (!existsSync(join(packageRoot, relativePath))) throw new Error(`packaged Hyper-V library real-test asset missing: ${relativePath}`);
    }
    const compiledStandaloneSource = readFileSync(join(packageRoot, compiledStandalone), "utf8");
    if (/import\s*\([^)]*\.ts["']\)/.test(compiledStandaloneSource)) {
        throw new Error("packaged Hyper-V library launcher retained a TypeScript runtime import");
    }
    const sourceCommand = readFileSync(join(packageRoot, "scripts", "real-tests", "hyper-v-windows-library-command.mjs"), "utf8");
    const elevationHelper = readFileSync(join(packageRoot, "scripts", "real-tests", "hyper-v-windows-library-elevation.mjs"), "utf8");
    const sourceHostSpec = readFileSync(join(packageRoot, "scripts", "real-tests", "hyper-v-windows-library-host.test.ts"), "utf8");
    if (!sourceCommand.includes("run-vitest.mjs")
        || !sourceCommand.includes("CCC_HYPER_V_WINDOWS_LIBRARY_REAL")
        || !sourceCommand.includes("CCC_E2E_SKIP_BUILD")
        || !sourceCommand.includes("--library-fixture-only")
        || !sourceCommand.includes("tsconfig.hyper-v-windows.json")) {
        throw new Error("source Hyper-V library command does not dispatch to the opt-in Vitest spec");
    }
    if (!sourceCommand.includes("requestAdministrator")
        || !elevationHelper.includes("-Verb RunAs")
        || !elevationHelper.includes("AssignProcessToJobObject")
        || !elevationHelper.includes("elevation-program-integrity-failed")
        || !sourceCommand.includes("hyper-v-windows-library-privileged.mjs")
        || !elevationHelper.includes("GLOBALROOT\\\\SystemRoot")) {
        throw new Error("packaged Hyper-V library command elevation boundary is incomplete");
    }
    if (!sourceHostSpec.includes('from "vitest"') || !sourceHostSpec.includes("runHyperVWindowsLibraryScenario")) {
        throw new Error("packaged Hyper-V library real-host Vitest spec is incomplete");
    }
    const packagedStandaloneModule = await import(pathToFileURL(join(packageRoot, compiledStandalone)).href);
    const packagedFixturePath = packagedStandaloneModule.verifiedHyperVWindowsLibraryFixturePath();
    const packagedFixtureOriginal = readFileSync(packagedFixturePath);
    writeFileSync(packagedFixturePath, Buffer.concat([packagedFixtureOriginal, Buffer.from("\n# tampered\n")]));
    let fixtureReplacementRejected = false;
    try {
        packagedStandaloneModule.verifiedHyperVWindowsLibraryFixturePath();
    } catch (error) {
        fixtureReplacementRejected = error instanceof Error
            && error.message === "hyper-v-library-fixture-asset-integrity-failed";
    }
    if (!fixtureReplacementRejected) throw new Error("replaced packaged Hyper-V fixture asset was accepted");
    writeFileSync(packagedFixturePath, packagedFixtureOriginal);

    const packagedLibrary = await import(pathToFileURL(join(packageRoot, "dist", "hyper-v-windows", "index.js")).href);
    const operationAsset = join(packageRoot, "scripts", "host-control", "hyper-v", "Invoke-HyperVWindowsOperation.ps1");
    const operationOriginal = readFileSync(operationAsset);
    const operationExecutor = packagedLibrary.createHyperVWindowsPowerShellExecutor({
        executable: "unused-by-package-integrity-probe",
        run: () => ({ status: 0, stdout: '{"schemaVersion":1,"operation":"Get-VM","ok":true,"items":[]}' }),
    });
    await operationExecutor.execute({
        schemaVersion: 1,
        operation: "Get-VM",
        selector: { kind: "name", name: "package-integrity-probe" },
    }, { timeoutMilliseconds: 1000, maximumOutputBytes: 4096 });
    writeFileSync(operationAsset, Buffer.concat([operationOriginal, Buffer.from("\n# tampered\n")]));
    let operationReplacementRejected = false;
    try {
        await operationExecutor.execute({
            schemaVersion: 1,
            operation: "Get-VM",
            selector: { kind: "name", name: "package-integrity-probe" },
        }, { timeoutMilliseconds: 1000, maximumOutputBytes: 4096 });
    } catch (error) {
        operationReplacementRejected = error instanceof Error
            && error.message === "hyper-v-windows-powershell-asset-integrity-failed";
    }
    if (!operationReplacementRejected) throw new Error("replaced packaged Hyper-V operation asset was accepted");
    writeFileSync(operationAsset, operationOriginal);
    const packagedStandalone = run(process.execPath, [
        npmCli,
        "run",
        "test:level3:hyper-v:windows:library",
        "--ignore-scripts",
    ], packageRoot);
    if (!packagedStandalone.includes("SKIP level 3 Hyper-V Windows library real-host test: Windows host required")) {
        throw new Error("packaged Hyper-V library real-test entrypoint did not reach the host gate");
    }
    const resolverUrl = pathToFileURL(join(packageRoot, "dist", "host-control", "hyper-v", "powershell-assets.js"));
    const { hyperVPowerShellAssetPath } = await import(resolverUrl.href);

    for (const operation of ["linux-bootstrap-network", "guest-boot-diagnostic", "snapshot-create", "snapshot-repair"]) {
        const asset = hyperVPowerShellAssetPath(operation);
        if (!existsSync(asset)) throw new Error(`packaged Hyper-V asset missing: ${operation}`);
        if (relative(packageRoot, asset).startsWith("..")) throw new Error(`packaged Hyper-V asset escaped package: ${operation}`);
        if (!readFileSync(asset, "utf8").includes("Read-CccJsonContract")) {
            throw new Error(`packaged Hyper-V asset contract missing: ${operation}`);
        }
    }

    const coreModule = join(packageRoot, "scripts", "host-control", "hyper-v", "Ccc.HyperV.Core.psm1");
    const replacement = `${coreModule}.replacement`;
    writeFileSync(replacement, `${readFileSync(coreModule, "utf8")}\n# replaced after verification\n`);
    renameSync(replacement, coreModule);
    let replacementRejected = false;
    try {
        hyperVPowerShellAssetPath("linux-bootstrap-network");
    } catch (error) {
        replacementRejected = error instanceof Error && error.message === "hyper-v-powershell-asset-integrity-failed";
    }
    if (!replacementRejected) throw new Error("replaced packaged Hyper-V asset was accepted");
    process.stdout.write("PASS packaged Hyper-V PowerShell assets and standalone library entrypoint\n");
} finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
}
