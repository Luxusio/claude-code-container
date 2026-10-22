import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commands from "@ccc/device-lab/providers/commands.mjs";
import { waitForAndroidApp } from "@ccc/device-lab/providers/backends/android-wait.mjs";
import { waitForIosApp } from "@ccc/device-lab/providers/backends/ios-simulator.mjs";
import { actionResult } from "../../device-lab-mcp/src/action-output.mjs";

const wrap = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
const present = (name: string, value: unknown, detail: boolean) => {
    const response = actionResult(name, name === "wait_for_app" ? "mobile_wait_for_app" : "mobile_wait_for_text", wrap(value), { detail });
    return { response, value: JSON.parse(response.content[0].text) };
};
let time = 0;
beforeEach(() => {
    time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
});
afterEach(() => vi.restoreAllMocks());

for (const backend of ["android", "ios"] as const) {
    describe(`${backend} provider observation to public wait contract`, () => {
        async function observe(result: Record<string, unknown>) {
            const run = vi.spyOn(commands, backend === "android" ? "runWithTimeout" : "run")
                .mockImplementation(() => { time = result.status === 0 && result.stdout ? 99 : 100; return { stdout: "", stderr: "", ...result }; });
            const value = backend === "android"
                ? await waitForAndroidApp("adb", ["-s", "serial"], "com.fixture.app", 100, 50)
                : await waitForIosApp("xcrun", "udid", "com.fixture.app", 100, 50);
            expect(run).toHaveBeenCalledTimes(1);
            return value;
        }

        it.each([false, true])("clean native exit 1 is a successful nonmatch (detail=%s)", async (detail) => {
            const observation = await observe({ status: 1 });
            expect(observation).toMatchObject({ running: false, status: 0, nativeStatus: 1 });
            const { response, value } = present("wait_for_app", observation, detail);
            expect(response.isError).toBe(false);
            expect(value).toMatchObject({ matched: false, reason: "wait-condition-not-met" });
            if (detail) expect(value).toMatchObject({ running: false, status: 0, nativeStatus: 1 });
            else {
                expect(value).not.toHaveProperty("running");
                expect(value).not.toHaveProperty("nativeStatus");
            }
        });

        it.each([false, true])("positive native observation matches (detail=%s)", async (detail) => {
            const observation = await observe({ status: 0, stdout: "123\n" });
            const { response, value } = present("wait_for_app", observation, detail);
            expect(response.isError).toBe(false);
            expect(value).toMatchObject({ matched: true, pid: "123" });
            expect(value).not.toHaveProperty("reason");
            if (detail) expect(value.running).toBe(true);
            else expect(value).not.toHaveProperty("running");
        });

        it.each([
            { status: 1, stderr: "permission denied" },
            { status: 1, stdout: "unexpected output" },
            { status: null, error: new Error("observation timed out"), signal: "SIGTERM" },
        ])("genuine command failure remains an MCP error: %j", async (result) => {
            const observation = await observe(result);
            expect(observation).toHaveProperty("error");
            for (const detail of [false, true]) {
                const { response, value } = present("wait_for_app", observation, detail);
                expect(response.isError).toBe(true);
                expect(value).not.toHaveProperty("matched");
            }
        });
    });
}

describe("public wait fields only simplify valid observations", () => {
    it.each(["wait_for_app", "wait_for_text"])("%s uses explicit matched before legacy booleans", (name) => {
        const observation = { matched: false, found: true, running: true, status: 0 };
        expect(present(name, observation, false).value).toMatchObject({ matched: false, reason: "wait-condition-not-met" });
        expect(present(name, observation, false).value).not.toHaveProperty("found");
        expect(present(name, observation, false).value).not.toHaveProperty("running");
        expect(present(name, observation, true).value).toMatchObject({ found: true, running: true });
    });

    it.each([false, true])("wait text derives found before compact removal (found=%s)", (found) => {
        const { response, value } = present("wait_for_text", { found, status: 0 }, false);
        expect(response.isError).toBe(false);
        expect(value.matched).toBe(found);
        expect(value).not.toHaveProperty("found");
    });

    it.each([false, true])("generic status 1 with misleading matched/running remains failure (detail=%s)", (detail) => {
        const observation = { status: 1, running: false, matched: true };
        const { response, value } = present("wait_for_app", observation, detail);
        expect(response.isError).toBe(true);
        expect(value.running).toBe(false);
        expect(value).not.toHaveProperty("reason");
    });

    it.each([false, true])("nested errors override misleading successful wait fields (detail=%s)", (detail) => {
        const observation = { found: true, matched: true, result: { status: 2, stderr: "transport failed" } };
        const { response, value } = present("wait_for_text", observation, detail);
        expect(response.isError).toBe(true);
        expect(value.found).toBe(true);
        expect(value).not.toHaveProperty("reason");
    });
});
