import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import {
    brokerStatus,
    implicitBrokerProbeOptions,
    removeBrokerRuntimeForTest,
    verifyAuthenticatedBrokerGenerationForTest,
    writeBrokerRuntimeForTest,
} from "../../device-lab-mcp/src/broker.mjs";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";

describe("MCP broker endpoint and runtime isolation", () => {
    let home: string;
    let restoreEnvironment: () => void;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), "ccc-mcp-broker-isolation-"));
        restoreEnvironment = isolateDeviceLabTestEnvironment(home);
    });

    afterEach(() => {
        restoreEnvironment();
        rmSync(home, { recursive: true, force: true });
    });

    function runtimeFile(port = 17373) {
        return join(home, ".ccc", "devices", "broker", port === 17373 ? "runtime.json" : `runtime-${port}.json`);
    }

    function runtime(port: number, token = "isolated-birth") {
        return {
            name: "ccc-device-broker",
            managedBy: "ccc-host",
            host: "127.0.0.1",
            port,
            pid: 4321,
            startedAt: "2026-10-26T04:00:00.000Z",
            processStartToken: token,
        };
    }

    function publish(file: string, value: unknown) {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
        return readFileSync(file);
    }

    it.each([undefined, ""])("retains singleton discovery with an absent or empty port override (%s)", async configured => {
        if (configured !== undefined) process.env.CCC_DEVICE_BROKER_PORT = configured;
        const legacy = runtime(18373);
        publish(runtimeFile(), legacy);

        expect(implicitBrokerProbeOptions({ autolaunch: false })).toEqual(expect.objectContaining({
            port: legacy.port,
            hostCandidates: expect.arrayContaining(["127.0.0.1", "host.docker.internal"]),
            autolaunch: false,
        }));
        const status = await brokerStatus({ probe: false, autolaunch: false });
        expect(status.state.runtimeFile).toBe(runtimeFile());
        expect(status.runtime).toEqual(legacy);
        expect((await brokerStatus({ port: 18375, probe: false, autolaunch: false })).state.runtimeFile)
            .toBe(runtimeFile());
    });

    it("uses only loopback and the configured port despite singleton and wrong-port scoped metadata", async () => {
        process.env.CCC_DEVICE_BROKER_PORT = "17374";
        const singletonBytes = publish(runtimeFile(), runtime(17373, "global-birth"));
        const scoped = runtimeFile(17374);

        for (const stale of [null, { ...runtime(18374), host: "host.docker.internal" }]) {
            if (stale) publish(scoped, stale);
            else rmSync(scoped, { force: true });
            expect(implicitBrokerProbeOptions({ autolaunch: false })).toEqual(expect.objectContaining({
                hostCandidates: ["127.0.0.1"],
                port: 17374,
                autolaunch: false,
            }));
            const status = await brokerStatus({ probe: false, autolaunch: false });
            expect(status.state.runtimeFile).toBe(scoped);
            expect(status.transport.hostCandidates).toEqual(["127.0.0.1"]);
            expect(status.transport.defaultPort).toBe(17374);
        }
        expect(readFileSync(runtimeFile())).toEqual(singletonBytes);
    });

    it("keeps runtime.json for a configured default port and honors an explicit numeric route", async () => {
        process.env.CCC_DEVICE_BROKER_PORT = "17373";
        publish(runtimeFile(), runtime(18373));
        expect(implicitBrokerProbeOptions({ autolaunch: false })).toEqual(expect.objectContaining({
            hostCandidates: ["127.0.0.1"], port: 17373,
        }));
        expect((await brokerStatus({ probe: false, autolaunch: false })).state.runtimeFile).toBe(runtimeFile());

        process.env.CCC_DEVICE_BROKER_PORT = "17374";
        const singletonBytes = readFileSync(runtimeFile());
        const configuredBytes = publish(runtimeFile(17374), runtime(17374, "configured-birth"));
        const explicitRuntime = runtime(18375, "explicit-birth");
        publish(runtimeFile(18375), explicitRuntime);
        expect(implicitBrokerProbeOptions({
            port: 18375, hostCandidates: ["host.docker.internal"], autolaunch: false,
        })).toEqual(expect.objectContaining({
            hostCandidates: ["host.docker.internal"], port: 18375, autolaunch: false,
        }));
        const [status, configuredStatus] = await Promise.all([
            brokerStatus({ port: 18375, probe: false, autolaunch: false }),
            brokerStatus({ probe: false, autolaunch: false }),
        ]);
        expect(status.transport.defaultPort).toBe(18375);
        expect(status.state.runtimeFile).toBe(runtimeFile(18375));
        expect(status.runtime).toEqual(explicitRuntime);
        expect(configuredStatus.transport.defaultPort).toBe(17374);
        expect(configuredStatus.state.runtimeFile).toBe(runtimeFile(17374));
        expect(configuredStatus.runtime).toEqual(runtime(17374, "configured-birth"));
        expect(readFileSync(runtimeFile())).toEqual(singletonBytes);
        expect(readFileSync(runtimeFile(17374))).toEqual(configuredBytes);
    });

    it("scopes runtime publication, successor CAS and removal without changing the singleton bytes", () => {
        process.env.CCC_DEVICE_BROKER_PORT = "17374";
        const singletonBytes = publish(runtimeFile(), runtime(17373, "global-birth"));
        const original = runtime(17374);
        const successor = { ...original, pid: 4322, processStartToken: "successor-birth" };
        const scoped = runtimeFile(17374);

        expect(writeBrokerRuntimeForTest(original, null)).toBe(true);
        expect(JSON.parse(readFileSync(scoped, "utf8"))).toEqual(original);
        expect(writeBrokerRuntimeForTest(successor, null)).toBe(false);
        expect(writeBrokerRuntimeForTest(successor, original)).toBe(true);
        expect(removeBrokerRuntimeForTest(original)).toBe(false);
        expect(JSON.parse(readFileSync(scoped, "utf8"))).toEqual(successor);
        expect(removeBrokerRuntimeForTest(successor)).toBe(true);
        expect(existsSync(scoped)).toBe(false);
        expect(readFileSync(runtimeFile())).toEqual(singletonBytes);
    });

    it.each(["0", "65536", "017374", "17374.0", " 17374", "17374 ", "+17374", "invalid"])(
        "rejects the invalid environment port %s without publishing metadata",
        async configured => {
            const singletonBytes = publish(runtimeFile(), runtime(17373, "global-birth"));
            process.env.CCC_DEVICE_BROKER_PORT = configured;
            expect(() => implicitBrokerProbeOptions()).toThrow();
            await expect(brokerStatus({ probe: false, autolaunch: false })).rejects.toThrow();
            expect(readFileSync(runtimeFile())).toEqual(singletonBytes);
            expect(existsSync(runtimeFile(17374))).toBe(false);
        },
    );

    it("attests only the selected runtime generation and retains global metadata on refusal", async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        let selectedRuntime = runtime(0);
        const server = createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url !== "/status") {
                res.statusCode = 404;
                res.end(JSON.stringify({ ok: false }));
                return;
            }
            res.end(JSON.stringify({
                ok: true,
                broker: {
                    name: "ccc-device-broker",
                    mode: "host-broker-daemon",
                    port: selectedRuntime.port,
                    protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
                    startedAt: selectedRuntime.startedAt,
                    process: { pid: selectedRuntime.pid, startToken: selectedRuntime.processStartToken },
                },
            }));
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const port = (server.address() as AddressInfo).port;
            process.env.CCC_DEVICE_BROKER_PORT = String(port);
            selectedRuntime = runtime(port);
            // The default record deliberately has the same answering generation. It must
            // still provide no authority for a different selected metadata namespace.
            const singletonBytes = publish(runtimeFile(), selectedRuntime);
            const processVerifier = vi.fn(() => ({ pid: selectedRuntime.pid, processStartToken: selectedRuntime.processStartToken }));
            const verify = () => verifyAuthenticatedBrokerGenerationForTest("127.0.0.1", port, null,
                { timeoutMs: 1000 }, { containerBoundary: false, processVerifier });

            await expect(verify()).resolves.toBeNull();
            expect(processVerifier).not.toHaveBeenCalled();
            publish(runtimeFile(port), selectedRuntime);
            await expect(verify()).resolves.toEqual(selectedRuntime);
            expect(processVerifier).toHaveBeenCalledOnce();

            publish(runtimeFile(port), { ...selectedRuntime, processStartToken: "successor-birth" });
            await expect(verify()).resolves.toBeNull();
            expect(processVerifier).toHaveBeenCalledOnce();
            expect(readFileSync(runtimeFile())).toEqual(singletonBytes);
        } finally {
            try {
                if (server.listening) {
                    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                }
            } finally {
                if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
                else process.env.NODE_ENV = originalNodeEnv;
            }
        }
    });
});
