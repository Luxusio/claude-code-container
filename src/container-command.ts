import { spawn, spawnSync } from "child_process";
import { bindNativeRuntimeInvocation, captureNativeRuntimeInvocation, currentNativeRuntimeInvocation, type BoundNativeRuntimeRunner } from "./container-runtime.js";
import { captureInteractiveTerminal } from "./adapters/interactive-terminal.js";

export async function runContainerCommand(runtime: string, args: string[], interactive: boolean, runner?: BoundNativeRuntimeRunner): Promise<number> {
    if (!runner && (runtime === "docker" || runtime === "podman")) {
        const current = currentNativeRuntimeInvocation();
        runner = bindNativeRuntimeInvocation(current?.runtime === runtime ? current : captureNativeRuntimeInvocation(runtime));
    }
    if (!interactive) return (runner ? runner.spawnSync(args, { stdio: "inherit" }) : spawnSync(runtime, args, { stdio: "inherit" })).status ?? 1;

    return new Promise<number>((resolve) => {
        const restoreTerminal = captureInteractiveTerminal();
        let child: ReturnType<typeof spawn>;
        try { child = runner ? runner.spawn(args, { stdio: "inherit" }) : spawn(runtime, args, { stdio: "inherit" }); }
        catch (error) { restoreTerminal(); throw error; }
        const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
        let settled = false;
        let interrupted = false;
        function finish(status: number): void {
            if (settled) return;
            settled = true;
            child.removeListener("close", onClose);
            child.removeListener("error", onError);
            for (const signal of signals) process.removeListener(signal, interrupt);
            restoreTerminal();
            resolve(status);
        }
        function onClose(code: number | null, signal: NodeJS.Signals | null): void {
            finish(!interrupted && signal === null && code !== null && Number.isFinite(code) ? code : 1);
        }
        function onError(): void { finish(1); }
        function interrupt(): void {
            interrupted = true;
            // Existing cleanup handlers exit synchronously, so a grace timer cannot run.
            try { child.kill("SIGKILL"); } catch { /* The owned client may already have exited. */ }
            finish(1);
        }
        child.once("close", onClose);
        child.once("error", onError);
        for (const signal of signals) process.prependListener(signal, interrupt);
    });
}
