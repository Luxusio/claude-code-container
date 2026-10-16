import type { CodexConfigPreparationPorts, CodexConfigPreparationResult } from "../ports/codex-config-preparation.js";

export function createCodexConfigPreparation(ports: CodexConfigPreparationPorts) {
    for (const name of ["probe", "repair", "finalize"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Codex config preparation requires a callable ${name} port.`);
        }
    }

    function requireReady(result: CodexConfigPreparationResult, operation: string): void {
        if (result.kind === "ready") return;
        throw result.failure ?? new Error(`Codex config ${operation} ${result.kind === "timed-out" ? "timed out" : "failed"}`);
    }

    function run(target: string): undefined {
        const accessCheck = ports.probe(target);
        if (accessCheck.kind === "ready") return;
        if (accessCheck.kind !== "repair-required") requireReady(accessCheck, "access probe");

        requireReady(ports.repair(target), "repair");
        requireReady(ports.finalize(target), "repair");
    }

    return { run };
}
