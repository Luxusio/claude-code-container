import { pathToFileURL } from "url";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

import {
    getHyperVElevatedNetworkTerminationDiagnostic,
    getHyperVElevatedNetworkTerminationStage,
    withElevatedHyperVNetworkExecutor,
} from "./hyper-v-windows-network-elevation-runtime.mjs";
import {
    createBoundedPowerShellFileRunner,
    resolveTrustedWindowsSystemExecutables,
} from "./hyper-v-windows-library-real.ts";
import { withExclusiveHyperVLibraryRun } from "./hyper-v-windows-library.ts";
import {
    runHyperVWindowsNetworkRealScenario,
    type HyperVWindowsNetworkLibraryModule,
    type HyperVWindowsNetworkRealResult,
} from "./hyper-v-windows-network-real.ts";

const SCENARIO_DEADLINE_MILLISECONDS = 5 * 60 * 1000;

type RuntimeLibrary = HyperVWindowsNetworkLibraryModule;

async function loadRuntimeLibrary(): Promise<RuntimeLibrary> {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "hyper-v-windows", "index.js");
    return import(pathToFileURL(root).href) as Promise<RuntimeLibrary>;
}

export type HyperVWindowsNetworkHostDependencies = {
    readonly platform?: NodeJS.Platform;
    readonly stdout?: Pick<NodeJS.WriteStream, "write">;
    readonly stderr?: Pick<NodeJS.WriteStream, "write">;
    readonly importLibraryImpl?: () => Promise<RuntimeLibrary>;
    readonly withElevatedExecutorImpl?: typeof withElevatedHyperVNetworkExecutor;
    readonly runScenarioImpl?: typeof runHyperVWindowsNetworkRealScenario;
    readonly windowsSystemRoot?: string;
    readonly legacyNativeInvocationCount?: number;
    readonly withExclusiveRunImpl?: <T>(operation: () => Promise<T>) => Promise<T>;
    readonly signal?: AbortSignal;
};

export async function runHyperVWindowsNetworkHost(
    dependencies: HyperVWindowsNetworkHostDependencies = {},
): Promise<number> {
    const stdout = dependencies.stdout ?? process.stdout;
    const stderr = dependencies.stderr ?? process.stderr;
    if ((dependencies.platform ?? process.platform) !== "win32") {
        stdout.write("SKIP Hyper-V Windows typed network real-host proof: Windows host required\n");
        stdout.write("     Type/fake orchestration proof is separate; no host network resource was changed.\n");
        stdout.write("SUMMARY real-tests total=1 pass=0 skip=1 fail=0 failOnSkip=false\n");
        return 0;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (dependencies.signal?.aborted) controller.abort();
    else dependencies.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), SCENARIO_DEADLINE_MILLISECONDS);
    let uacPromptCount = 0;
    try {
        const library = await (dependencies.importLibraryImpl ?? loadRuntimeLibrary)();
        const executable = resolveTrustedWindowsSystemExecutables(dependencies.windowsSystemRoot).powershell;
        const ordinaryExecutor = library.createHyperVWindowsPowerShellExecutor({
            executable,
            run: createBoundedPowerShellFileRunner({
                platform: "win32",
                windowsSystemRoot: dependencies.windowsSystemRoot,
            }),
        });
        const ordinaryClient = library.createHyperVWindowsNetworkClient(ordinaryExecutor);
        const withElevated = dependencies.withElevatedExecutorImpl ?? withElevatedHyperVNetworkExecutor;
        const runScenario = dependencies.runScenarioImpl ?? runHyperVWindowsNetworkRealScenario;
        const operationAssetPath = join(
            dirname(fileURLToPath(import.meta.url)),
            "..",
            "..",
            "scripts",
            "host-control",
            "hyper-v",
            "Invoke-HyperVWindowsOperation.ps1",
        );

        const withExclusive = dependencies.withExclusiveRunImpl ?? withExclusiveHyperVLibraryRun;
        const result: HyperVWindowsNetworkRealResult = await withExclusive(() => withElevated({
            executable,
            deadlineUnixMilliseconds: Date.now() + SCENARIO_DEADLINE_MILLISECONDS,
            signal: controller.signal,
            operationAsset: {
                scriptPath: operationAssetPath,
                scriptSource: readFileSync(operationAssetPath, "utf8"),
            },
            onBeforeElevation: () => {
                uacPromptCount += 1;
                stdout.write("REQUEST Windows is asking for Administrator permission via UAC for the token-scoped Hyper-V network proof\n");
            },
        }, async (elevatedExecutor) => {
            const elevatedClient = library.createHyperVWindowsNetworkClient(elevatedExecutor);
            return runScenario({
                library,
                ordinaryClient,
                signal: controller.signal,
                ...(dependencies.legacyNativeInvocationCount === undefined
                    ? {}
                    : { legacyNativeInvocationCount: dependencies.legacyNativeInvocationCount }),
                withAdministratorClient: async (_attempt, operation) => operation(elevatedClient, "elevated-session-1"),
                log: (message) => stdout.write(`${message}\n`),
            });
        }));

        if (uacPromptCount !== 1) throw new Error(`hyper-v-network-real-uac-count-invalid:${uacPromptCount}`);
        stdout.write(`METRICS ${JSON.stringify({
            uacPromptCount,
            administratorScopeCount: result.administratorScopeCount,
            sessionReused: result.sessionReused,
            typedNativeInvocationCounts: result.typedNativeInvocationCounts,
            legacyNativeInvocationCount: result.legacyNativeInvocationCount,
            legacyComparison: result.legacyComparison,
            coldWallTimeMilliseconds: result.attempts[0].wallTimeMilliseconds,
            warmWallTimeMilliseconds: result.attempts[1].wallTimeMilliseconds,
        })}\n`);
        stdout.write("PASS Hyper-V Windows typed network real-host proof: exact-ID cleanup and unrelated-resource preservation confirmed\n");
        stdout.write("SUMMARY real-tests total=1 pass=1 skip=0 fail=0 failOnSkip=false\n");
        return 0;
    } catch (error) {
        const stage = getHyperVElevatedNetworkTerminationStage(error);
        if (stage) stderr.write(`DIAGNOSTIC Hyper-V elevated network termination stage=${stage}\n`);
        const diagnostic = getHyperVElevatedNetworkTerminationDiagnostic(error);
        if (diagnostic?.relay) {
            stderr.write("DIAGNOSTIC Hyper-V elevated network relay"
                + ` shutdown=${diagnostic.relay.shutdownMode}`
                + ` progress=${diagnostic.relay.progressStage ?? "none"}`
                + ` closeWrite=${diagnostic.relay.closeWriteStatus}`
                + ` processExited=${String(diagnostic.relay.processExited)}`
                + ` stdoutDrained=${String(diagnostic.relay.stdoutDrained)}`
                + ` stderrObserved=${String(diagnostic.relay.stderrObserved)}`
                + ` forceExpired=${String(diagnostic.relay.forceExpired)}`
                + ` activeExecutions=${String(diagnostic.execution.activeExecutions)}`
                + ` pendingExecutions=${String(diagnostic.execution.pendingExecutions)}`
                + ` lastOperation=${diagnostic.execution.lastOperation ?? "none"}`
                + ` lastSessionError=${diagnostic.execution.lastSessionError ?? "none"}\n`);
        } else if (diagnostic) {
            stderr.write("DIAGNOSTIC Hyper-V elevated network execution"
                + ` activeExecutions=${String(diagnostic.execution.activeExecutions)}`
                + ` pendingExecutions=${String(diagnostic.execution.pendingExecutions)}`
                + ` lastOperation=${diagnostic.execution.lastOperation ?? "none"}`
                + ` lastSessionError=${diagnostic.execution.lastSessionError ?? "none"}\n`);
        }
        const code = error instanceof Error ? error.message : "hyper-v-network-real-unexpected-failure";
        stderr.write(`FAIL Hyper-V Windows typed network real-host proof: ${code}\n`);
        stderr.write("SUMMARY real-tests total=1 pass=0 skip=0 fail=1 failOnSkip=false\n");
        return 1;
    } finally {
        clearTimeout(timer);
        dependencies.signal?.removeEventListener("abort", onAbort);
    }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exitCode = await runHyperVWindowsNetworkHost();
}
