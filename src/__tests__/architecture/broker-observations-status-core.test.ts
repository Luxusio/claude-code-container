import { describe, expect, it } from "vitest";
import { createBrokerService, createBrokerStatus } from "@ccc/device-lab/device-lab/application/broker-observation-status.js";

describe("broker status fact sequencing", () => {
    it("retains separate presence reads and compares service ownership only after its projection", () => {
        const trace: string[] = []; let exists = 0;
        const owner = { get ownerId() { trace.push("owner-id"); return "owner"; } };
        const observe = createBrokerStatus({
            root: () => { trace.push("root"); return "root"; }, service: () => { trace.push("service"); return {}; },
            serviceOwner: () => { trace.push("owner"); return owner; }, runtimeFile: () => { trace.push("runtime-file"); return "runtime"; },
            runtime: () => { trace.push("runtime"); return null; }, address: () => { trace.push("address"); return {}; },
            hostId: () => { trace.push("host"); return "host"; }, pid: () => { trace.push("pid-field"); return 1; },
            startToken: () => { trace.push("pid-token"); return "token"; }, startedAt: () => { trace.push("started"); return "started"; },
            paths: () => { trace.push("paths"); return {}; }, exists: () => { trace.push("exists"); return ++exists === 2; },
            persistence: () => { trace.push("persistence"); return {}; }, serviceFacts: () => { trace.push("service-facts"); return {}; },
            elevation: () => { trace.push("elevation"); return {}; },
        });
        const value = observe("owner", {});
        expect(trace).toEqual(["root", "service", "owner", "runtime-file", "runtime", "address", "host", "pid-field", "pid-token", "started", "paths", "exists", "exists", "persistence", "service-facts", "owner-id", "elevation"]);
        expect(value.rootExists).toBe(false); expect(value.deviceStateMounted).toBe(true); expect(value.runtimeFacts.present).toBe(false); expect(value.ownedByCurrentOwner).toBe(true);
    });
});

function serviceFixture(supported = true, dryRun = false) {
    const trace: string[] = [];
    const plan = { supported, definitionPath: "definition", diagnostics: ["diagnostic"] };
    const observe = createBrokerService({
        plan: () => { trace.push("plan"); return plan; }, commands: () => { trace.push("commands"); return [1, 2]; },
        dryRun: () => { trace.push("dry-run"); return dryRun; }, owner: () => { trace.push("owner"); return { ownerId: "owner" }; },
        installed: () => { trace.push("installed"); return false; },
        query: (_context: object, command: number) => { trace.push("query:" + command); return { mode: "observed", provider: "service", command }; },
        succeeded: () => { trace.push("succeeded"); return false; },
        projection: (source, commands) => { trace.push("projection"); return { ...source, commands }; },
        diagnostics: source => { trace.push("diagnostics"); return source.diagnostics; },
    }, new Set(["status"]));
    return { trace, observe: (action = "status") => observe("owner", action, {}) };
}

describe("broker service status policy", () => {
    it("runs all queries before classifying the first and keeps failed query as a false running observation", () => {
        const f = serviceFixture(); const value = f.observe();
        expect(value.kind).toBe("observed"); if (value.kind === "observed") expect(value.value.running).toBe(false);
        expect(f.trace).toEqual(["plan", "commands", "dry-run", "owner", "installed", "query:1", "query:2", "succeeded", "projection", "diagnostics"]);
    });
    it.each([[false, false, "unsupported"], [true, true, "dry-run"]] as const)("reads existing facts before %s/%s branch", (supported, dryRun, kind) => {
        const f = serviceFixture(supported, dryRun); expect(f.observe().kind).toBe(kind);
        expect(f.trace).toEqual(["plan", "commands", "dry-run", "owner", "installed", "projection", "diagnostics"]);
    });
    it("refuses a mutating action without constructing a native plan", () => {
        const f = serviceFixture(); expect(f.observe("start")).toEqual({ kind: "invalid-action", action: "start", allowed: ["status"] }); expect(f.trace).toEqual([]);
    });
});
