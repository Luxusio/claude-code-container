import { describe, expect, it } from "vitest";
import {
    formatLabMcpSmokeReport,
    runLabMcpSmoke,
} from "../../device-lab-mcp/src/backends/linux-vm-smoke.mjs";

describe("device-lab Linux VM provider smoke runner", () => {
    it("passes the fake-provider lifecycle without external VM prerequisites", async () => {
        const report = await runLabMcpSmoke();

        expect(report.ok).toBe(true);
        expect(report.steps.map((step) => step.name)).toEqual([
            "provider-status",
            "image-import",
            "lab-create",
            "disk-materialize",
            "lab-start",
            "readiness-probe",
            "guest-push",
            "guest-pull",
            "guest-exec",
            "lab-stop",
            "snapshot-create",
            "lab-delete",
        ]);
        expect(report.steps.every((step) => step.status === "PASS")).toBe(true);
        const text = formatLabMcpSmokeReport(report);
        expect(text).toContain("mode: fake-provider");
        expect(text).toContain("result: PASS");
    });

    it("reports the failing step with structured diagnostics", async () => {
        const report = await runLabMcpSmoke({
            commandRunner: (command: string, args: string[]) => {
                if (args[0] === "create") return { ok: false, command, args, stderr: "qemu-img failed" };
                return { ok: true, command, args, pid: 1234 };
            },
        });

        expect(report.ok).toBe(false);
        expect(report.steps).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: "disk-materialize",
                status: "FAIL",
                error: "disk-materialize failed",
                result: expect.objectContaining({
                    ok: false,
                    error: "qemu-img-create-failed",
                }),
            }),
        ]));
        expect(formatLabMcpSmokeReport(report)).toContain("result: FAIL");
    });
});
