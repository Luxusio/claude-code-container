import { createHash } from "crypto";
import { lstatSync, readFileSync, realpathSync } from "fs";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";

import type {
    HyperVWindowsExecutionContext,
    HyperVWindowsExecutionRequest,
    HyperVWindowsExecutionResult,
    HyperVWindowsExecutor,
} from "./contracts.js";

export const HYPER_V_WINDOWS_POWERSHELL_ASSET = {
    name: "Invoke-HyperVWindowsOperation.ps1",
    sha256: "84ee4bc3f30f1a0668d1667aba20f1cc0038ec992b322818791b0123daf44cd4",
} as const;
export const HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP = [
    "$EnvelopeJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
    "$Envelope = $EnvelopeJson | ConvertFrom-Json -ErrorAction Stop",
    "$global:CccHyperVJsonInput = [string]$Envelope.input",
    "& ([ScriptBlock]::Create([string]$Envelope.script))",
].join("; ");
export const HYPER_V_WINDOWS_POWERSHELL_MEMORY_INPUT_LIMIT_BYTES = 256 * 1024;
const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/host-control/hyper-v");

export type HyperVWindowsPowerShellFileRequest = {
    readonly executable: string;
    readonly scriptPath: string;
    readonly scriptSource: string;
    readonly input: string;
};

export type HyperVWindowsPowerShellFileRunner = (
    request: HyperVWindowsPowerShellFileRequest,
    context: HyperVWindowsExecutionContext,
) => HyperVWindowsExecutionResult | Promise<HyperVWindowsExecutionResult>;

export type HyperVWindowsPowerShellExecutorOptions = {
    readonly executable: string;
    readonly run: HyperVWindowsPowerShellFileRunner;
    readonly operationAsset?: HyperVWindowsPowerShellOperationAsset;
};

export type HyperVWindowsPowerShellOperationAsset = {
    readonly scriptPath: string;
    readonly scriptSource: string;
};

export function hyperVWindowsPowerShellMemoryInput(
    request: Pick<HyperVWindowsPowerShellFileRequest, "scriptSource" | "input">,
): string {
    const processInput = Buffer.from(
        JSON.stringify({ script: request.scriptSource, input: request.input }),
        "utf8",
    ).toString("base64");
    if (Buffer.byteLength(processInput, "utf8") > HYPER_V_WINDOWS_POWERSHELL_MEMORY_INPUT_LIMIT_BYTES) {
        throw new Error("hyper-v-windows-powershell-memory-input-too-large");
    }
    return processInput;
}

function isInside(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function verifiedAsset(embedded?: HyperVWindowsPowerShellOperationAsset): HyperVWindowsPowerShellOperationAsset {
    if (embedded) {
        const digest = createHash("sha256").update(embedded.scriptSource, "utf8").digest("hex");
        if (digest !== HYPER_V_WINDOWS_POWERSHELL_ASSET.sha256) {
            throw new Error("hyper-v-windows-powershell-asset-integrity-failed");
        }
        return embedded;
    }
    const root = realpathSync(ASSET_ROOT);
    const asset = realpathSync(resolve(root, HYPER_V_WINDOWS_POWERSHELL_ASSET.name));
    if (!isInside(root, asset) || !lstatSync(asset).isFile()) throw new Error("hyper-v-windows-powershell-asset-invalid");
    const source = readFileSync(asset);
    const digest = createHash("sha256").update(source).digest("hex");
    if (digest !== HYPER_V_WINDOWS_POWERSHELL_ASSET.sha256) throw new Error("hyper-v-windows-powershell-asset-integrity-failed");
    return { scriptPath: asset, scriptSource: source.toString("utf8") };
}

export function createHyperVWindowsPowerShellExecutor(
    options: HyperVWindowsPowerShellExecutorOptions,
): HyperVWindowsExecutor {
    return {
        execute(request: HyperVWindowsExecutionRequest, context: HyperVWindowsExecutionContext) {
            const input = `${JSON.stringify(request)}\n`;
            if (Buffer.byteLength(input, "utf8") > 64 * 1024) {
                throw new Error("hyper-v-windows-powershell-request-too-large");
            }
            const asset = verifiedAsset(options.operationAsset);
            return options.run({
                executable: options.executable,
                ...asset,
                input,
            }, context);
        },
    };
}
