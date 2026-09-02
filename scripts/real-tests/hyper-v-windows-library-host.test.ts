import { describe, expect, it } from "vitest";

import { runHyperVWindowsLibraryScenario } from "./hyper-v-windows-library-real.ts";
import { withExclusiveHyperVLibraryRun } from "./hyper-v-windows-library.ts";

const enabled = process.platform === "win32"
    && process.env.CCC_HYPER_V_WINDOWS_LIBRARY_REAL === "1";

// The scenario's steps are only emitted after their own assertions pass, so pinning the exact
// ordered list is what stops a refactor from dropping or reordering coverage while keeping the
// count intact.
const SCENARIO_STEPS = [
    "Hyper-V library preflight",
    "compiled library observed exact 0 HDD / 0 DVD",
    "compiled library observed exact 2 HDD / 2 empty DVD",
    "compiled library started VM and settled Running",
    "compiled library stopped VM and settled Off",
    "lifecycle safe / attachment-conflict / identity-conflict outcomes",
    "compiled library created and observed exactly one checkpoint",
    "compiled library restored and removed the checkpoint by id and by name",
    "compiled library removed VM and retained both VHDX files",
    "guarded fixture cleanup",
] as const;
const SCENARIO_STEP_COUNT = SCENARIO_STEPS.length;
type PrecomputedResult = {
    readonly status: number;
    readonly steps?: readonly string[];
    readonly errorCode?: string;
};

function precomputedResult(): { readonly steps: readonly string[] } | null {
    const encoded = process.env.CCC_HYPER_V_WINDOWS_LIBRARY_PRECOMPUTED;
    if (!encoded) return null;
    let execution: PrecomputedResult;
    try {
        execution = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as PrecomputedResult;
    } catch {
        throw new Error("hyper-v-library-precomputed-result-invalid");
    }
    if (execution.errorCode) throw new Error(execution.errorCode);
    if (execution.status !== 0 || !Array.isArray(execution.steps) || execution.steps.length !== SCENARIO_STEP_COUNT) {
        throw new Error("hyper-v-library-privileged-result-invalid");
    }
    for (const step of execution.steps) console.info(`PASS ${step}`);
    return { steps: execution.steps };
}

describe.skipIf(!enabled)("Hyper-V Windows library real host", () => {
    it("runs the compiled low-level and lifecycle library against a disposable Hyper-V fixture", async () => {
        const precomputed = precomputedResult();
        const steps = precomputed?.steps ?? await withExclusiveHyperVLibraryRun(() => runHyperVWindowsLibraryScenario({
                platform: "win32",
                log: (message) => console.info(message),
            }));

        expect(steps).toEqual([...SCENARIO_STEPS]);
    }, 6 * 60 * 1000);
});
