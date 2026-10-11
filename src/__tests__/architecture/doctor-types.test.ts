import { expectTypeOf, it } from "vitest";
import { createDoctor } from "../../application/doctor.js";
import { runDoctor } from "../../doctor.js";
import type { DoctorReport, DoctorRequest } from "../../domain/doctor.js";
import type { DoctorPorts } from "../../ports/doctor.js";

it("retains synchronous semantic core and public boolean signatures", () => {
    expectTypeOf(runDoctor).toEqualTypeOf<(projectPath: string) => boolean>();
    expectTypeOf(createDoctor).returns.toEqualTypeOf<(request: DoctorRequest) => DoctorReport>();
});

// Consumed compiler-negative fixtures have no runtime native effects.
if (false) {
    // @ts-expect-error all finite observations are required
    createDoctor({});
    const rawVersion = () => ({ status: 0, stdout: "27", stderr: "" });
    // @ts-expect-error process receipts belong to the native adapter
    const version: DoctorPorts["runtimeVersion"] = rawVersion;
    const rawLauncher = () => ({ status: 0, stdout: "Claude" });
    // @ts-expect-error launcher observations require semantic discriminants
    const launcher: DoctorPorts["claudeLauncherReport"] = rawLauncher;
    // @ts-expect-error asynchronous daemon observations are forbidden
    const daemon: DoctorPorts["daemonRunning"] = async () => true;
    // @ts-expect-error asynchronous version observations are forbidden
    const asyncVersion: DoctorPorts["runtimeVersion"] = async () => "27";
    // @ts-expect-error asynchronous lock observations are forbidden
    const locks: DoctorPorts["lockNames"] = async () => [];
    // @ts-expect-error the core report remains synchronous
    const report: DoctorReport = Promise.resolve({ ok: true, checks: [] });
    void version;
    void launcher;
    void daemon;
    void asyncVersion;
    void locks;
    void report;
}
