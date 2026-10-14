import { describe, expect, it, vi } from "vitest";
import { run } from "../../scripts/real-tests/level2-real-linux-vm.ts";

const level = Number(process.env.CCC_TEST_LEVEL || "0");

describe.runIf(level >= 2)("level 2 device-lab Linux VM integration", () => {
    it("runs through the public device-lab MCP", async () => {
        const result = await run();
        expect(["PASS", "SKIP"]).toContain(result.status);
        if (result.status === "SKIP") expect(result.reason).toBeTruthy();
    });
});


describe("QEMU real-test returned fixture identity", () => {
    async function fixtureRun(failStart = false) {
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        const returnedId = "linux-vm-13579bdf-2468-4ace-8bdf-13579bdf2468";
        const calls: Array<{ tool: string; args: any }> = [];
        const reply = (value: any) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
        const callTool = async (tool: string, args: any) => {
            calls.push({ tool, args });
            expect(args).not.toHaveProperty("incarnationId");
            if (tool === "create_linux_vm") {
                expect(args).not.toHaveProperty("deviceId");
                expect(args).not.toHaveProperty("labId");
                return reply({ ok: true, device: { deviceId: returnedId, name: args.name, status: "stopped" } });
            }
            if (["status", "start", "stop", "delete"].includes(tool)) expect(args.deviceId).toBe(returnedId);
            if (tool === "status") return reply({ ok: true, device: { deviceId: returnedId }, readiness: { state: "stopped" } });
            if (tool === "start") {
                if (failStart) throw new Error("fixture-qemu-start-failed");
                return reply({ ok: true, device: { deviceId: returnedId, runtime: { pid: 12345 } } });
            }
            if (tool === "import_image") return { isError: true, ...reply({ ok: false, error: "source-image-missing" }) };
            return reply({ ok: true });
        };
        vi.resetModules();
        vi.doMock("../../scripts/real-tests/helpers.ts", () => ({
            commandPath: () => "/fixture/qemu", findBaseImage: () => "/fixture/state/images/base.qcow2",
            providerEnv: { CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" }, stateRoot: "/fixture/state",
            stateRelative: () => "images/base.qcow2",
        }));
        vi.doMock("fs", async () => { const actual = await vi.importActual<typeof import("fs")>("fs"); return { ...actual, existsSync: (path: any) => path === "/dev/kvm" || actual.existsSync(path) }; });
        vi.doMock("../../scripts/real-tests/device-lab-mcp-client.ts", async () => {
            const actual = await vi.importActual<typeof import("../../scripts/real-tests/device-lab-mcp-client.ts")>("../../scripts/real-tests/device-lab-mcp-client.ts");
            return { ...actual, withDeviceLabMcp: (operation: any) => operation({ callTool }) };
        });
        const kill = vi.spyOn(process, "kill").mockReturnValue(true);
        const wait = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => { callback(); return 0; }) as any);
        try {
            Object.defineProperty(process, "platform", { ...platform, value: "linux" });
            const helper = await import("../../scripts/real-tests/level2-real-linux-vm.ts");
            const result = await helper.run();
            return { result, calls, returnedId };
        } catch (error) { Object.assign(error as object, { calls, returnedId }); throw error; }
        finally {
            Object.defineProperty(process, "platform", platform);
            kill.mockRestore(); wait.mockRestore();
            vi.doUnmock("fs"); vi.doUnmock("../../scripts/real-tests/helpers.ts"); vi.doUnmock("../../scripts/real-tests/device-lab-mcp-client.ts");
            vi.resetModules();
        }
    }
    it("captures the generated ID and uses it for status, start, stop and final deletion", async () => {
        const { result, calls, returnedId } = await fixtureRun();
        expect(result.status).toBe("PASS");
        expect(calls.filter(call => ["status", "start", "stop", "delete"].includes(call.tool)).map(call => call.args.deviceId)).toEqual(Array(4).fill(returnedId));
        expect(calls.map(call => call.tool)).toEqual(["create_linux_vm", "list_images", "import_image", "status", "start", "stop", "delete"]);
    });
    it("deletes the exact returned fixture after start fails without selecting a display name", async () => {
        const error = await fixtureRun(true).catch(error => error);
        expect(error.message).toContain("fixture-qemu-start-failed");
        expect(error.calls.at(-1)).toMatchObject({ tool: "delete", args: { deviceId: error.returnedId } });
        expect(error.calls.some((call: any) => call.tool === "stop")).toBe(false);
    });
});
