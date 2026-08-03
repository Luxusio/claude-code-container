import { describe, expect, it, vi } from "vitest";
import { basename } from "path";
import { hyperVTestFiles, runHyperVLevel3, runHyperVTests } from "./hyper-v.ts";
import {
    buildLevel3Artifacts,
    ensureHostBrokerReady,
    HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
    HYPER_V_LEVEL3_PROVIDER_CONTRACT,
    probeHostBrokerCapabilities,
} from "./support/level3-host.ts";

const verifiedBrokerPid = 4321;
const verifiedBrokerStartedAt = "2026-07-28T00:00:00.000Z";

function brokerStatusOutput(capabilities = HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES) {
    return [
        "port: 17373",
        "brokerReady: true",
        `brokerVerifiedCapabilities: ${capabilities.join(", ")}`,
        `brokerVerifiedPid: ${verifiedBrokerPid}`,
        `brokerVerifiedStartedAt: ${verifiedBrokerStartedAt}`,
    ].join("\n");
}

describe("Hyper-V Level 3 launcher", () => {
    it("rejects a build whose compiled Hyper-V provider lacks the current contract", () => {
        const reads = new Map([
            ["/repo/dist/host-control/hyper-v/contracts.js", "export const oldContract = true;"],
        ]);
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = buildLevel3Artifacts("/repo", {
                spawn: () => ({ status: 0, stdout: "", stderr: "" }),
                readFile: (path: string) => reads.get(path) || "{}",
                writeFile: () => undefined,
            });
            expect(status).toBe(1);
            expect(diagnostic).toContain(HYPER_V_LEVEL3_PROVIDER_CONTRACT);
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("selects both Hyper-V providers by default", () => {
        expect(hyperVTestFiles("all").map((file) => basename(file))).toEqual([
            "level2-hyper-v-windows-vm.ts",
            "level2-hyper-v-linux-vm.ts",
        ]);
    });

    it("selects one Hyper-V provider when requested", () => {
        expect(hyperVTestFiles("windows").map((file) => basename(file))).toEqual(["level2-hyper-v-windows-vm.ts"]);
        expect(hyperVTestFiles("linux").map((file) => basename(file))).toEqual(["level2-hyper-v-linux-vm.ts"]);
    });

    it("rejects unknown targets", () => {
        expect(() => hyperVTestFiles("macos")).toThrow(/all, windows, linux/);
    });

    it("rejects unknown targets before taking the exclusive run lock", async () => {
        const calls: string[] = [];
        await expect(runHyperVLevel3(["--target", "macos"], {
            withExclusiveRealProviderRunImpl: async () => {
                calls.push("exclusive");
                return 0;
            },
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 0;
            },
            ensureHostBrokerReadyImpl: () => {
                calls.push("broker");
                return 0;
            },
        })).rejects.toThrow("--target must be one of: all, windows, linux");
        expect(calls).toEqual([]);
    });

    it("rejects unknown targets before building when invoked directly", async () => {
        const calls: string[] = [];
        await expect(runHyperVTests("macos", {
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 0;
            },
            ensureHostBrokerReadyImpl: () => {
                calls.push("broker");
                return 0;
            },
        })).rejects.toThrow("--target must be one of: all, windows, linux");
        expect(calls).toEqual([]);
    });

    it("builds artifacts and prepares the broker before running the selected provider", async () => {
        const calls: string[] = [];
        const status = await runHyperVTests("windows", {
            env: { TEST_ENV: "1" },
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 0;
            },
            ensureHostBrokerReadyImpl: () => {
                calls.push("broker");
                return 0;
            },
            runSupervisedProcessImpl: async (_command: string, args: string[]) => {
                calls.push(`run:${basename(args.at(-1) || "")}`);
                return { status: 0 };
            },
        });
        expect(status).toBe(0);
        expect(calls).toEqual(["build", "broker", "run:level2-hyper-v-windows-vm.ts"]);
    });

    it("does not prepare the broker or run providers when the build fails", async () => {
        const calls: string[] = [];
        const status = await runHyperVTests("linux", {
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 7;
            },
            ensureHostBrokerReadyImpl: () => {
                calls.push("broker");
                return 0;
            },
            runSupervisedProcessImpl: async () => {
                calls.push("run");
                return { status: 0 };
            },
        });
        expect(status).toBe(7);
        expect(calls).toEqual(["build"]);
    });

    it("does not run providers when broker attestation fails", async () => {
        const calls: string[] = [];
        const status = await runHyperVTests("windows", {
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 0;
            },
            ensureHostBrokerReadyImpl: async () => {
                calls.push("broker");
                return 1;
            },
            runSupervisedProcessImpl: async () => {
                calls.push("run");
                return { status: 0 };
            },
        });

        expect(status).toBe(1);
        expect(calls).toEqual(["build", "broker"]);
    });

    it("attests the repaired broker Hyper-V capability generation", async () => {
        const status = await ensureHostBrokerReady("/repo", {
            spawn: () => ({
                status: 0,
                stdout: brokerStatusOutput(),
                stderr: "",
            }),
            probeHostBrokerCapabilitiesImpl: async () => ({
                ok: true,
                capabilities: HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
                pid: verifiedBrokerPid,
                startedAt: verifiedBrokerStartedAt,
            }),
        });

        expect(status).toBe(0);
    });

    it("bounds the complete Windows broker repair and preserves spawn failures after partial output", async () => {
        let diagnostic = "";
        const observedTimeouts: number[] = [];
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                repairTimeoutMs: 123456,
                spawn: (_command: string, _args: string[], options: { timeout?: number }) => {
                    observedTimeouts.push(Number(options.timeout));
                    return {
                        status: null,
                        signal: "SIGTERM",
                        stdout: "partial broker output",
                        stderr: "",
                        error: Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" }),
                    };
                },
            });

            expect(status).toBe(1);
            expect(observedTimeouts).toHaveLength(1);
            expect(observedTimeouts[0]).toBeGreaterThan(123000);
            expect(observedTimeouts[0]).toBeLessThanOrEqual(123456);
            expect(diagnostic).toContain("partial broker output");
            expect(diagnostic).toContain("CCC host broker repair preflight failed");
            expect(diagnostic).toContain("spawn timed out");
            expect(diagnostic).toContain("timeoutMs=123456");
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("shares one repair deadline across initial status, remote attestation, and confirmation", async () => {
        const observedStatusTimeouts: number[] = [];
        let observedProbeTimeout = 0;
        const now = vi.spyOn(Date, "now")
            .mockReturnValueOnce(1000)
            .mockReturnValueOnce(1000)
            .mockReturnValueOnce(1040)
            .mockReturnValueOnce(1060);
        try {
            const status = await ensureHostBrokerReady("/repo", {
                repairTimeoutMs: 100,
                spawn: (_command: string, _args: string[], options: { timeout?: number }) => {
                    observedStatusTimeouts.push(Number(options.timeout));
                    return {
                        status: 0,
                        signal: null,
                        stdout: brokerStatusOutput(),
                        stderr: "",
                    };
                },
                probeHostBrokerCapabilitiesImpl: async (_port: number, options: { timeoutMs?: number }) => {
                    observedProbeTimeout = Number(options.timeoutMs);
                    return {
                        ok: true,
                        capabilities: HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
                        pid: verifiedBrokerPid,
                        startedAt: verifiedBrokerStartedAt,
                    };
                },
            });

            expect(status).toBe(0);
            expect(observedStatusTimeouts).toEqual([100, 40]);
            expect(observedProbeTimeout).toBe(60);
        } finally {
            now.mockRestore();
        }
    });

    it("rejects a healthy broker that did not attest the candidate Hyper-V generation", async () => {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn: () => ({
                    status: 0,
                    stdout: brokerStatusOutput([
                        "hyper-v-vm-managed-auto-images-v19",
                        "hyper-v-windows-boot-contract-v1",
                    ]),
                    stderr: "",
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain("hyper-v-vm-managed-auto-images-v20");
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("rejects a broker that predates the Windows boot contract", async () => {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn: () => ({
                    status: 0,
                    stdout: brokerStatusOutput([
                        "hyper-v-vm-managed-auto-images-v20",
                        "hyper-v-windows-iso-unattend-v1",
                    ]),
                    stderr: "",
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain("hyper-v-windows-boot-contract-v1");
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("rejects a stale broker observed after CLI repair attestation", async () => {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn: () => ({
                    status: 0,
                    stdout: brokerStatusOutput(),
                    stderr: "",
                }),
                probeHostBrokerCapabilitiesImpl: async () => ({
                    ok: true,
                    capabilities: [
                        "hyper-v-vm-managed-auto-images-v18",
                        "hyper-v-windows-boot-contract-v1",
                    ],
                    pid: verifiedBrokerPid,
                    startedAt: verifiedBrokerStartedAt,
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain("remote capability attestation failed");
            expect(diagnostic).toContain("hyper-v-vm-managed-auto-images-v20");
            expect(diagnostic).toContain("hyper-v-vm-managed-auto-images-v18");
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("reads capabilities directly from the running loopback broker", async () => {
        const capabilities = [
            ...HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
            "http-health",
        ];
        const observed = await probeHostBrokerCapabilities(17373, {
            fetchImpl: async (url: string) => {
                expect(url).toBe("http://127.0.0.1:17373/status");
                return new Response(JSON.stringify({
                    ok: true,
                    broker: {
                        implemented: capabilities,
                        process: { pid: verifiedBrokerPid },
                        startedAt: verifiedBrokerStartedAt,
                    },
                }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            },
        });

        expect(observed).toEqual({
            ok: true,
            capabilities,
            pid: verifiedBrokerPid,
            startedAt: verifiedBrokerStartedAt,
        });
    });

    it("rejects an oversized direct broker status response before reading it", async () => {
        let bodyRead = false;
        const observed = await probeHostBrokerCapabilities(17373, {
            fetchImpl: async () => ({
                ok: true,
                status: 200,
                headers: {
                    get: (name: string) => name === "content-length" ? String(256 * 1024 + 1) : null,
                },
                text: async () => {
                    bodyRead = true;
                    return "{}";
                },
            }),
        });

        expect(observed).toEqual({ ok: false, error: "response-too-large", capabilities: [] });
        expect(bodyRead).toBe(false);
    });

    it("cancels a chunked broker status response at the byte limit", async () => {
        let cancelled = false;
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(200 * 1024));
                controller.enqueue(new Uint8Array(100 * 1024));
            },
            cancel() {
                cancelled = true;
            },
        });
        const observed = await probeHostBrokerCapabilities(17373, {
            fetchImpl: async () => new Response(body, { status: 200 }),
        });

        expect(observed).toEqual({ ok: false, error: "response-too-large", capabilities: [] });
        expect(cancelled).toBe(true);
    });

    it("rejects a broker process identity change between repair and confirmation", async () => {
        let statusCalls = 0;
        const status = await ensureHostBrokerReady("/repo", {
            spawn: () => {
                statusCalls += 1;
                return {
                    status: 0,
                    stdout: statusCalls === 1
                        ? brokerStatusOutput()
                        : brokerStatusOutput().replace(
                            `brokerVerifiedPid: ${verifiedBrokerPid}`,
                            `brokerVerifiedPid: ${verifiedBrokerPid + 1}`,
                        ),
                    stderr: "",
                };
            },
            probeHostBrokerCapabilitiesImpl: async () => ({
                ok: true,
                capabilities: HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES,
                pid: verifiedBrokerPid,
                startedAt: verifiedBrokerStartedAt,
            }),
        });

        expect(status).toBe(1);
        expect(statusCalls).toBe(2);
    });

    it("fails when the broker status command exits zero without readiness", async () => {
        const status = await ensureHostBrokerReady("/repo", {
            spawn: () => ({
                status: 0,
                stdout: "brokerReady: false\n",
                stderr: "",
            }),
        });

        expect(status).toBe(1);
    });
});
