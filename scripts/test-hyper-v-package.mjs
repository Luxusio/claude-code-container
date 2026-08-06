import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { pathToFileURL } from "url";

const root = new URL("../", import.meta.url);
const temporaryRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-package-"));

function run(executable, args) {
    const result = spawnSync(executable, args, {
        cwd: root,
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
    const resolverUrl = pathToFileURL(join(packageRoot, "dist", "host-control", "hyper-v", "powershell-assets.js"));
    const { hyperVPowerShellAssetPath } = await import(resolverUrl.href);

    for (const operation of ["linux-bootstrap-network", "guest-boot-diagnostic"]) {
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
    process.stdout.write("PASS packaged Hyper-V PowerShell assets\n");
} finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
}
