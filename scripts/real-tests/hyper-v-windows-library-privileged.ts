import { createHash } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import operationSource from "../host-control/hyper-v/Invoke-HyperVWindowsOperation.ps1";
import * as library from "../../src/hyper-v-windows/index.ts";
import fixtureSource from "./hyper-v-windows-library-fixture.ps1";
import {
    HYPER_V_WINDOWS_LIBRARY_FIXTURE_SHA256,
    runHyperVWindowsLibraryScenario,
    type HyperVWindowsLibraryModule,
} from "./hyper-v-windows-library-real.ts";
import { withExclusiveHyperVLibraryRun } from "./hyper-v-windows-library.ts";

const RESULT_MARKER = "CCC_HYPER_V_WINDOWS_LIBRARY_PRIVILEGED_RESULT:";
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function verifiedSource(source: string, expectedDigest: string, code: string): string {
    if (createHash("sha256").update(source, "utf8").digest("hex") !== expectedDigest) {
        throw new Error(code);
    }
    return source;
}

function safeErrorCode(error: unknown): string {
    const pending: unknown[] = [error];
    const seen = new Set<unknown>();
    while (pending.length > 0) {
        const candidate = pending.shift();
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        if (candidate instanceof AggregateError) pending.push(...candidate.errors);
        if (candidate instanceof Error) {
            const direct = candidate.message.trim();
            if (SAFE_ERROR_CODE.test(direct)) return direct;
            const embedded = direct.match(/\bhyper-v-[A-Za-z0-9._:-]{1,120}\b/)?.[0];
            if (embedded && SAFE_ERROR_CODE.test(embedded)) return embedded;
            const nativeCode = (candidate as NodeJS.ErrnoException).code;
            if (nativeCode && /^[A-Z][A-Z0-9_]{1,31}$/.test(nativeCode)) return `node-${nativeCode.toLowerCase()}`;
            if (candidate.cause) pending.push(candidate.cause);
        }
    }
    return "hyper-v-library-privileged-scenario-failed";
}

async function main(): Promise<number> {
    let completedSteps = 0;
    try {
        const embeddedLibrary = {
            ...library,
            createHyperVWindowsPowerShellExecutor(options: Parameters<typeof library.createHyperVWindowsPowerShellExecutor>[0]) {
                return library.createHyperVWindowsPowerShellExecutor({
                    ...options,
                    operationAsset: {
                        scriptPath: "embedded:Invoke-HyperVWindowsOperation.ps1",
                        scriptSource: verifiedSource(
                            operationSource,
                            library.HYPER_V_WINDOWS_POWERSHELL_ASSET.sha256,
                            "hyper-v-windows-powershell-asset-integrity-failed",
                        ),
                    },
                });
            },
        };
        const steps = await withExclusiveHyperVLibraryRun(() => runHyperVWindowsLibraryScenario({
            platform: "win32",
            importLibraryImpl: async () => embeddedLibrary as unknown as HyperVWindowsLibraryModule,
            fixtureAsset: {
                scriptPath: "embedded:hyper-v-windows-library-fixture.ps1",
                scriptSource: verifiedSource(
                    fixtureSource,
                    HYPER_V_WINDOWS_LIBRARY_FIXTURE_SHA256,
                    "hyper-v-library-fixture-asset-integrity-failed",
                ),
            },
            log: (message) => {
                completedSteps += 1;
                console.info(message);
            },
        }), { lockFile: join(dirname(fileURLToPath(import.meta.url)), ".real-provider.lock") });
        const payload = Buffer.from(JSON.stringify({ ok: true, steps }), "utf8").toString("base64");
        process.stdout.write(`${RESULT_MARKER}${payload}\n`);
        return 0;
    } catch (error) {
        const payload = Buffer.from(JSON.stringify({
            ok: false,
            errorCode: safeErrorCode(error),
            completedSteps,
        }), "utf8").toString("base64");
        process.stdout.write(`${RESULT_MARKER}${payload}\n`);
        return 1;
    }
}

process.exitCode = await main();
