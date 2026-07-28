import { describe, expect, it } from "vitest";
import { basename } from "path";
import { hyperVTestFiles, runHyperVLevel3, runHyperVTests } from "./hyper-v.ts";
import { ensureHostBrokerReady, HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES } from "./support/level3-host.ts";

describe("Hyper-V Level 3 launcher", () => {
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

    it("attests the repaired broker Hyper-V capability generation", () => {
        const status = ensureHostBrokerReady("/repo", {
            spawn: () => ({
                status: 0,
                stdout: [
                    "brokerReady: true",
                    `brokerVerifiedCapabilities: ${HYPER_V_LEVEL3_REQUIRED_BROKER_CAPABILITIES.join(", ")}`,
                ].join("\n"),
                stderr: "",
            }),
        });

        expect(status).toBe(0);
    });

    it("rejects a healthy broker that did not attest the candidate Hyper-V generation", () => {
        let diagnostic = "";
        const originalWrite = process.stderr.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        try {
            const status = ensureHostBrokerReady("/repo", {
                spawn: () => ({
                    status: 0,
                    stdout: [
                        "brokerReady: true",
                        "brokerVerifiedCapabilities: hyper-v-vm-managed-auto-images-v19, hyper-v-windows-iso-unattend-v1",
                    ].join("\n"),
                    stderr: "",
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain("hyper-v-vm-managed-auto-images-v20");
        } finally {
            process.stderr.write = originalWrite;
        }
    });
});
