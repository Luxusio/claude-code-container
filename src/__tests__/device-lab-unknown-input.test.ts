import { describe, expect, it } from "vitest";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";
import { toolInputError } from "../../device-lab-mcp/src/tool-arguments.mjs";

describe("closed public arguments", () => {
    it.each(TOOLS)("closes the $name advertised schema", tool => {
        expect(tool.inputSchema.additionalProperties).toBe(false);
    });
    it("rejects a misspelled clipboard write instead of selecting read", () => {
        expect(toolInputError("clipboard", { deviceId: "phone", action: "set", value: "secret" })).toBe("clipboard does not support action");
        expect(toolInputError("clipboard", { deviceId: "phone", value: "secret" })).toBe("clipboard does not support value");
        expect(toolInputError("clipboard", { deviceId: "phone", text: "" })).toBeNull();
    });
    it.each([
        ["click", { deviceId: "phone", x: 1, y: 2 }],
        ["list_files", { deviceId: "vm", path: "/" }],
        ["start", { deviceId: "vm" }],
        ["run_flow", { steps: [] }],
    ] as const)("rejects unknown %s fields and preserves internal routing", (name, args) => {
        expect(toolInputError(name, { ...args, typo: true })).toBe(`${name} does not support typo`);
        expect(toolInputError(name, { ...args, implicitBroker: false, autolaunch: false })).toBeNull();
    });

    it.each([
        {}, { command: "echo legacy", argv: ["launchctl"] }, { argv: null }, { argv: "launchctl" },
        { argv: [] }, { argv: [null] }, { argv: [["launchctl"]] }, { argv: ["launchctl", 1] },
        { argv: [""] }, { argv: ["-launchctl"] }, { argv: ["/bin/launchctl"] },
        { argv: ["bin/launchctl"] }, { argv: [".relative"] }, { argv: [".."] },
        { argv: ["launchctl managerpid"] }, { argv: ["launchctl\\managerpid"] },
        { argv: ["launchctl;echo"] }, { argv: ["launchctl", "a\0b"] },
        { argv: ["launchctl", "x".repeat(4097)] }, { argv: ["x", "y".repeat(4096)] },
        { argv: Array(65).fill("x") },
    ])("refuses malformed exec alternatives before public dispatch: %j", args => {
        expect(toolInputError("exec", { deviceId: "ios-owned", ...args })).toMatch(/exec/);
    });

    it.each([
        { command: "printf '%s' '$HOME; untouched'" },
        { argv: ["launchctl"] },
        { argv: ["Program-1.2_+", "", " \t\n", "$(touch private); 'quoted'", "한글"] },
        { argv: ["x", "y".repeat(4095)] },
        { argv: Array(64).fill("x") },
    ])("admits exec alternatives without rewriting their argument bytes: %j", args => {
        const before = structuredClone(args);
        expect(toolInputError("exec", { deviceId: "ios-owned", ...args })).toBeNull();
        expect(args).toEqual(before);
        expect(toolInputError("exec", { deviceId: "ios-owned", ...args, typo: true })).toBe("exec does not support typo");
    });
});
