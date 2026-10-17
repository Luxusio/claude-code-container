import { afterEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "child_process";
import * as identity from "@ccc/device-lab/device-lab-process-identity.js";
import { discoverBrokerPortProcessForTest, hostBrokerRuntimeFromPortProcessForTest } from "@ccc/device-lab/device-lab-broker.js";

vi.mock("child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("child_process")>(), spawnSync: vi.fn() }));
afterEach(() => {
    vi.mocked(childProcess.spawnSync).mockReset();
    vi.restoreAllMocks();
});

function output(stdout: string, overrides = {}) { return { status: 0, stdout, stderr: "", signal: null, ...overrides }; }

describe("Darwin broker listener process verification", () => {
    it("phase allowance irreversibly shares parent shrink across lsof, ps and identity despite wall jumps", () => {
        let elapsed = 0, parent = 80.8, wall = 1000;
        vi.spyOn(performance, "now").mockImplementation(() => elapsed);
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        const spawn = vi.mocked(childProcess.spawnSync);
        spawn.mockReset();
        spawn.mockImplementationOnce((_file, _args, options) => {
            expect(options?.timeout).toBe(80);
            elapsed = 20; parent = 30.7; wall -= 1e12;
            return output("p12345\n") as any;
        }).mockImplementationOnce((_file, _args, options) => {
            expect(options?.timeout).toBe(30);
            elapsed = 30; parent = 1000; wall += 2e12;
            return output("node owned-broker.js\n") as any;
        });
        const processIdentity = { pid: 12345, startToken: "darwin:started", commandHash: "a".repeat(64) };
        const read = vi.spyOn(identity, "readDeviceRuntimeProcessIdentity").mockImplementation((pid, options) => {
            expect(pid).toBe(12345);
            expect(options?.platform).toBe("darwin");
            expect(Math.floor(options!.remainingMs!())).toBe(20);
            elapsed += 1;
            return processIdentity;
        });
        expect(discoverBrokerPortProcessForTest(17373, "darwin", () => parent)).toMatchObject({ pid: 12345, processIdentity });
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(read).toHaveBeenCalledOnce();
    });

    it("phase allowance refuses native dispatch for a submillisecond parent duration", () => {
        const spawn = vi.mocked(childProcess.spawnSync);
        spawn.mockReset().mockReturnValue(output("") as any);
        const read = vi.spyOn(identity, "readDeviceRuntimeProcessIdentity").mockReturnValue(null);
        expect(discoverBrokerPortProcessForTest(17373, "darwin", () => 0.4)).toBeNull();
        expect(spawn).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    });

    it("phase allowance retains observed PID without starting ps after lsof consumes the duration", () => {
        let elapsed = 0;
        vi.spyOn(performance, "now").mockImplementation(() => elapsed);
        const spawn = vi.mocked(childProcess.spawnSync);
        spawn.mockReset().mockReturnValue(output("") as any).mockImplementationOnce(() => { elapsed = 50; return output("p12345\n") as any; });
        const read = vi.spyOn(identity, "readDeviceRuntimeProcessIdentity").mockReturnValue(null);
        expect(discoverBrokerPortProcessForTest(17373, "darwin", () => 40)).toEqual({ pid: 12345, commandLine: "" });
        expect(spawn).toHaveBeenCalledOnce();
        expect(read).not.toHaveBeenCalled();
    });

    it("phase allowance retains completed late Darwin listener facts for negative classification", () => {
        let elapsed = 0;
        vi.spyOn(performance, "now").mockImplementation(() => elapsed);
        const spawn = vi.mocked(childProcess.spawnSync);
        spawn.mockReset().mockReturnValueOnce(output("p12345\n") as any).mockReturnValueOnce(output("node owned-broker.js\n") as any);
        vi.spyOn(identity, "readDeviceRuntimeProcessIdentity").mockImplementation(() => {
            elapsed = 50;
            return { pid: 12345, startToken: "darwin:started", commandHash: "a".repeat(64) };
        });
        expect(discoverBrokerPortProcessForTest(17373, "darwin", () => 40)).toMatchObject({ pid: 12345, commandLine: "node owned-broker.js" });
        expect(spawn).toHaveBeenCalledTimes(2);
    });

    it("uses canonical lsof and unlimited-width ps with bounded calls", () => {
        const spawn = vi.mocked(childProcess.spawnSync);
        const commandLine = `/usr/local/bin/node /project/${"long-path-".repeat(35)}index.js devices broker serve --port 17373`;
        spawn.mockReturnValueOnce(output("p12345\n") as any).mockReturnValueOnce(output(commandLine + "\n") as any);
        const processIdentity = { pid: 12345, startToken: "darwin:started", commandHash: "a".repeat(64) };
        const read = vi.spyOn(identity, "readDeviceRuntimeProcessIdentity").mockReturnValue(processIdentity);
        const actual = discoverBrokerPortProcessForTest(17373, "darwin");
        expect(actual).toMatchObject({ pid: 12345, commandLine, processIdentity });
        expect(spawn.mock.calls).toEqual([
            ["/usr/sbin/lsof", ["-nP", "-iTCP:17373", "-sTCP:LISTEN", "-Fp"], expect.objectContaining({ timeout: 5000 })],
            ["/bin/ps", ["-ww", "-p", "12345", "-o", "command="], expect.objectContaining({ timeout: 5000 })],
        ]);
        expect(read).toHaveBeenCalledWith(12345, { platform: "darwin" });
    });
    it.each([{ status: 1 }, { error: new Error("timed out") }, { signal: "SIGTERM" }])("rejects failed ps even when partial stdout looks like a broker", (failure) => {
        const spawn = vi.mocked(childProcess.spawnSync);
        spawn.mockReset();
        spawn.mockReturnValueOnce(output("p12345\n") as any).mockReturnValueOnce(output("node index.js devices broker serve --port 17373", failure) as any);
        const read = vi.spyOn(identity, "readDeviceRuntimeProcessIdentity");
        expect(discoverBrokerPortProcessForTest(17373, "darwin")).toBeNull();
        expect(read).not.toHaveBeenCalled();
    });
    it.each(["", "not a pid\n", "p0\n"])("rejects unavailable or malformed listener identity: %j", (stdout) => {
        const spawn = vi.mocked(childProcess.spawnSync);
        spawn.mockReset();
        spawn.mockReturnValueOnce(output(stdout) as any);
        expect(discoverBrokerPortProcessForTest(17373, "darwin")).toBeNull();
        expect(spawn).toHaveBeenCalledTimes(1);
    });
    it("does not relax the exact CLI path fence for whitespace-ambiguous ps output", () => {
        const processIdentity = { pid: 12345, startToken: "darwin:started", commandHash: "a".repeat(64) };
        const commandLine = "/usr/local/bin/node /project/path with spaces/dist/index.js devices broker serve --port 17373";
        const actual = hostBrokerRuntimeFromPortProcessForTest("owner", 17373, {}, "darwin", () => ({ pid: 12345, commandLine, processIdentity }), null, null, "/project/path with spaces/dist/index.js");
        expect(actual).toBeNull();
    });
});
