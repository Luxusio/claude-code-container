import { describe, expect, it, vi } from "vitest";
import { createWorkspaceBranchValidation } from "../../application/workspace-branch-validation.js";
import type { WorkspaceBranchValidationPorts } from "../../ports/workspace-branch-validation.js";

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected exception");
}

const invalid = (branch: string, reason: string) => `Invalid branch name '${branch}': ${reason}`;
const rejectionCases: Array<[string, string]> = [
    ["", "Invalid branch name: cannot be empty"],
    [" \t\n", "Invalid branch name: cannot be empty"],
    ["-feature", "cannot start with '-'"],
    ["feature..name", "cannot contain '..'"],
    ["branch@{upstream}", "cannot contain '@{'"],
    ["/feature", "cannot start or end with '/'"],
    ["feature/", "cannot start or end with '/'"],
    ["feat//ure", "cannot contain consecutive slashes"],
    ["feature.lock", "cannot end with '.lock'"],
    ["feature.", "cannot end with '.'"],
    ...[...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)), "\x7f", ..." ~^:?*[]\\"]
        .map(character => [`feat${character}ure`, "contains forbidden characters"] as [string, string]),
];

describe("workspace branch validation policy", () => {
    it.each(rejectionCases)("preserves the exact rejection for %j", (branch, reason) => {
        const utf8ByteLength = vi.fn(() => 0);
        const validate = createWorkspaceBranchValidation({ utf8ByteLength });
        const error = thrown(() => validate(branch));
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(reason.startsWith("Invalid branch name:") ? reason : invalid(branch, reason));
        expect(utf8ByteLength).not.toHaveBeenCalled();
    });

    it.each([
        [" \n", "Invalid branch name: cannot be empty"],
        ["-..", "cannot start with '-'"],
        [".. ", "cannot contain '..'"],
        ["x @{", "contains forbidden characters"],
        ["/@{", "cannot contain '@{'"],
        ["/x//y", "cannot start or end with '/'"],
        ["x//y.lock", "cannot contain consecutive slashes"],
        [`${"x".repeat(256)}.lock`, "cannot end with '.lock'"],
        [`${"x".repeat(256)}.`, "cannot end with '.'"],
    ])("keeps the earlier overlapping rule for %j", (branch, reason) => {
        const utf8ByteLength = vi.fn(() => 256);
        const error = thrown(() => createWorkspaceBranchValidation({ utf8ByteLength })(branch));
        expect((error as Error).message).toBe(reason.startsWith("Invalid branch name:") ? reason : invalid(branch, reason));
        expect(utf8ByteLength).not.toHaveBeenCalled();
    });

    it.each(["feature", "feature/login", "my-branch", "v1.0", "user/feature/v2", "@", ".hidden", "foo/.hidden", "foo.lock/bar", "foo./bar", "user@feature", "a{b}", "a}b", "a;b", "a'b", 'a"b', "a$b", "a`b", "a(b)", "a+b", "é", "😀", "a\u00a0b", "\u00a0feature\u00a0"])("returns accepted legacy input untouched: %j", branch => {
        const utf8ByteLength = vi.fn(() => 255);
        expect(createWorkspaceBranchValidation({ utf8ByteLength })(branch)).toBe(branch);
        expect(utf8ByteLength).toHaveBeenCalledExactlyOnceWith(branch);
    });

    it("uses supplied byte lengths only at the final stage", () => {
        const utf8ByteLength = vi.fn(() => 255);
        const validate = createWorkspaceBranchValidation({ utf8ByteLength });
        expect(utf8ByteLength).not.toHaveBeenCalled();
        expect(validate("x".repeat(300))).toBe("x".repeat(300));
        utf8ByteLength.mockReturnValue(256);
        expect((thrown(() => validate("x")) as Error).message).toBe("Invalid branch name: too long (max 255 bytes)");
        expect(utf8ByteLength.mock.calls).toEqual([["x".repeat(300)], ["x"]]);
    });

    it.each([new Error("byte failure"), { failure: "bytes" }, undefined, null, "byte failure"])("propagates the exact callback failure %j", failure => {
        const utf8ByteLength = vi.fn(() => { throw failure; });
        expect(thrown(() => createWorkspaceBranchValidation({ utf8ByteLength })("feature"))).toBe(failure);
        expect(utf8ByteLength).toHaveBeenCalledExactlyOnceWith("feature");
    });

    it.each([undefined, null, {}, { utf8ByteLength: undefined }, { utf8ByteLength: null }, { utf8ByteLength: 1 }, { utf8ByteLength: "bytes" }, { utf8ByteLength: {} }])("rejects absent or noncallable ports at construction: %j", ports => {
        const error = thrown(() => createWorkspaceBranchValidation(ports as unknown as WorkspaceBranchValidationPorts));
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("Workspace branch validation requires a callable utf8ByteLength port.");
    });

    it("rejects a noncallable function-like port without invoking any of its hooks", () => {
        const invoke = vi.fn();
        const lookup = vi.fn(() => ({ call: invoke, apply: invoke }));
        const ports = { get utf8ByteLength() { return lookup(); } } as unknown as WorkspaceBranchValidationPorts;
        expect(thrown(() => createWorkspaceBranchValidation(ports))).toBeInstanceOf(TypeError);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("looks up the port once at construction and again only after policy accepts", () => {
        const initial = vi.fn(() => 255);
        const replacement = vi.fn(() => 256);
        let selected = initial;
        const lookup = vi.fn(() => selected);
        const validate = createWorkspaceBranchValidation({ get utf8ByteLength() { return lookup(); } });
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(initial).not.toHaveBeenCalled();
        expect(() => validate("-invalid")).toThrow();
        expect(lookup).toHaveBeenCalledTimes(1);
        selected = replacement;
        expect((thrown(() => validate("feature")) as Error).message).toBe("Invalid branch name: too long (max 255 bytes)");
        expect(lookup).toHaveBeenCalledTimes(2);
        expect(initial).not.toHaveBeenCalled();
        expect(replacement).toHaveBeenCalledExactlyOnceWith("feature");
    });

    it.each([new Error("getter failure"), { failure: "lookup" }])("preserves getter failure identity at construction and final access: %j", failure => {
        const callback = vi.fn(() => 0);
        let fail = true;
        const lookup = vi.fn(() => { if (fail) throw failure; return callback; });
        const ports = { get utf8ByteLength() { return lookup(); } };
        expect(thrown(() => createWorkspaceBranchValidation(ports))).toBe(failure);
        fail = false;
        const validate = createWorkspaceBranchValidation(ports);
        fail = true;
        expect(() => validate("-invalid")).toThrow("cannot start with '-'");
        expect(thrown(() => validate("feature"))).toBe(failure);
        expect(lookup).toHaveBeenCalledTimes(3);
        expect(callback).not.toHaveBeenCalled();
    });

    it.each([undefined, null, false, 0, -0, NaN, 0n])("keeps the empty error for raw falsy input %s", branch => {
        const utf8ByteLength = vi.fn(() => 0);
        expect((thrown(() => createWorkspaceBranchValidation({ utf8ByteLength })(branch as unknown as string)) as Error).message).toBe("Invalid branch name: cannot be empty");
        expect(utf8ByteLength).not.toHaveBeenCalled();
    });

    it.each([true, 1, 1n, {}, [], Symbol("branch")])("keeps native method TypeError for truthy nonstring %s", branch => {
        const utf8ByteLength = vi.fn(() => 0);
        expect(thrown(() => createWorkspaceBranchValidation({ utf8ByteLength })(branch as unknown as string))).toBeInstanceOf(TypeError);
        expect(utf8ByteLength).not.toHaveBeenCalled();
    });

    it("passes a boxed string unchanged to a permissive callback and returns it", () => {
        const branch = new String("feature");
        const utf8ByteLength = vi.fn(() => 0);
        expect(createWorkspaceBranchValidation({ utf8ByteLength })(branch as unknown as string)).toBe(branch);
        expect(utf8ByteLength).toHaveBeenCalledExactlyOnceWith(branch);
    });
});
