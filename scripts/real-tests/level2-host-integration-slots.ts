import { deviceLabSmoke } from "../../dist/device-lab-admin.js";
import { aggregateStepResult } from "./result-status.ts";

const slots = [
    { backend: "android-emulator", label: "Android emulator real integration slot" },
    { backend: "ios-simulator", label: "iOS Simulator real integration slot" },
    { backend: "windows-sandbox", label: "Windows Sandbox real integration slot" },
    { backend: "windows-vm", label: "Hyper-V Windows VM real integration slot" },
    { backend: "linux-vm", label: "Hyper-V Linux VM real integration slot" },
    { backend: "macos-vm", label: "macOS VM real integration slot" },
];

export const name = "level 2 host real integration slots";

export async function run() {
    const smoke = deviceLabSmoke(process.cwd(), 5000, undefined, { mode: "real-provider" });
    const steps = slots.map((slot) => {
        const readiness = smoke.results.find((result) => result.backend === slot.backend);
        if (!readiness) return { name: slot.label, status: "FAIL", reason: "missing readiness result" };
        if (readiness.status !== "PASS") return { name: slot.label, status: "SKIP", reason: `${readiness.status} - ${readiness.detail}` };
        return { name: slot.label, status: "PASS" };
    });
    return { ...aggregateStepResult(steps), steps };
}
