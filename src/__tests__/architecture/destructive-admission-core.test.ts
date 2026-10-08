import { describe, expect, it } from "vitest";
import { evaluateDestructivePolicy } from "@ccc/device-lab/providers/domain/destructive-admission.mjs";

// Frozen baseline 10c8618, policy SHA256 2979195132ee93436bcaa195bef89b4c35030af46b86204d7a996674103b0697.
// Embedded independently: this oracle never reads the current facade or domain source.
const baselineSource = "const CONFIRM_DESTRUCTIVE_FIELD = \"confirmDestructive\";\n\nexport const DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES = [\n    { name: \"device_delete\", args: { deviceId: \"policy-device\" } },\n    { name: \"device_delete\", args: { force: true } },\n    { name: \"device_delete\", args: { deleteAvd: true } },\n    { name: \"device_delete\", args: { deleteSimulator: true } },\n    { name: \"device_reset\", args: { deviceId: \"policy-device\", packageName: \"com.example\" } },\n    { name: \"device_snapshot_restore\", args: { deviceId: \"policy-device\", snapshotName: \"before-test\" } },\n    { name: \"device_snapshot_delete\", args: { deviceId: \"policy-device\", snapshotName: \"before-test\" } },\n    { name: \"device_broker_shutdown\", args: {} },\n    { name: \"device_broker_command\", args: { action: \"invoke\", command: \"device_delete\" } },\n    { name: \"device_broker_appium\", args: { action: \"request\", method: \"POST\", path: \"/appium/device/remove_app\", body: { appId: \"com.example\" } } },\n    { name: \"mobile_uninstall_app\", args: { deviceId: \"policy-device\", packageName: \"com.example\" } },\n    { name: \"mobile_clear_app_data\", args: { deviceId: \"policy-device\", packageName: \"com.example\" } },\n    { name: \"mobile_set_battery\", args: { deviceId: \"policy-device\", level: 50 } },\n    { name: \"mobile_set_network\", args: { deviceId: \"policy-device\", wifi: true } },\n    { name: \"mobile_toggle_airplane_mode\", args: { deviceId: \"policy-device\", enabled: false } },\n];\n\nfunction hasConfirmation(args) {\n    return args?.[CONFIRM_DESTRUCTIVE_FIELD] === true;\n}\n\nfunction bodyScript(body) {\n    return typeof body?.script === \"string\" ? body.script : \"\";\n}\n\nfunction bodyCommand(body) {\n    const first = Array.isArray(body?.args) ? body.args[0] : null;\n    return typeof first?.command === \"string\" ? first.command : \"\";\n}\n\nfunction bodyArgs(body) {\n    const first = Array.isArray(body?.args) ? body.args[0] : null;\n    return Array.isArray(first?.args) ? first.args.map(String) : [];\n}\n\nfunction classifyBrokerAppiumRequest(args) {\n    const path = typeof args?.path === \"string\" ? args.path : \"\";\n    const method = typeof args?.method === \"string\" ? args.method.toUpperCase() : \"\";\n    const body = args?.body || {};\n    const reasons = [];\n\n    if (args?.force === true && [\"clear\", \"stop\"].includes(args?.action)) {\n        reasons.push(\"broker-appium-force-lifecycle\");\n    }\n\n    if (args?.action !== \"request\") return reasons;\n\n    if (method === \"POST\" && path.includes(\"/appium/device/remove_app\")) {\n        reasons.push(\"app-uninstall\");\n    }\n\n    if (method === \"POST\" && bodyScript(body) === \"mobile: shell\") {\n        const command = bodyCommand(body);\n        const argv = bodyArgs(body);\n        if (command === \"pm\" && argv[0] === \"clear\" && argv[1]) reasons.push(\"app-data-clear\");\n        if (command === \"svc\" && [\"wifi\", \"data\"].includes(argv[0])) reasons.push(\"device-network-change\");\n        if (command === \"cmd\" && argv.includes(\"battery\")) reasons.push(\"device-system-change\");\n        if (command === \"settings\" && argv.includes(\"airplane_mode_on\")) reasons.push(\"device-network-change\");\n        if (command === \"am\" && argv[0] === \"broadcast\" && argv.includes(\"android.intent.action.AIRPLANE_MODE\")) reasons.push(\"device-network-change\");\n    }\n\n    return reasons;\n}\n\nfunction classify(name, args = {}) {\n    switch (name) {\n        case \"device_delete\": {\n            const reasons = [\"device-delete\"];\n            if (args.force === true) reasons.push(\"force-delete\");\n            if (args.deleteAvd === true) reasons.push(\"delete-avd\");\n            if (args.deleteSimulator === true) reasons.push(\"delete-simulator\");\n            return reasons;\n        }\n        case \"device_reset\":\n            return [args.eraseSimulator === true ? \"erase-simulator\" : \"app-data-clear\"];\n        case \"device_snapshot_restore\":\n            return [\"snapshot-restore\"];\n        case \"device_snapshot_delete\":\n            return [\"snapshot-delete\"];\n        case \"device_broker_shutdown\":\n            return [\"broker-shutdown\"];\n        case \"mobile_uninstall_app\":\n            return [\"app-uninstall\"];\n        case \"mobile_clear_app_data\":\n            return [\"app-data-clear\"];\n        case \"mobile_set_battery\":\n            return [\"device-system-change\"];\n        case \"mobile_set_network\":\n        case \"mobile_toggle_airplane_mode\":\n            return [\"device-network-change\"];\n        case \"device_broker_command\":\n            if (args.action === \"invoke\" && args.command === \"device_delete\") {\n                return [\"broker-device-delete\"];\n            }\n            return [];\n        case \"device_broker_appium\":\n            return classifyBrokerAppiumRequest(args);\n        default:\n            return [];\n    }\n}\n\nexport function evaluateDestructivePolicy(name, args = {}) {\n    const actions = [...new Set(classify(name, args))];\n    if (actions.length === 0) return { ok: true, destructive: false, actions: [] };\n    if (hasConfirmation(args)) return { ok: true, destructive: true, actions };\n    return {\n        ok: false,\n        destructive: true,\n        error: \"destructive-action-confirmation-required\",\n        message: `Set ${CONFIRM_DESTRUCTIVE_FIELD}=true to run this destructive device-lab action.`,\n        confirmationField: CONFIRM_DESTRUCTIVE_FIELD,\n        actions,\n    };\n}\n";
type Evaluator = (name: unknown, args?: unknown) => unknown;
const baseline = new Function(baselineSource.replaceAll("export ", "") + ";return evaluateDestructivePolicy;")() as Evaluator;
const evaluate = evaluateDestructivePolicy as Evaluator;
const frozenExamples = new Function(baselineSource.replaceAll("export ", "") + ";return DESTRUCTIVE_POLICY_SCHEMA_EXAMPLES;")() as Array<{ name: string; args: Record<string, unknown> }>;

function shell(command: unknown, args: unknown, extra: Record<string, unknown> = {}) {
    return { action: "request", method: "POST", path: "/execute/sync", body: { script: "mobile: shell", args: [{ command, args }] }, ...extra };
}
function observation(run: () => unknown) {
    try { return { value: run() }; } catch (error) { return { error: error instanceof Error ? error.constructor.name + ":" + error.message : error }; }
}
function parity(name: unknown, args?: unknown) {
    expect(observation(() => evaluate(name, args))).toEqual(observation(() => baseline(name, args)));
}

describe("destructive admission frozen baseline", () => {
    it("covers all switch branches, ordered delete reasons and strict confirmation", () => {
        const examples = [...frozenExamples, { name: "device_reset", args: { eraseSimulator: true } },
            { name: "device_delete", args: { force: true, deleteAvd: true, deleteSimulator: true } }];
        for (const { name, args } of examples) {
            for (const confirmDestructive of [undefined, false, null, 0, 1, "true", new Boolean(true), true]) parity(name, { ...args, confirmDestructive });
            parity(name, Object.assign(Object.create({ confirmDestructive: true }), args));
        }
        expect(evaluate("device_delete", { force: true, deleteAvd: true, deleteSimulator: true, confirmDestructive: true })).toEqual({
            ok: true, destructive: true, actions: ["device-delete", "force-delete", "delete-avd", "delete-simulator"],
        });
        expect(evaluate("device_delete", {})).toEqual({ ok: false, destructive: true,
            error: "destructive-action-confirmation-required", confirmationField: "confirmDestructive",
            message: "Set confirmDestructive=true to run this destructive device-lab action.", actions: ["device-delete"] });
    });

    it("pins every shell reason and exact false negatives", () => {
        for (const [command, argv] of [
            ["pm", ["clear", "pkg"]], ["svc", ["wifi"]], ["svc", ["data"]], ["cmd", ["x", "battery"]],
            ["settings", ["x", "airplane_mode_on"]], ["am", ["broadcast", "-a", "android.intent.action.AIRPLANE_MODE"]],
            ["PM", ["clear", "pkg"]], ["pm ", ["clear", "pkg"]], ["pm", [" clear", "pkg"]], ["pm", ["clear", ""]],
            ["svc", ["WiFi"]], ["cmd", ["Battery"]], ["am", ["x", "android.intent.action.AIRPLANE_MODE"]], ["unknown", []],
        ] as Array<[unknown, unknown]>) {
            for (const method of ["POST", "post", "pOsT", " POST", "POST ", "GET", undefined, 1]) parity("device_broker_appium", shell(command, argv, { method }));
        }
        for (const path of ["/appium/device/remove_app", "prefix/appium/device/remove_app/suffix", "/APPIUM/device/remove_app", "/appium/device/remove-app", "", null, 1]) {
            parity("device_broker_appium", shell("svc", ["wifi"], { path }));
        }
        for (const body of [null, false, 0, "", 1, "body", [], {}, { script: "mobile:shell" }, { script: "mobile: shell " },
            { script: "mobile: shell", args: [{}, { command: "pm", args: ["clear", "pkg"] }] },
            { script: "mobile: shell", args: { 0: { command: "pm", args: ["clear", "pkg"] } } },
            { script: "mobile: shell", args: [null] }, { script: "mobile: shell", args: [{ command: "pm", args: "clear" }] }]) {
            parity("device_broker_appium", shell("pm", [], { body }));
        }
        for (const force of [true, false, 1, "true"]) for (const action of ["clear", "stop", "request", "Clear", " clear", undefined]) {
            parity("device_broker_appium", { force, action });
        }
        for (const action of ["invoke", "Invoke", " invoke", undefined]) for (const command of ["device_delete", "device-delete", "device_delete ", undefined]) parity("device_broker_command", { action, command });
    });

    it("retains defaults, primitive tolerance and existing unguarded null failures", () => {
        for (const name of [...frozenExamples.map(item => item.name), "unknown", "device_status", null, 1]) {
            expect(observation(() => evaluate(name))).toEqual(observation(() => baseline(name)));
            for (const args of [undefined, null, false, 0, 1, "x", [], {}]) parity(name, args);
        }
        const args = { get confirmDestructive(): never { throw new Error("must not read"); } };
        expect(evaluate("unknown", args)).toEqual({ ok: true, destructive: false, actions: [] });
        expect(evaluate("device_broker_command", args)).toEqual({ ok: true, destructive: false, actions: [] });
    });

    it("preserves varying getter reads, conversion order, deduplication and insertion order", () => {
        function input() {
            const trace: string[] = [];
            function getter(target: object, key: string, values: unknown[]) {
                let read = 0;
                Object.defineProperty(target, key, { get() { trace.push(`${key}:${read}`); return values[Math.min(read++, values.length - 1)]; } });
            }
            const first: Record<string, unknown> = {}, body: Record<string, unknown> = {}, args: Record<string, unknown> = {};
            const stringValue = (value: string) => ({ toString() { trace.push(`String:${value}`); return value; } });
            getter(args, "path", ["check", "/appium/device/remove_app"]);
            getter(args, "method", ["check", "post"]);
            getter(args, "body", [body]); getter(args, "force", [true]);
            getter(args, "action", ["clear", "request"]);
            getter(body, "script", ["check", "mobile: shell"]);
            getter(body, "args", [[], [first], [], [first]]);
            getter(first, "command", ["check", "pm"]);
            getter(first, "args", [[], [stringValue("clear"), stringValue("pkg")]]);
            getter(args, "confirmDestructive", [true]);
            return { trace, args };
        }
        const original = input(), current = input();
        expect(evaluate("device_broker_appium", current.args)).toEqual(baseline("device_broker_appium", original.args));
        expect(current.trace).toEqual(original.trace);
        expect(current.trace).toEqual(["path:0", "path:1", "method:0", "method:1", "body:0", "force:0", "action:0", "action:1", "script:0", "script:1", "args:0", "args:1", "command:0", "command:1", "args:2", "args:3", "args:0", "args:1", "String:clear", "String:pkg", "confirmDestructive:0"]);
        expect(evaluate("device_broker_appium", current.args)).toEqual(baseline("device_broker_appium", original.args));
        // Current classifier branches cannot emit duplicate reasons; pin every multi-reason insertion order.
        expect(evaluate("device_broker_appium", shell("pm", ["clear", "pkg"], { path: "/appium/device/remove_app", confirmDestructive: true }))).toEqual({ ok: true, destructive: true, actions: ["app-uninstall", "app-data-clear"] });
    });

    it("propagates raw sentinel identity at every observation boundary before confirmation", () => {
        const sentinel = { marker: "raw exception" };
        for (const key of ["path", "method", "body", "force", "action"]) {
            let confirmationReads = 0;
            const args = { ...shell("pm", ["clear", "pkg"]), get confirmDestructive() { confirmationReads++; return true; } };
            Object.defineProperty(args, key, { get() { throw sentinel; } });
            try { evaluate("device_broker_appium", args); expect.fail("expected raw throw"); } catch (error) { expect(error).toBe(sentinel); }
            expect(confirmationReads).toBe(0);
        }
        for (const args of [{ get force() { throw sentinel; } }, { get confirmDestructive() { throw sentinel; } }]) {
            try { evaluate("device_delete", args); expect.fail("expected raw throw"); } catch (error) { expect(error).toBe(sentinel); }
        }
        for (const key of ["script", "args", "command", "nestedArgs"]) for (const evaluator of [baseline, evaluate]) {
            let confirmationReads = 0;
            const first: Record<string, unknown> = { command: "pm", args: ["clear", "pkg"] };
            const body: Record<string, unknown> = { script: "mobile: shell", args: [first] };
            Object.defineProperty(key === "command" || key === "nestedArgs" ? first : body,
                key === "nestedArgs" ? "args" : key, { get() { throw sentinel; } });
            const input = { ...shell("pm", []), body, get confirmDestructive() { confirmationReads++; return true; } };
            try { evaluator("device_broker_appium", input); expect.fail("expected raw nested throw"); } catch (error) { expect(error).toBe(sentinel); }
            expect(confirmationReads).toBe(0);
        }
        const args = shell("pm", [{ toString() { throw sentinel; } }, "pkg"]);
        try { evaluate("device_broker_appium", args); expect.fail("expected raw conversion throw"); } catch (error) { expect(error).toBe(sentinel); }
    });
});
