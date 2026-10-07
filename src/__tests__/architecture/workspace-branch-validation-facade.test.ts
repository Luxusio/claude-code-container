import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as application from "../../application/workspace-branch-validation.js";
import { validateBranchName } from "../../worktree.js";

afterEach(() => vi.restoreAllMocks());

describe("workspace branch validation native facade", () => {
    it("keeps only the narrow facade delegation and public application factory", () => {
        const source = readFileSync(new URL("../../worktree.ts", import.meta.url), "utf8");
        expect(source).toMatch(/export function validateBranchName\(branch: string\): string \{\s*return createWorkspaceBranchValidation\(\{\s*utf8ByteLength: \(value\) => Buffer\.byteLength\(value, "utf-8"\),\s*\}\)\(branch\);\s*\}/);
        expect(Object.keys(application)).toEqual(["createWorkspaceBranchValidation"]);
    });

    it.each([
        ["ASCII", "x".repeat(255), "x".repeat(256)],
        ["multibyte", "é".repeat(127) + "x", "é".repeat(128)],
        ["astral", "😀".repeat(63) + "xxx", "😀".repeat(64)],
        ["lone high surrogate", "\ud800".repeat(85), "\ud800".repeat(85) + "x"],
        ["lone low surrogate", "\udc00".repeat(85), "\udc00".repeat(85) + "x"],
    ])("uses real Buffer UTF-8 thresholds for %s", (_label, accepted, rejected) => {
        expect(Buffer.byteLength(accepted, "utf-8")).toBe(255);
        expect(Buffer.byteLength(rejected, "utf-8")).toBe(256);
        expect(validateBranchName(accepted)).toBe(accepted);
        expect(() => validateBranchName(rejected)).toThrow(new Error("Invalid branch name: too long (max 255 bytes)"));
    });

    it("looks up native Buffer.byteLength dynamically with the raw value and exact encoding", () => {
        const byteLength = vi.spyOn(Buffer, "byteLength").mockReturnValue(255);
        const raw = "\u00a0feature\u00a0";
        expect(validateBranchName(raw)).toBe(raw);
        expect(byteLength).toHaveBeenCalledExactlyOnceWith(raw, "utf-8");
        byteLength.mockReturnValue(256);
        expect(() => validateBranchName("x")).toThrow(new Error("Invalid branch name: too long (max 255 bytes)"));
        expect(byteLength.mock.calls).toEqual([[raw, "utf-8"], ["x", "utf-8"]]);
    });

    it.each([
        ["", "Invalid branch name: cannot be empty"],
        [" \t", "Invalid branch name: cannot be empty"],
        ["-..", "Invalid branch name '-..': cannot start with '-'"],
        [".. ", "Invalid branch name '.. ': cannot contain '..'"],
        ["x @{", "Invalid branch name 'x @{': contains forbidden characters"],
        ["/@{", "Invalid branch name '/@{': cannot contain '@{'"],
        ["/x//y", "Invalid branch name '/x//y': cannot start or end with '/'"],
        ["x//y.lock", "Invalid branch name 'x//y.lock': cannot contain consecutive slashes"],
        ["feature.lock", "Invalid branch name 'feature.lock': cannot end with '.lock'"],
        ["feature.", "Invalid branch name 'feature.': cannot end with '.'"],
    ])("preserves policy errors before native byte access: %j", (branch, message) => {
        const byteLength = vi.spyOn(Buffer, "byteLength");
        expect(() => validateBranchName(branch)).toThrow(new Error(message));
        expect(byteLength).not.toHaveBeenCalled();
    });

    it.each(["@", ".hidden", "foo/.hidden", "foo.lock/bar", "foo./bar", "user@feature", "a{b}", "a}b", "a;b", "a'b", 'a"b', "a$b", "a`b", "a(b)", "a+b", "a\u00a0b", "\u00a0feature\u00a0"])("retains legacy acceptance without normalization: %j", branch => {
        expect(validateBranchName(branch)).toBe(branch);
    });

    it.each([undefined, null, false, 0, -0, NaN, 0n])("retains the empty error for raw falsy %s", branch => {
        const byteLength = vi.spyOn(Buffer, "byteLength");
        expect(() => validateBranchName(branch as unknown as string)).toThrow(new Error("Invalid branch name: cannot be empty"));
        expect(byteLength).not.toHaveBeenCalled();
    });

    it.each([true, 1, 1n, {}, [], Symbol("branch")])("retains method TypeError for truthy nonstring %s", branch => {
        const byteLength = vi.spyOn(Buffer, "byteLength");
        expect(() => validateBranchName(branch as unknown as string)).toThrow(TypeError);
        expect(byteLength).not.toHaveBeenCalled();
    });

    it("retains native Buffer rejection of a boxed string after policy accepts", () => {
        const byteLength = vi.spyOn(Buffer, "byteLength");
        const branch = new String("feature");
        expect(() => validateBranchName(branch as unknown as string)).toThrow(TypeError);
        expect(byteLength).toHaveBeenCalledExactlyOnceWith(branch, "utf-8");
    });

    it("propagates a native byte callback failure unchanged", () => {
        const failure = { native: "byte length" };
        const byteLength = vi.spyOn(Buffer, "byteLength").mockImplementation(() => { throw failure; });
        let caught: unknown;
        try { validateBranchName("feature"); } catch (error) { caught = error; }
        expect(caught).toBe(failure);
        expect(byteLength).toHaveBeenCalledExactlyOnceWith("feature", "utf-8");
    });
});
