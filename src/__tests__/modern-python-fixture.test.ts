import type { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { modernPythonFixture } from "./helpers/modern-python-fixture.js";

beforeEach(() => { vi.stubEnv("CCC_TEST_PYTHON", undefined); });
afterEach(() => { vi.unstubAllEnvs(); });

it("continues past an older default Python and uses the interpreter's absolute identity", () => {
    const spawn = vi.fn().mockReturnValueOnce({ status: 1, stdout: "", signal: null })
        .mockReturnValueOnce({ status: 0, stdout: JSON.stringify("/fixture/python3.13"), signal: null });
    expect(modernPythonFixture(spawn as typeof spawnSync)).toEqual({ executable: "/fixture/python3.13" });
    expect(spawn.mock.calls.map(([command]) => command)).toEqual(["python3.12", "python3.13"]);
});

it("reports an absent default prerequisite without inventing a passing interpreter", () => {
    const spawn = vi.fn().mockReturnValue({ status: 1, stdout: "", signal: null });
    expect(modernPythonFixture(spawn as typeof spawnSync)).toMatchObject({ executable: null, reason: expect.stringContaining("CCC_TEST_PYTHON") });
});

it("fails an unavailable explicitly configured interpreter without trying a default", () => {
    const spawn = vi.fn().mockReturnValue({ status: 1, stdout: "", signal: null });
    expect(() => modernPythonFixture(spawn as typeof spawnSync, "/invalid/python")).toThrow("CCC_TEST_PYTHON");
    expect(spawn).toHaveBeenCalledOnce();
});
