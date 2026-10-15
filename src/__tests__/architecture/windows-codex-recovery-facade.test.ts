import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

const native = vi.hoisted(() => ({
    spawn: vi.fn(), stat: vi.fn(), realpath: vi.fn(), powershell: vi.fn(), hiddenArgs: vi.fn(),
    root: vi.fn(), runtime: vi.fn(), cli: vi.fn(), normalize: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: native.spawn }));
vi.mock("child_process", () => ({ spawnSync: native.spawn }));
vi.mock("node:fs", () => ({ lstatSync: native.stat, realpathSync: native.realpath }));
vi.mock("fs", () => ({ lstatSync: native.stat, realpathSync: native.realpath }));
vi.mock("@ccc/device-lab/windows-system-powershell.js", () => ({
    canonicalWindowsPowerShellPath: native.powershell, hiddenWindowsPowerShellArgs: native.hiddenArgs,
}));
vi.mock("../../utils.js", () => ({ getCodexDir: native.root }));
vi.mock("../../container-runtime.js", () => ({ getRuntimeInfo: native.runtime, runtimeCli: native.cli }));
vi.mock("../../container-identity.js", () => ({ normalizeImageId: native.normalize }));

import { repairWindowsCodexPrivateState } from "../../adapters/windows-credential-access.js";
import { assertCodexStateAccessible } from "../../codex-state-ownership.js";

type Observation = { status: number | null; stdout?: string; stderr?: string; error?: Error };
type Scenario = {
    ownership: Observation; socket: Observation; mounts: Observation[]; windowsOwner: Observation; account: Observation;
    privateActive: Observation; socketActive: Observation; privateInspection: Observation; socketInspection: Observation;
    privateRepair: Observation; socketRepair: Observation; access: Observation;
    users: Map<string, Observation>; servers: Map<string, Observation>;
};
const result = (stdout = ""): Observation => ({ status: 0, stdout, stderr: "" });
const cli = "finite-runtime";
const target = "target-container";
const source = "C:\\synthetic\\codex";
const store = "C:\\synthetic\\managed-codex";
const rootMount = { Type: "bind", Destination: "/home/ccc/.codex", Source: source, RW: true };
const otherUser = "Codex private state is still used by a container with another user; stop that container before retrying";
const runningServer = "A different container may still use this Codex control socket; its running server was preserved";
let scenario: Scenario;
let phase: "private" | "socket";
let mountIndex: number;
const trace: string[] = [];

beforeEach(() => {
    scenario = {
        ownership: result(), socket: result(), mounts: [result(JSON.stringify([rootMount]))], windowsOwner: result(), account: result("1000\n1000\n"),
        privateActive: result(), socketActive: result(), privateInspection: result("[]"), socketInspection: result("[]"),
        privateRepair: result(), socketRepair: result(), access: result(), users: new Map(), servers: new Map(),
    };
    phase = "private"; mountIndex = 0; trace.length = 0;
    native.stat.mockReset().mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false });
    native.realpath.mockReset().mockImplementation((path: string) => path);
    native.powershell.mockReset().mockReturnValue("finite-powershell.exe");
    native.hiddenArgs.mockReset().mockImplementation((args: string[]) => args);
    native.root.mockReset().mockReturnValue(store);
    native.runtime.mockReset().mockReturnValue({ dockerDesktop: true });
    native.cli.mockReset().mockReturnValue(cli);
    native.normalize.mockReset().mockImplementation((image: string) => image);
    native.spawn.mockReset().mockImplementation((command: string, args: string[], options: { timeout?: number; env?: Record<string, string> }) => {
        if (command === "finite-powershell.exe") {
            trace.push("SID:" + options.env?.CCC_CREDENTIAL_ACCESS_SOURCE); return scenario.windowsOwner;
        }
        if (command !== cli) throw new Error("unexpected executable: " + command);
        if (args[0] === "inspect" && args[1] === "-f") {
            trace.push("mount:" + mountIndex);
            const observation = scenario.mounts[Math.min(mountIndex++, scenario.mounts.length - 1)];
            if (!observation) throw new Error("unexpected mount inspection");
            return observation;
        }
        if (args[0] === "ps") { trace.push("ps:" + phase); return phase === "private" ? scenario.privateActive : scenario.socketActive; }
        if (args[0] === "inspect") { trace.push("inspect:" + phase + ":" + args.slice(1).join(",")); return phase === "private" ? scenario.privateInspection : scenario.socketInspection; }
        if (args[0] === "exec" && args[1] === "-i" && args[2] === target && args[3] === "python3") {
            if (args.at(-1) === "probe") { trace.push("socket probe"); phase = "socket"; return scenario.socket; }
            if (args.at(-1) === "repair") { trace.push("socket repair"); return scenario.socketRepair; }
        }
        if (args[0] === "exec" && args[1] === "--user" && args[2] === "root" && args[3] === "-i") {
            trace.push("private repair"); return scenario.privateRepair;
        }
        if (args[0] === "exec" && args[1] === target && args[2] === "sh" && args.at(-1) === "id -u; id -g") {
            trace.push("account"); return scenario.account;
        }
        if (args[0] === "exec" && args[2] === "id" && args[3] === "-u") {
            trace.push("user:" + args[1]);
            const observed = scenario.users.get(args[1]);
            if (!observed) throw new Error("unexpected UID probe: " + args[1]);
            return observed;
        }
        if (args[0] === "exec" && args[1] === "--user" && args[2] === "root") {
            trace.push("server:" + args[3]);
            const observed = scenario.servers.get(args[3]);
            if (!observed) throw new Error("unexpected server probe: " + args[3]);
            return observed;
        }
        if (args[0] === "exec" && args[1] === target && args[2] === "python3" && args[3] === "-c") {
            if (options.timeout === 300_000) { trace.push("access"); return scenario.access; }
            phase = "private"; trace.push("ownership"); return scenario.ownership;
        }
        throw new Error("unexpected native argv: " + JSON.stringify(args));
    });
});

describe.skipIf(process.platform === "win32")("actual non-Windows recovery gate", () => {
    it("is a synchronous no-op without touching any native binding", () => {
        expect(repairWindowsCodexPrivateState(cli, target)).toBeUndefined();
        expect(repairWindowsCodexPrivateState("second-runtime", "second-target")).toBeUndefined();
        expect(native.spawn).not.toHaveBeenCalled();
        expect(native.stat).not.toHaveBeenCalled();
        expect(native.powershell).not.toHaveBeenCalled();
    });
});

describe.skipIf(process.platform !== "win32")("actual Windows Codex recovery native boundary", () => {
    it("keeps its public synchronous name and arity and probes the socket after healthy ownership", () => {
        expect(repairWindowsCodexPrivateState.name).toBe("repairWindowsCodexPrivateState");
        expect(repairWindowsCodexPrivateState.length).toBe(2);
        expect(repairWindowsCodexPrivateState(cli, target)).toBeUndefined();
        expect(trace).toEqual(["ownership", "socket probe"]);
        expect(native.spawn.mock.calls).toEqual([
            [cli, ["exec", target, "python3", "-c", expect.any(String)], { encoding: "utf8", timeout: 10000 }],
            [cli, ["exec", "-i", target, "python3", "-I", "-", "probe"], { input: expect.any(String), encoding: "utf8", timeout: 10000 }],
        ]);
        expect(native.stat).not.toHaveBeenCalled();
        expect(native.powershell).not.toHaveBeenCalled();
    });

    it.each([
        { observation: { status: null, stderr: undefined }, message: "exit null" },
        { observation: { status: 2, stderr: "  native denial \n" }, message: "native denial" },
        { observation: { status: 10, stderr: " \n" }, message: "" },
        { observation: { status: 0, error: new Error("spawn failed"), stderr: "secondary" }, message: "spawn failed" },
        { observation: { status: 1, error: new Error(""), stderr: "secondary" }, message: "" },
    ])("keeps ownership error precedence, nullish diagnostics and cause for $observation", ({ observation, message }) => {
        scenario.ownership = observation;
        try { repairWindowsCodexPrivateState(cli, target); throw new Error("missing failure"); }
        catch (actual) {
            expect(actual).toBeInstanceOf(Error);
            expect((actual as Error).message).toBe("Codex private state ownership probe failed: " + message);
            expect((actual as Error).cause).toBe(observation.error);
        }
        expect(trace).toEqual(["ownership"]);
        expect(native.stat).not.toHaveBeenCalled();
    });

    it.each([
        { status: 1, stderr: " unrecognized \n" },
        { status: null, stderr: undefined },
        { status: 0, error: new Error("spawn failed"), stderr: " contradictory healthy " },
        { status: 10, error: new Error("spawn failed"), stderr: " contradictory stale " },
    ])("does not authorize stale recovery from contradictory socket evidence %j", observation => {
        scenario.socket = observation;
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow("Codex control socket check failed: " + observation.stderr?.trim());
        expect(trace).toEqual(["ownership", "socket probe"]);
        expect(native.stat).not.toHaveBeenCalled();
    });

    it.each((["private", "socket"] as const).flatMap(phaseUnderTest => [
        { phaseUnderTest, observation: { status: 1, stdout: "not JSON" } },
        { phaseUnderTest, observation: { status: 0, stdout: "not JSON", error: new Error("inspect failed") } },
    ]))("retains $phaseUnderTest mount inspection failure before decoding or SID effects", ({ phaseUnderTest, observation }) => {
        scenario.ownership = { status: phaseUnderTest === "private" ? 1 : 0 };
        scenario.socket = { status: 10 };
        scenario.mounts = [observation];
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow(phaseUnderTest === "private"
            ? "Codex private state mount inspection failed" : "Codex control socket mount inspection failed");
        expect(native.stat).not.toHaveBeenCalled();
        expect(native.powershell).not.toHaveBeenCalled();
        expect(trace).not.toContain("private repair");
        expect(trace).not.toContain("socket repair");
    });

    it.each((["private", "socket"] as const).flatMap(phaseUnderTest => [
        { phaseUnderTest, payload: "not JSON", errorType: SyntaxError },
        { phaseUnderTest, payload: "null", errorType: TypeError },
        { phaseUnderTest, payload: "{}", errorType: TypeError },
        { phaseUnderTest, payload: '"mounts"', errorType: TypeError },
        { phaseUnderTest, payload: "[null]", errorType: TypeError },
    ]))("propagates the raw $errorType.name from $phaseUnderTest mount JSON $payload", ({ phaseUnderTest, payload, errorType }) => {
        scenario.ownership = { status: phaseUnderTest === "private" ? 1 : 0 };
        scenario.socket = { status: 10 };
        scenario.mounts = [result(payload)];
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow(errorType);
        expect(native.stat).not.toHaveBeenCalled();
        expect(trace).not.toContain("account");
        expect(trace).not.toContain("socket repair");
    });

    it.each((["private", "socket"] as const).flatMap(phaseUnderTest => [
        { phaseUnderTest, mounts: [] },
        { phaseUnderTest, mounts: [rootMount, rootMount] },
        { phaseUnderTest, mounts: [{ ...rootMount, RW: false }] },
        { phaseUnderTest, mounts: [{ ...rootMount, Type: "volume" }] },
        { phaseUnderTest, mounts: [{ ...rootMount, Destination: "/another-place" }] },
    ]))("refuses unqualified $phaseUnderTest mounts $mounts before host qualification", ({ phaseUnderTest, mounts }) => {
        scenario.ownership = { status: phaseUnderTest === "private" ? 1 : 0 };
        scenario.socket = { status: 10 };
        scenario.mounts = [result(JSON.stringify(mounts))];
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow(phaseUnderTest === "private"
            ? "Codex private state requires a writable host bind" : "Codex control socket is not in a writable credential bind");
        expect(native.stat).not.toHaveBeenCalled();
        expect(native.powershell).not.toHaveBeenCalled();
    });

    it.each((["private", "socket"] as const).flatMap(phaseUnderTest => [undefined, "", "relative", "C:", "/foreign/path"].map(Source => ({ phaseUnderTest, Source }))))(
        "refuses unresolved $phaseUnderTest source $Source before filesystem or SID observation", ({ phaseUnderTest, Source }) => {
            scenario.ownership = { status: phaseUnderTest === "private" ? 1 : 0 };
            scenario.socket = { status: 10 };
            scenario.mounts = [result(JSON.stringify([{ ...rootMount, Source }]))];
            expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow("Windows credential bind source is unavailable");
            expect(native.stat).not.toHaveBeenCalled();
            expect(native.powershell).not.toHaveBeenCalled();
        });

    it("checks root and existing child directories before account and allows only missing children to continue", () => {
        scenario.ownership = { status: 1 };
        const missing = Object.assign(new Error("missing child"), { code: "ENOENT" });
        native.stat.mockImplementation((path: string) => {
            if (path === source + "/app-server-daemon") throw missing;
            return { isDirectory: () => true, isSymbolicLink: () => false };
        });
        expect(repairWindowsCodexPrivateState(cli, target)).toBeUndefined();
        expect(trace.filter(event => event.startsWith("SID:"))).toEqual(["SID:" + source, "SID:" + source + "/app-server-control", "SID:" + source + "/tmp"]);
        expect(trace.indexOf("account")).toBeGreaterThan(trace.indexOf("SID:" + source + "/tmp"));
        expect(trace).toContain("private repair");
    });

    it("propagates a raw non-ENOENT child failure before account or private repair", () => {
        scenario.ownership = { status: 1 };
        const fault = Object.assign(new Error("child denied"), { code: "EACCES" });
        native.stat.mockImplementation((path: string) => {
            if (path === source + "/app-server-control") throw fault;
            return { isDirectory: () => true, isSymbolicLink: () => false };
        });
        try { repairWindowsCodexPrivateState(cli, target); throw new Error("missing failure"); }
        catch (actual) { expect(actual).toBe(fault); }
        expect(trace).not.toContain("account");
        expect(trace).not.toContain("private repair");
        expect(trace).not.toContain("socket probe");
    });

    it.each(["root", "private child", "socket directory"])("rejects a linked %s before recovery effects", stage => {
        scenario.ownership = { status: stage === "socket directory" ? 0 : 1 };
        scenario.socket = { status: 10 };
        const linked = resolve(source + (stage === "root" ? "" : "/app-server-control"));
        native.stat.mockImplementation((path: string) => ({ isDirectory: () => true, isSymbolicLink: () => path === linked }));
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow("Windows credential directory must not traverse a link");
        expect(trace).not.toContain("account");
        expect(trace).not.toContain("private repair");
        expect(trace).not.toContain("socket repair");
    });

    it.each(["private", "socket"] as const)("retains %s SID failure and its native cause", phaseUnderTest => {
        scenario.ownership = { status: phaseUnderTest === "private" ? 1 : 0 };
        scenario.socket = { status: 10 };
        const fault = new Error("owner process failed");
        scenario.windowsOwner = { status: 0, error: fault, stderr: "contradictory zero" };
        try { repairWindowsCodexPrivateState(cli, target); throw new Error("missing failure"); }
        catch (actual) {
            expect((actual as Error).message).toBe("Windows credential directory owner verification failed");
            expect((actual as Error).cause).toBe(fault);
        }
        expect(trace).not.toContain("account");
        expect(trace).not.toContain("private repair");
        expect(trace).not.toContain("socket repair");
    });

    it("refuses an unavailable trusted owner resolver before spawning a replacement executable", () => {
        scenario.ownership = { status: 1 };
        native.powershell.mockReturnValue(undefined);
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow("Windows credential owner lookup is unavailable");
        expect(trace).toEqual(["ownership", "mount:0"]);
    });

    it("retains the raw SID diagnostic as the cause of a returned owner denial", () => {
        scenario.ownership = { status: 1 };
        scenario.windowsOwner = { status: 1, stderr: " owner denied \n" };
        try { repairWindowsCodexPrivateState(cli, target); throw new Error("missing failure"); }
        catch (actual) {
            expect((actual as Error).message).toBe("Windows credential directory owner verification failed");
            expect((actual as Error).cause).toBeInstanceOf(Error);
            expect(((actual as Error).cause as Error).message).toBe(" owner denied \n");
        }
        expect(trace).not.toContain("account");
        expect(trace).not.toContain("private repair");
    });

    it.each(["", "1000", "-1\n1000", "1000\nname", "1.5\n1000", "1000\n", "1000:1000"])("refuses malformed target account %j before peer discovery", account => {
        scenario.ownership = { status: 1 };
        scenario.account = result(account);
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow("Codex private state user lookup failed");
        expect(trace).toContain("account");
        expect(trace).not.toContain("ps:private");
        expect(trace).not.toContain("private repair");
    });

    it.each([
        { status: 1, stdout: "1000\n1000" },
        { status: 0, stdout: "1000\n1000", error: new Error("account unavailable") },
    ])("refuses contradictory account evidence %j", account => {
        scenario.ownership = { status: 1 }; scenario.account = account;
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow("Codex private state user lookup failed");
        expect(trace).not.toContain("ps:private");
        expect(trace).not.toContain("private repair");
    });

    it.each([
        { uid: "001000", gid: "0001001" },
        { uid: "9007199254740993", gid: "99999999999999999999999999" },
        { uid: "0", gid: "0" },
    ])("forwards decimal account strings $uid/$gid literally without range or numeric policy", ({ uid, gid }) => {
        scenario.ownership = { status: 1 }; scenario.account = result(uid + "\r\n" + gid + "\r\n");
        scenario.privateActive = result("peer");
        scenario.privateInspection = result(JSON.stringify([{ Id: "peer", Mounts: [{ Type: "bind", Source: source }] }]));
        scenario.users.set("peer", result(" " + uid + " \n"));
        expect(repairWindowsCodexPrivateState(cli, target)).toBeUndefined();
        const repair = native.spawn.mock.calls.find(([, args]) => args[0] === "exec" && args[1] === "--user" && args[3] === "-i");
        expect(repair).toEqual([cli, ["exec", "--user", "root", "-i", target, "timeout", "-k", "2s", "30s", "python3", "-I", "-", uid, gid],
            { input: expect.any(String), encoding: "utf8", timeout: 35000 }]);
        expect(trace.indexOf("private repair")).toBeGreaterThan(trace.indexOf("user:peer"));
        expect(trace.at(-1)).toBe("socket probe");
    });

    it("includes the private target and source aliases regardless of peer destination or writability", () => {
        scenario.ownership = { status: 1 };
        scenario.privateActive = result("  " + target + "\npeer\nforeign\n");
        scenario.privateInspection = result(JSON.stringify([
            { Id: target, Mounts: [{ Type: "bind", Source: source, Destination: "/different", RW: false }] },
            { Id: "peer", Mounts: [{ Type: "bind", Source: "/run/desktop/mnt/host/c/SYNTHETIC/CODEX", Destination: "/another", RW: false }] },
            { Id: "foreign", Mounts: [{ Type: "volume", Source: source }, { Type: "bind", Source: "/unrecognized" }, { Type: "bind", Source: "C:/synthetic/elsewhere" }] },
        ]));
        scenario.users.set(target, result("1000")); scenario.users.set("peer", result("1000"));
        expect(repairWindowsCodexPrivateState(cli, target)).toBeUndefined();
        expect(native.spawn.mock.calls.filter(([, args]) => args[0] === "inspect" && args[1] !== "-f")).toEqual([
            [cli, ["inspect", target, "peer", "foreign"], { encoding: "utf8", timeout: 10000 }],
        ]);
        expect(trace.filter(event => event.startsWith("user:"))).toEqual(["user:" + target, "user:peer"]);
        expect(trace.indexOf("private repair")).toBeGreaterThan(trace.indexOf("user:peer"));
    });

    it.each([
        { name: "unknown nonzero", observed: { status: 1, stdout: "1000" } },
        { name: "unknown null status", observed: { status: null, stdout: "1000" } },
        { name: "unknown spawn error despite zero", observed: { status: 0, stdout: "1000", error: new Error("peer unavailable") } },
        { name: "different UID", observed: result("1001") },
        { name: "numerically equal UID with different spelling", observed: result("01000") },
    ])("refuses the first private peer with $name before a malformed trailing record", ({ observed }) => {
        scenario.ownership = { status: 1 };
        scenario.privateActive = result("peer trailing");
        scenario.privateInspection = result(JSON.stringify([{ Id: "peer", Mounts: [{ Type: "bind", Source: source }] }, null]));
        scenario.users.set("peer", observed);
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow(otherUser);
        expect(trace.filter(event => event.startsWith("user:"))).toEqual(["user:peer"]);
        expect(trace).not.toContain("private repair");
        expect(trace).not.toContain("socket probe");
    });

    it("probes a permitted private peer before exposing a raw trailing record error", () => {
        scenario.ownership = { status: 1 };
        scenario.privateActive = result("peer trailing");
        scenario.privateInspection = result(JSON.stringify([{ Id: "peer", Mounts: [{ Type: "bind", Source: source }] }, { Id: "trailing", Mounts: [null] }]));
        scenario.users.set("peer", result("1000"));
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow(TypeError);
        expect(trace.at(-1)).toBe("user:peer");
        expect(trace).not.toContain("private repair");
        expect(trace).not.toContain("socket probe");
    });

    it.each((["private", "socket"] as const).flatMap(phaseUnderTest => [
        { phaseUnderTest, payload: "not JSON", errorType: SyntaxError },
        { phaseUnderTest, payload: "null", errorType: TypeError },
        { phaseUnderTest, payload: "{}", errorType: TypeError },
        { phaseUnderTest, payload: "[null]", errorType: TypeError },
        { phaseUnderTest, payload: '[{"Id":"peer"}]', errorType: TypeError },
        { phaseUnderTest, payload: '[{"Id":"peer","Mounts":null}]', errorType: TypeError },
        { phaseUnderTest, payload: '[{"Id":"peer","Mounts":[null]}]', errorType: TypeError },
    ]))("preserves raw $phaseUnderTest bulk inspection decoding failure for $payload", ({ phaseUnderTest, payload, errorType }) => {
        scenario.ownership = { status: phaseUnderTest === "private" ? 1 : 0 };
        scenario.socket = { status: 10 };
        if (phaseUnderTest === "private") { scenario.privateActive = result("peer"); scenario.privateInspection = result(payload); }
        else { scenario.socketActive = result("peer"); scenario.socketInspection = result(payload); }
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow(errorType);
        expect(trace.filter(event => event.startsWith("user:") || event.startsWith("server:"))).toEqual([]);
        expect(trace).not.toContain("private repair");
        expect(trace).not.toContain("socket repair");
    });

    it.each((["private", "socket"] as const).flatMap(phaseUnderTest => [
        { phaseUnderTest, stage: "ps", observation: { status: 1, stdout: "peer" } },
        { phaseUnderTest, stage: "ps", observation: { status: 0, stdout: "peer", error: new Error("ps failed") } },
        { phaseUnderTest, stage: "inspect", observation: { status: 1, stdout: "not JSON" } },
        { phaseUnderTest, stage: "inspect", observation: { status: 0, stdout: "not JSON", error: new Error("inspect failed") } },
    ]))("refuses contradictory $phaseUnderTest $stage evidence before peer probes or effects", ({ phaseUnderTest, stage, observation }) => {
        scenario.ownership = { status: phaseUnderTest === "private" ? 1 : 0 };
        scenario.socket = { status: 10 };
        if (phaseUnderTest === "private") {
            scenario.privateActive = stage === "ps" ? observation : result("peer");
            scenario.privateInspection = stage === "inspect" ? observation : result("[]");
        } else {
            scenario.socketActive = stage === "ps" ? observation : result("peer");
            scenario.socketInspection = stage === "inspect" ? observation : result("[]");
        }
        const expected = phaseUnderTest === "private"
            ? "Codex private state active users could not be " + (stage === "ps" ? "checked" : "inspected")
            : "Codex control socket users could not be " + (stage === "ps" ? "checked" : "inspected");
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow(expected);
        expect(trace.filter(event => event.startsWith("user:") || event.startsWith("server:"))).toEqual([]);
        expect(trace).not.toContain("private repair");
        expect(trace).not.toContain("socket repair");
    });

    it("excludes both target-prefix directions before socket inspection and recognizes case-insensitive host_mnt aliases", () => {
        scenario.socket = { status: 10 };
        scenario.socketActive = result(target + "\n" + target.slice(0, 6) + "\n" + target + "-longer\npeer\nforeign\n");
        scenario.socketInspection = result(JSON.stringify([
            { Id: "peer", Mounts: [{ Type: "bind", Source: "/host_mnt/C/SYNTHETIC/CODEX" }] },
            { Id: "foreign", Mounts: [{ Type: "bind", Source: "/invalid/alias" }, { Type: "volume", Source: source }] },
        ]));
        scenario.servers.set("peer", result());
        expect(repairWindowsCodexPrivateState(cli, target)).toBeUndefined();
        expect(native.spawn.mock.calls.filter(([, args]) => args[0] === "inspect" && args[1] !== "-f")).toEqual([
            [cli, ["inspect", "peer", "foreign"], { encoding: "utf8", timeout: 10000 }],
        ]);
        expect(trace.filter(event => event.startsWith("server:"))).toEqual(["server:peer"]);
        expect(trace.at(-1)).toBe("socket repair");
        const processProbe = native.spawn.mock.calls.find(([, args]) => args[0] === "exec" && args[3] === "peer");
        expect(processProbe).toEqual([cli, ["exec", "--user", "root", "peer", "python3", "-c", expect.any(String)], { encoding: "utf8", timeout: 10000 }]);
        expect(native.spawn.mock.calls.at(-1)).toEqual([
            cli, ["exec", "-i", target, "python3", "-I", "-", "repair"], { input: expect.any(String), encoding: "utf8", timeout: 10000 },
        ]);
    });

    it.each([
        { name: "running server", observed: { status: 10 } },
        { name: "unknown status", observed: { status: null } },
        { name: "contradictory zero with error", observed: { status: 0, error: new Error("server probe failed") } },
    ])("preserves the first socket peer with $name before a malformed trailing record", ({ observed }) => {
        scenario.socket = { status: 10 };
        scenario.socketActive = result("peer trailing");
        scenario.socketInspection = result(JSON.stringify([{ Id: "peer", Mounts: [{ Type: "bind", Source: source }] }, null]));
        scenario.servers.set("peer", observed);
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow(runningServer);
        expect(trace.filter(event => event.startsWith("server:"))).toEqual(["server:peer"]);
        expect(trace).not.toContain("socket repair");
    });

    it("checks an absent server before exposing the original trailing socket structure error", () => {
        scenario.socket = { status: 10 };
        scenario.socketActive = result("peer trailing");
        scenario.socketInspection = result(JSON.stringify([{ Id: "peer", Mounts: [{ Type: "bind", Source: source }] }, { Id: "trailing", Mounts: null }]));
        scenario.servers.set("peer", result());
        expect(() => repairWindowsCodexPrivateState(cli, target)).toThrow(TypeError);
        expect(trace.at(-1)).toBe("server:peer");
        expect(trace).not.toContain("socket repair");
    });

    it("qualifies fresh mount, host and peer facts for the socket after private repair", () => {
        const socketSource = "C:\\synthetic\\fresh-socket";
        scenario.ownership = { status: 1 }; scenario.socket = { status: 10 };
        scenario.mounts = [result(JSON.stringify([rootMount])), result(JSON.stringify([{ ...rootMount, Source: socketSource }]))];
        scenario.privateActive = result("private-peer");
        scenario.privateInspection = result(JSON.stringify([{ Id: "private-peer", Mounts: [{ Type: "bind", Source: source }] }]));
        scenario.users.set("private-peer", result("1000"));
        scenario.socketActive = result("private-peer socket-peer");
        scenario.socketInspection = result(JSON.stringify([
            { Id: "private-peer", Mounts: [{ Type: "bind", Source: source }] },
            { Id: "socket-peer", Mounts: [{ Type: "bind", Source: "/host_mnt/c/SYNTHETIC/FRESH-SOCKET" }] },
        ]));
        scenario.servers.set("socket-peer", result());
        expect(repairWindowsCodexPrivateState(cli, target)).toBeUndefined();
        expect(trace.filter(event => event.startsWith("user:") || event.startsWith("server:"))).toEqual(["user:private-peer", "server:socket-peer"]);
        expect(trace.filter(event => event.startsWith("SID:"))).toEqual([
            "SID:" + source, "SID:" + source + "/app-server-control", "SID:" + source + "/app-server-daemon", "SID:" + source + "/tmp",
            "SID:" + socketSource + "/app-server-control",
        ]);
        expect(trace.indexOf("socket probe")).toBeGreaterThan(trace.indexOf("private repair"));
        expect(trace.indexOf("mount:1")).toBeGreaterThan(trace.indexOf("socket probe"));
        expect(native.spawn.mock.calls.filter(([, args]) => args[0] === "inspect" && args[1] === "-f")).toEqual([
            [cli, ["inspect", "-f", "{{json .Mounts}}", target], { encoding: "utf8", timeout: 10000 }],
            [cli, ["inspect", "-f", "{{json .Mounts}}", target], { encoding: "utf8", timeout: 10000 }],
        ]);
        expect(trace.at(-1)).toBe("socket repair");
    });

    it("binds fresh native qualification and literal account strings on a later public call", () => {
        scenario.ownership = { status: 1 };
        scenario.mounts = [result(JSON.stringify([rootMount])), result(JSON.stringify([{ ...rootMount, Source: "C:/synthetic/second" }]))];
        expect(repairWindowsCodexPrivateState(cli, target)).toBeUndefined();
        scenario.account = result("001001\n00999");
        expect(repairWindowsCodexPrivateState(cli, target)).toBeUndefined();
        const repairs = native.spawn.mock.calls.filter(([, args]) => args[0] === "exec" && args[1] === "--user" && args[3] === "-i");
        expect(repairs.map(([, args]) => args.slice(-2))).toEqual([["1000", "1000"], ["001001", "00999"]]);
        expect(trace.filter(event => event.startsWith("mount:"))).toEqual(["mount:0", "mount:1"]);
        expect(trace.filter(event => event === "ownership" || event === "socket probe")).toEqual(["ownership", "socket probe", "ownership", "socket probe"]);
        expect(trace).toContain("SID:C:/synthetic/second");
    });

    it.each([
        { status: 1 }, { status: null }, { status: 0, error: new Error("native private write failed") },
    ])("keeps a partial private repair failure and cause without attempting the socket for %j", observation => {
        scenario.ownership = { status: 1 };
        scenario.privateRepair = { ...observation, stderr: " partial ownership write \n" };
        try { repairWindowsCodexPrivateState(cli, target); throw new Error("missing failure"); }
        catch (actual) {
            expect((actual as Error).message).toBe("Codex private state repair failed: partial ownership write");
            expect((actual as Error).cause).toBe(observation.error);
        }
        expect(trace.filter(event => event === "private repair")).toHaveLength(1);
        expect(trace).not.toContain("socket probe");
        expect(trace).not.toContain("socket repair");
    });

    it.each([
        { status: 1 }, { status: null }, { status: 0, error: new Error("native quarantine failed") },
    ])("retains completed private repair when socket recovery fails without replay for %j", observation => {
        scenario.ownership = { status: 1 }; scenario.socket = { status: 10 };
        scenario.socketRepair = { ...observation, stderr: " quarantine denied \n" };
        try { repairWindowsCodexPrivateState(cli, target); throw new Error("missing failure"); }
        catch (actual) {
            expect((actual as Error).message).toBe("Codex disconnected control socket recovery failed: quarantine denied");
            expect((actual as Error).cause).toBeUndefined();
        }
        expect(trace.filter(event => event === "private repair")).toHaveLength(1);
        expect(trace.filter(event => event === "socket repair")).toHaveLength(1);
        expect(trace.indexOf("socket repair")).toBeGreaterThan(trace.indexOf("private repair"));
        expect(trace.at(-1)).toBe("socket repair");
    });

    it("propagates an opaque thrown native observation without translating or retrying it", () => {
        scenario.ownership = { status: 1 };
        const fault = { spawn: "active observation" };
        const original = native.spawn.getMockImplementation()!;
        native.spawn.mockImplementation((command: string, args: string[], options: unknown) => {
            if (args[0] === "ps") throw fault;
            return original(command, args, options);
        });
        try { repairWindowsCodexPrivateState(cli, target); throw new Error("missing failure"); }
        catch (actual) { expect(actual).toBe(fault); }
        expect(trace.at(-1)).toBe("account");
        expect(trace).not.toContain("private repair");
        expect(trace).not.toContain("socket probe");
    });

    it("completes recovery before the existing outer access check on actual Windows", () => {
        scenario.ownership = { status: 1 }; scenario.socket = { status: 10 };
        expect(assertCodexStateAccessible(target, "chosen")).toBeUndefined();
        expect(native.root).toHaveBeenCalledExactlyOnceWith("chosen");
        expect(trace.indexOf("private repair")).toBeGreaterThan(trace.indexOf("account"));
        expect(trace.indexOf("socket repair")).toBeGreaterThan(trace.indexOf("private repair"));
        expect(trace.indexOf("access")).toBeGreaterThan(trace.indexOf("socket repair"));
        expect(trace.at(-1)).toBe("access");
        expect(native.spawn.mock.calls.at(-1)).toEqual([
            cli, ["exec", target, "python3", "-c", expect.any(String)],
            { encoding: "utf-8", input: undefined, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
        ]);
    });

    it("suppresses the outer access check after recovery refusal and retains managed-store guidance on actual Windows", () => {
        scenario.ownership = { status: 1 };
        scenario.privateActive = result("peer");
        scenario.privateInspection = result(JSON.stringify([{ Id: "peer", Mounts: [{ Type: "bind", Source: source }] }]));
        scenario.users.set("peer", result("1001"));
        try { assertCodexStateAccessible(target, "chosen"); throw new Error("missing failure"); }
        catch (actual) {
            expect((actual as Error).message).toBe(otherUser + "\nCCC-managed Codex state (" + store + ") is inaccessible. Stop containers using it and repair its confirmed previous UID/GID ownership. Project-folder chown does not repair this separate store; CCC will not guess the previous owner.");
        }
        expect(trace.at(-1)).toBe("user:peer");
        expect(trace).not.toContain("private repair");
        expect(trace).not.toContain("socket probe");
        expect(trace).not.toContain("access");
    });
});
