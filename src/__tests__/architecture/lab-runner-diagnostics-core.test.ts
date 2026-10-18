import { describe, expect, it } from "vitest";
import { createLabRunnerDiagnostics } from "../../application/lab-runner-diagnostics.js";
import type { LabRunnerConfigObservation } from "../../domain/lab-runner-diagnostics.js";

const config = (status: "ready" | "unsupported" = "ready"): LabRunnerConfigObservation => ({ status, stateVolumeName: "state", stateContainerDir: "/private/state", networkMode: "user", kvmGroupId: 0, kvmDevicePath: "/private/kvm" });
function fixture() {
    const trace: unknown[] = [];
    const ports = {
        resolveProjectPath: (cwd: string) => { trace.push(["resolve", cwd]); return "/private/project"; },
        containerName: (path: string, profile?: string) => { trace.push(["name", path, profile]); return profile ? "lab" : "default"; },
        containerVmConfig: (name: string) => { trace.push(["config", name]); return config(); },
        labRunnerVmConfig: (profile: string, name: string): LabRunnerConfigObservation | null => { trace.push(["lab", profile, name]); return config(); },
        labProfileName: () => { trace.push("profile"); return "lab-runner"; },
        stateVolumeName: (name: string) => { trace.push(["volume", name]); return "lab-state"; },
        stateContainerDir: () => { trace.push("directory"); return "/private/state"; },
        runtimeSummary: () => { trace.push("runtime"); return "fixture runtime"; },
    };
    return { ports, trace };
}

describe("whole inward lab diagnostics", () => {
    it("constructs without observing ports and preserves full snapshot order and group zero", () => {
        const f = fixture(), app = createLabRunnerDiagnostics(f.ports);
        expect(f.trace).toEqual([]);
        const result = app.snapshot("raw cwd");
        expect(f.trace).toEqual([["resolve", "raw cwd"], ["name", "/private/project", undefined], ["config", "default"], "profile", ["name", "/private/project", "lab-runner"], "profile", ["lab", "lab-runner", "lab"], "profile", ["volume", "lab"], "directory", "runtime"]);
        expect(result.kvmGroupId).toBe(0); expect(result.defaultContainerVmCapable).toBe(true);
        expect(result.defaultContainer).not.toBe(result.labRunnerProfile);
    });
    it.each([null, false, 0, ""])("preserves raw truthy fallback for %j", raw => {
        const f = fixture();
        // Deliberately adversarial runtime observation, outside production static contracts.
        Object.defineProperty(f.ports, "labRunnerVmConfig", { value: () => raw });
        createLabRunnerDiagnostics(f.ports).snapshot("cwd");
        expect(f.trace.filter(x => Array.isArray(x) && x[0] === "config")).toEqual([["config", "default"], ["config", "lab"]]);
    });

    it.each([["ready", "ready"], ["ready", "unsupported"], ["unsupported", "ready"], ["unsupported", "unsupported"]] as const)("preserves independent default %s and lab %s readiness", (defaultStatus, labStatus) => {
        const f = fixture(); f.ports.containerVmConfig = () => config(defaultStatus); f.ports.labRunnerVmConfig = () => config(labStatus);
        const snapshot = createLabRunnerDiagnostics(f.ports).snapshot("cwd");
        expect(snapshot.defaultContainer.status).toBe(defaultStatus); expect(snapshot.status).toBe(labStatus);
        expect(snapshot.labRunnerProfile.status).toBe(labStatus);
        expect(snapshot.kvmGroupId).toBe(0);
    });
    it.each([undefined, 0, 7])("retains nullish group projection for %j while empty text becomes null", group => {
        const f = fixture(); f.ports.labRunnerVmConfig = () => ({ ...config(), unsupportedReason: "", kvmDevicePath: "", kvmGroupId: group });
        const snapshot = createLabRunnerDiagnostics(f.ports).snapshot("cwd");
        expect(snapshot.kvmGroupId).toBe(group ?? null); expect(snapshot.unsupportedReason).toBeNull(); expect(snapshot.kvmDevicePath).toBeNull();
    });

    it.each(Object.keys(fixture().ports))("rejects missing or noncallable data port %s without effects", key => {
        for (const missing of [true, false]) {
            const f = fixture(), ports = { ...f.ports };
            if (missing) Reflect.deleteProperty(ports, key); else Object.defineProperty(ports, key, { value: 1 });
            expect(() => createLabRunnerDiagnostics(ports)).toThrow(); expect(f.trace).toEqual([]);
        }
    });
    it("preserves raw thrown values without fallback or later observations", () => {
        const f = fixture(), fault = {};
        f.ports.labRunnerVmConfig = () => { throw fault; };
        try { createLabRunnerDiagnostics(f.ports).snapshot("cwd"); throw new Error("expected raw failure"); }
        catch (error) { expect(error).toBe(fault); }
        expect(f.trace).not.toContain("runtime");
    });
});
