import { describe, expect, it, vi } from "vitest";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "#device-lab/providers/contracts/broker-protocol.mjs";
import { ensureHostBrokerReady, level3BrokerEnv } from "./support/level3-host.ts";

function readyOutput(port: number) {
    return [
        `port: ${port}`,
        "brokerReady: true",
        `brokerVerifiedProtocolVersion: ${DEVICE_BROKER_PROTOCOL_VERSION}`,
        "brokerVerifiedPid: 4321",
        "brokerVerifiedStartedAt: 2026-10-26T00:00:00.000Z",
    ].join("\n");
}

describe("Level 3 broker endpoint isolation", () => {
    it("defaults child environments to the separate endpoint while retaining HOME and provider locks", () => {
        const original = { HOME: "/real-home", CCC_PROFILE: "test", PATH: "/bin" };
        expect(level3BrokerEnv(original)).toEqual({ ...original, CCC_DEVICE_BROKER_PORT: "17374" });
        expect(original).not.toHaveProperty("CCC_DEVICE_BROKER_PORT");
        expect(level3BrokerEnv({ CCC_DEVICE_BROKER_PORT: "" }).CCC_DEVICE_BROKER_PORT).toBe("17374");
    });

    it("accepts a valid explicit endpoint and refuses malformed configuration", () => {
        expect(level3BrokerEnv({ CCC_DEVICE_BROKER_PORT: "17375" }).CCC_DEVICE_BROKER_PORT).toBe("17375");
        for (const value of ["0", "65536", "17374/path", "17374.0", " 17374"]) {
            expect(() => level3BrokerEnv({ CCC_DEVICE_BROKER_PORT: value })).toThrow();
        }
    });

    it("rejects preflight output pointing at the ordinary broker before making HTTP probes", async () => {
        const probe = vi.fn();
        const writeError = vi.fn();
        expect(await ensureHostBrokerReady("/repo", {
            env: level3BrokerEnv({}),
            spawn: () => ({ status: 0, stdout: readyOutput(17373), stderr: "" }),
            probeHostBrokerProtocolImpl: probe,
            writeError,
        })).toBe(1);
        expect(probe).not.toHaveBeenCalled();
        expect(writeError).toHaveBeenCalledWith(expect.stringContaining("expected 127.0.0.1:17374, reported port 17373"));
    });

    it("passes the selected environment to CLI preflight and confirms the same endpoint twice", async () => {
        const env = level3BrokerEnv({ HOME: "/real-home" });
        const spawn = vi.fn((_command: string, _args: string[], _options: any) => ({ status: 0, stdout: readyOutput(17374), stderr: "" }));
        const probe = vi.fn(async (_port: number) => ({
            ok: true,
            protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
            pid: 4321,
            startedAt: "2026-10-26T00:00:00.000Z",
        }));
        expect(await ensureHostBrokerReady("/repo", { env, spawn, probeHostBrokerProtocolImpl: probe })).toBe(0);
        expect(spawn.mock.calls[0][2].env).toBe(env);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(probe.mock.calls.every(call => call[0] === 17374)).toBe(true);
    });
});
