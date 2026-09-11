import { describe, it, expect } from "vitest";
import { observeProcessStarts, sessionLockLiveness } from "../session-lock-liveness.js";

// The saving this batches for is a Windows one — one `powershell.exe` per candidate lock file,
// on every `ccc` invocation, which is why the operator's report of PowerShell windows varied
// between runs: it scales with how many leftover locks a host carries, not with the work being
// done. That launch count cannot be observed from Linux, so these assert the property the
// saving rests on instead: a pre-observed pid is USED, and the single-pid probe is not
// consulted for it. A pid that does not exist makes that visible — the real probe would call it
// missing, so an "active" answer can only have come from the map.
describe("pre-observed process starts", () => {
    const absentPid = 999_999_000;
    const lock = (pid: number, startToken: string) => JSON.stringify({ version: 2, pid, startToken });

    it("answers from the map instead of probing the pid", () => {
        const observed = new Map([[absentPid, { status: "found" as const, token: "windows:8675309" }]]);

        expect(
            sessionLockLiveness(lock(absentPid, "windows:8675309"), observed),
            "the token matches what was observed, so the owner is live",
        ).toBe("active");
        expect(
            sessionLockLiveness(lock(absentPid, "windows:8675309")),
            "and without the map the real probe answers for a pid that does not exist",
        ).toBe("stale");
    });

    it("keeps the map from ever inventing liveness", () => {
        expect(
            sessionLockLiveness(lock(absentPid, "windows:1"), new Map([[absentPid, { status: "found" as const, token: "windows:2" }]])),
            "a different token is a recycled pid, which is stale",
        ).toBe("stale");
        expect(
            sessionLockLiveness(lock(absentPid, "windows:1"), new Map([[absentPid, { status: "missing" as const }]])),
            "and missing is stale",
        ).toBe("stale");
        // Fail-closed: an owner that cannot be observed keeps its lock. This is the answer that
        // protects a live session from having its container stopped underneath it.
        expect(
            sessionLockLiveness(lock(absentPid, "windows:1"), new Map([[absentPid, { status: "unknown" as const }]])),
            "unknown is not proof the owner exited",
        ).toBe("unknown");
    });

    it("falls through for a pid the batch did not answer for", () => {
        // An empty map is the shape every non-Windows host gets, and the shape Windows gets
        // when the batch itself fails. It must change nothing.
        expect(sessionLockLiveness(lock(process.pid, "ps:whatever"), new Map()))
            .toBe(sessionLockLiveness(lock(process.pid, "ps:whatever")));
    });

    it("asks for nothing when there is nothing to ask about", () => {
        expect(observeProcessStarts([]).size).toBe(0);
        // Off Windows there is no batch to run: the per-pid probes there are `/proc` reads and
        // a single `ps`, which cost nothing worth batching.
        if (process.platform !== "win32") expect(observeProcessStarts([process.pid]).size).toBe(0);
    });
});
