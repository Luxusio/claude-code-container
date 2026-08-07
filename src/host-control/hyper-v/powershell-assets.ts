import { createHash } from "crypto";
import { lstatSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { hiddenWindowsPowerShellArgs } from "../../windows-system-powershell.js";

import type { HyperVProviderCommand } from "./contracts.js";
import {
    HYPER_V_POWERSHELL_MANIFEST,
    type HyperVPowerShellOperation,
    type HyperVPowerShellRequestMap,
} from "./powershell-manifest.js";

const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/host-control/hyper-v");

function isInside(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function loadVerifiedAssets(): ReadonlyMap<string, string> {
    const root = realpathSync(ASSET_ROOT);
    const paths = new Map<string, string>();
    for (const [name, metadata] of Object.entries(HYPER_V_POWERSHELL_MANIFEST.assets)) {
        if (!/^[A-Za-z][A-Za-z0-9.-]{0,63}\.ps(?:1|m1)$/i.test(name) || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
            throw new Error("hyper-v-powershell-manifest-entry-invalid");
        }
        const resolved = realpathSync(resolve(root, name));
        if (!isInside(root, resolved) || !lstatSync(resolved).isFile()) throw new Error("hyper-v-powershell-asset-invalid");
        const digest = createHash("sha256").update(readFileSync(resolved)).digest("hex");
        if (digest !== metadata.sha256) throw new Error("hyper-v-powershell-asset-integrity-failed");
        paths.set(name, resolved);
    }
    return paths;
}

export function hyperVPowerShellAssetPath(operation: HyperVPowerShellOperation): string {
    const entry = HYPER_V_POWERSHELL_MANIFEST.operations[operation];
    if (!entry || entry.requestVersion !== 1) throw new Error("hyper-v-powershell-operation-invalid");
    const resolved = loadVerifiedAssets().get(entry.script);
    if (!resolved) throw new Error("hyper-v-powershell-asset-invalid");
    return resolved;
}

export function hyperVPowerShellFileCommand<Operation extends HyperVPowerShellOperation>(
    executable: string,
    operation: Operation,
    request: HyperVPowerShellRequestMap[Operation],
): HyperVProviderCommand {
    const input = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(input, "utf8") > 65536) throw new Error("hyper-v-powershell-contract-too-large");
    return {
        mode: "exec",
        provider: "hyper-v",
        executable,
        args: hiddenWindowsPowerShellArgs([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            hyperVPowerShellAssetPath(operation),
        ]),
        input,
    };
}
