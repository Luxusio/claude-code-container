import { DEVICE_BROKER_PROTOCOL_VERSION } from "#device-lab/providers/contracts/broker-protocol.mjs";
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { pathToFileURL } from "url";
import ts from "typescript";
import { ensureWindowsServerEvaluationLicense, hyperVTestFiles, PRIVILEGE_PROBE_DEFAULTS, runHyperVLevel3, runHyperVTests, warnIfSetupDiagnosticsWillLackPrivilege } from "./hyper-v.ts";
import { repoRoot } from "./helpers.ts";
import {
    buildLevel3Artifacts,
    ensureHostBrokerReady,
    probeHostBrokerProtocol,
} from "./support/level3-host.ts";

const verifiedBrokerPid = 4321;
const verifiedBrokerStartedAt = "2026-07-28T00:00:00.000Z";

function brokerStatusOutput(protocolVersion = DEVICE_BROKER_PROTOCOL_VERSION) {
    return [
        "port: 17373",
        "brokerReady: true",
        `brokerVerifiedProtocolVersion: ${protocolVersion}`,
        `brokerVerifiedPid: ${verifiedBrokerPid}`,
        `brokerVerifiedStartedAt: ${verifiedBrokerStartedAt}`,
    ].join("\n");
}

describe("Level 3 artifact preparation", () => {
    it("binds pre-assembly protocol checks to workspace 9 while assembled protocol 8 stays cached", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-level3-protocol-binding-"));
        try {
            const packageRoot = join(root, "node_modules", "@ccc", "device-lab");
            const workspaceContracts = join(packageRoot, "providers", "contracts");
            const assembledContracts = join(root, "dist", "packages", "device-lab", "providers", "contracts");
            for (const directory of [workspaceContracts, assembledContracts]) mkdirSync(directory, { recursive: true });
            writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", imports: {
                "#device-lab/providers/*": "./dist/packages/device-lab/providers/*",
            } }));
            writeFileSync(join(packageRoot, "package.json"), readFileSync(join(repoRoot, "packages", "device-lab", "package.json")));
            for (const name of ["broker-protocol.mjs", "broker-endpoint.mjs"])
                writeFileSync(join(workspaceContracts, name), readFileSync(join(repoRoot, "packages", "device-lab", "providers", "contracts", name)));
            const assembledProtocol = join(assembledContracts, "broker-protocol.mjs");
            writeFileSync(assembledProtocol, "export const DEVICE_BROKER_PROTOCOL_VERSION = 8;\nexport function isCompatibleBrokerProtocol(value) { return value === DEVICE_BROKER_PROTOCOL_VERSION; }\n");
            // Strip only TypeScript syntax from the actual helper. Keep its package
            // imports for normal Node resolution; Vitest's aliases mask this fault.
            const transformed = ts.transpileModule(readFileSync(join(repoRoot, "scripts", "real-tests", "support", "level3-host.ts"), "utf8"), {
                fileName: "level3-host.ts", reportDiagnostics: true,
                compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
            });
            expect(transformed.diagnostics).toEqual([]);
            writeFileSync(join(root, "level3-host.mjs"), transformed.outputText);
            const entry = join(root, "probe.mjs");
            writeFileSync(entry, String.raw`
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {DEVICE_BROKER_PROTOCOL_VERSION as cachedBefore} from '#device-lab/providers/contracts/broker-protocol.mjs';
import {DEVICE_BROKER_PROTOCOL_VERSION as workspace} from '@ccc/device-lab/providers/contracts/broker-protocol.mjs';
import {probeHostBrokerProtocol} from './level3-host.mjs';
let protocolVersion=9;const requests=[];
const server=createServer((req,res)=>{
 requests.push({url:req.url,protocolVersion});res.setHeader('content-type','application/json');
 res.end(JSON.stringify({ok:true,broker:{protocolVersion,process:{pid:4321},startedAt:'2026-07-28T00:00:00.000Z'}}));
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
try{
 const port=server.address().port;
 const probePair=async()=>{const results=[];for(const version of [9,8]){protocolVersion=version;results.push(await probeHostBrokerProtocol(port,{timeoutMs:1000}));}return results;};
 const before=await probePair();
 // Assembly replaces the file after the launcher has already loaded. The old
 // import remains cached, while a distinct URL proves the new disk bytes are 9.
 writeFileSync(${JSON.stringify(assembledProtocol)},readFileSync(${JSON.stringify(join(workspaceContracts, "broker-protocol.mjs"))}));
 const cachedAfter=(await import('#device-lab/providers/contracts/broker-protocol.mjs')).DEVICE_BROKER_PROTOCOL_VERSION;
 const assembled=(await import(pathToFileURL(${JSON.stringify(assembledProtocol)}).href+'?after-assembly')).DEVICE_BROKER_PROTOCOL_VERSION;
 const after=await probePair();
 console.log(JSON.stringify({workspace,cachedBefore,cachedAfter,assembled,before,after,requests}));
}finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
`);
            const output = spawnSync(process.execPath, [entry], { cwd: root, encoding: "utf8", timeout: 10000,
                env: { ...process.env, NODE_OPTIONS: "" } });
            expect(output.error).toBeUndefined();
            expect(output.status, output.stderr || output.stdout).toBe(0);
            const result = JSON.parse(output.stdout.trim());
            expect(result).toMatchObject({ workspace: 9, cachedBefore: 8, cachedAfter: 8, assembled: 9 });
            const expected = [{ ok: true, protocolVersion: 9, pid: verifiedBrokerPid, startedAt: verifiedBrokerStartedAt,
                elevationGate: { state: "unreported" } }, { ok: false, error: "invalid-status-response", protocolVersion: null }];
            expect(result.before).toEqual(expected);
            expect(result.after).toEqual(expected);
            expect(result.requests).toEqual([9, 8, 9, 8].map(protocolVersion => ({ url: "/status", protocolVersion })));
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    const workspaceBuild = join("/repo", "scripts", "workspace-build.mjs");
    const tsc = join("/repo", "node_modules", "typescript", "bin", "tsc");
    const esbuild = join("/repo", "node_modules", "esbuild-wasm", "bin", "esbuild");
    const linuxStages = [
        [workspaceBuild, "build"],
        [tsc],
        [tsc, "-p", join("/repo", "tsconfig.real-tests.json")],
        [join("/repo", "device-lab-mcp", "scripts", "build.mjs"), "--outfile", "dist/device-lab-mcp/server.mjs"],
        [workspaceBuild, "assemble"],
    ];
    const windowsStages = [
        ...linuxStages.slice(0, -1),
        [esbuild, "scripts/real-tests/hyper-v-windows-setup-diagnostics-privileged.ts", "--bundle", "--platform=node", "--format=esm", "--target=node20", "--outfile=dist/real-tests/hyper-v-windows-setup-diagnostics-privileged.mjs"],
        [workspaceBuild, "assemble"],
    ];

    it("builds workspace dependencies before compiling and assembles the Linux runtime last", () => {
        const env = { NODE_OPTIONS: "--require=hidden-child-processes.cjs", TEST_ENV: "1" };
        const spawn = vi.fn((_command: string, _args: string[], _options: any) => ({ status: 0, stdout: "", stderr: "" }));
        const writeFile = vi.fn();
        const status = buildLevel3Artifacts("/repo", {
            platform: "linux",
            env,
            spawn,
            readFile: (path: string) => path.endsWith("package.json") ? '{"version":"1.2.3"}' : 'export const version = "__CLI_VERSION__";',
            writeFile,
        });
        expect(status).toBe(0);
        expect(spawn.mock.calls).toEqual(linuxStages.map(args => [
            process.execPath, args, { cwd: "/repo", env, encoding: "utf-8", windowsHide: true },
        ]));
        expect(writeFile).toHaveBeenCalledWith(join("/repo", "dist", "utils.js"), 'export const version = "1.2.3";');
    });

    it.each([
        ["workspace package build", "linux", 0],
        ["root compilation", "linux", 1],
        ["real-test typecheck", "linux", 2],
        ["MCP bundle", "linux", 3],
        ["Linux runtime assembly", "linux", 4],
        ["Windows privileged bundle", "win32", 4],
        ["Windows runtime assembly", "win32", 5],
    ] as const)("stops after failed %s and preserves its exit status", (_stage, platform, failedIndex) => {
        let calls = 0;
        const spawn = vi.fn((_command: string, _args: string[], _options: any) => ({
            status: calls++ === failedIndex ? 7 : 0,
            stdout: "",
            stderr: "stage failed\n",
        }));
        const writeError = vi.fn();
        const status = buildLevel3Artifacts("/repo", {
            platform,
            spawn,
            writeError,
            readFile: () => '{"version":"1.0.0"}',
            writeFile: () => undefined,
        });
        const stages = platform === "win32" ? windowsStages : linuxStages;
        expect(status).toBe(7);
        expect(spawn.mock.calls.map(call => call[1])).toEqual(stages.slice(0, failedIndex + 1));
        expect(writeError).toHaveBeenCalledOnce();
        expect(writeError).toHaveBeenCalledWith("stage failed\n");
    });

    it.each([
        ["workspace package build", 0, "CCC workspace package build failed\n"],
        ["runtime assembly", 4, "CCC embedded runtime assembly failed\n"],
    ] as const)("fails closed when %s has no exit status", (_stage, failedIndex, fallback) => {
        let calls = 0;
        const spawn = vi.fn((_command: string, _args: string[], _options: any) => ({ status: calls++ === failedIndex ? null : 0, stdout: "", stderr: "" }));
        const writeError = vi.fn();
        const status = buildLevel3Artifacts("/repo", {
            platform: "linux",
            spawn,
            writeError,
            readFile: () => '{"version":"1.0.0"}',
            writeFile: () => undefined,
        });
        expect(status).toBe(1);
        expect(spawn).toHaveBeenCalledTimes(failedIndex + 1);
        expect(writeError).toHaveBeenCalledWith(fallback);
    });
});

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

    it("loads split TypeScript host-control modules in the standalone real-test runner", { timeout: 60000 }, () => {
        const tempDir = mkdtempSync(join(tmpdir(), "ccc-hyper-v-source-loader-"));
        writeFileSync(join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
        const fixture = join(tempDir, "level2-hyper-v-linux-vm.ts");
        const hostControlUrl = pathToFileURL(join(repoRoot, "packages", "device-lab", "src", "host-control", "hyper-v", "index.ts")).href;
        writeFileSync(fixture, [
            `import { HYPER_V_NETWORK_PREFIX } from ${JSON.stringify(hostControlUrl)};`,
            "export const name = 'host-control source loader';",
            "export async function run() {",
            "  return HYPER_V_NETWORK_PREFIX",
            "    ? { status: 'PASS' }",
            "    : { status: 'FAIL', reason: 'missing Hyper-V contract' };",
            "}",
        ].join("\n"));
        try {
            const sourceLoader = pathToFileURL(join(repoRoot, "scripts", "real-tests", "typescript-source-loader.mjs")).href;
            const result = spawnSync(process.execPath, [
                "--import",
                sourceLoader,
                join(repoRoot, "scripts", "real-tests", "run.ts"),
                "--compact",
                fixture,
            ], {
                cwd: tempDir,
                encoding: "utf8",
                timeout: 60_000,
            });
            expect(result.status, result.stderr || result.stdout).toBe(0);
            expect(result.stdout).toContain("SUMMARY real-tests total=1 pass=1 skip=0 fail=0");
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
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

    it("runs the default Linux Level 3 provider without a separate GUI flag", async () => {
        let forwarded: NodeJS.ProcessEnv | undefined;
        const status = await runHyperVLevel3(["--target", "linux"], {
            env: {},
            withExclusiveRealProviderRunImpl: async (_name: string, run: () => Promise<number>) => run(),
            warnSetupDiagnosticsPrivilegeImpl: () => false,
            buildLevel3ArtifactsImpl: () => 0,
            ensureWindowsEvaluationLicenseImpl: async () => ({ ok: true }),
            ensureHostBrokerReadyImpl: async () => 0,
            runSupervisedProcessImpl: async (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
                forwarded = options.env;
                return { status: 0 };
            },
        });
        expect(status).toBe(0);
        expect(forwarded).toEqual({});
    });

    it("builds artifacts and prepares the broker before running the selected provider", async () => {
        const calls: string[] = [];
        let runnerArgs: string[] = [];
        const warnSetupDiagnosticsPrivilegeImpl = vi.fn(() => false);
        const status = await runHyperVTests("windows", {
            ensureWindowsEvaluationLicenseImpl: async () => ({ ok: true }),
            // This caller goes through the SEAM and asserts it below; the two further down use
            // `platform: "linux"`, which is read by exactly one collaborator —
            // warnIfSetupDiagnosticsWillLackPrivilege; the license gate takes its own `licenseDeps`
            // bag. Either way, without one of them all three reach the production elevation probe
            // on a Windows dev host: a real powershell.exe spawn with a 10s timeout, and a write to
            // real stderr, from a unit test. The seam was added for exactly this and these callers
            // were left behind.
            //
            // At least one of the three has to use the seam rather than the platform guard, or
            // nothing defends the fix: deleting all three platform keys leaves this file green on
            // Linux, and the regression shows only on a Windows host — which is how it survived the
            // first time.
            warnSetupDiagnosticsPrivilegeImpl,
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
                runnerArgs = args;
                calls.push(`run:${basename(args.at(-1) || "")}`);
                return { status: 0 };
            },
        });
        expect(status).toBe(0);
        // objectContaining, not expect.anything(): `anything()` matches `{}`, so passing an empty
        // bag instead of `dependencies` survived — and that is not cosmetic. The two callers below
        // rely on `platform: "linux"` reaching the warn function; drop the pass-through and they
        // silently re-reach the production probe on a Windows host, which is the exact regression
        // this key was added to fix.
        expect(warnSetupDiagnosticsPrivilegeImpl, "drop this key and the production probe spawns a real powershell.exe on Windows").toHaveBeenCalledWith("windows", expect.objectContaining({ env: { TEST_ENV: "1" } }));
        expect(calls).toEqual(["build", "broker", "run:level2-hyper-v-windows-vm.ts"]);
        expect(runnerArgs.slice(0, 3)).toEqual([
            "--import",
            pathToFileURL(join(repoRoot, "scripts", "real-tests", "typescript-source-loader.mjs")).href,
            join(repoRoot, "scripts", "real-tests", "run.ts"),
        ]);
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
            ensureWindowsEvaluationLicenseImpl: async () => ({ ok: true }),
            platform: "linux", // see above: keeps the production elevation probe out of a unit test
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
        const spawn = vi.fn(() => ({
            status: 0,
            stdout: brokerStatusOutput(),
            stderr: "",
        }));
        const probe = vi.fn(async () => ({
            ok: true,
            protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
            pid: verifiedBrokerPid,
            startedAt: verifiedBrokerStartedAt,
        }));
        const status = await ensureHostBrokerReady("/repo", {
            spawn,
            probeHostBrokerProtocolImpl: probe,
        });

        expect(status).toBe(0);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it("prints the attested broker's elevation gate state", async () => {
        let output = "";
        const originalWrite = process.stdout.write;
        process.stdout.write = ((chunk: any) => {
            output += String(chunk);
            return true;
        }) as typeof process.stdout.write;
        try {
            for (const elevationGate of [{ state: "never-asked" }, undefined]) {
                const status = await ensureHostBrokerReady("/repo", {
                    spawn: () => ({ status: 0, stdout: brokerStatusOutput(), stderr: "" }),
                    probeHostBrokerProtocolImpl: async () => ({
                        ok: true,
                        protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
                        pid: verifiedBrokerPid,
                        startedAt: verifiedBrokerStartedAt,
                        ...(elevationGate ? { elevationGate } : {}),
                    }),
                });
                expect(status).toBe(0);
            }
        } finally {
            process.stdout.write = originalWrite;
        }

        expect(output).toContain("ATTEST Hyper-V elevation gate state=never-asked\n");
        expect(output).toContain("ATTEST Hyper-V elevation gate state=unreported\n");
    });

    it("stops before any Hyper-V step when the broker's elevation gate has refused", async () => {
        let diagnostic = "";
        let output = "";
        const originalStderrWrite = process.stderr.write;
        const originalStdoutWrite = process.stdout.write;
        process.stderr.write = ((chunk: any) => {
            diagnostic += String(chunk);
            return true;
        }) as typeof process.stderr.write;
        process.stdout.write = ((chunk: any) => {
            output += String(chunk);
            return true;
        }) as typeof process.stdout.write;
        const spawn = vi.fn(() => ({ status: 0, stdout: brokerStatusOutput(), stderr: "" }));
        let probeCalls = 0;
        try {
            const status = await ensureHostBrokerReady("/repo", {
                spawn,
                probeHostBrokerProtocolImpl: async () => {
                    probeCalls += 1;
                    return {
                        ok: true,
                        protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
                        pid: verifiedBrokerPid,
                        startedAt: verifiedBrokerStartedAt,
                        // Only the confirmation read has seen the refusal: the later read decides.
                        elevationGate: probeCalls === 1
                            ? { state: "never-asked" }
                            : { state: "refused", code: "hyper-v-network-elevation-cancelled", at: "2026-09-27T09:16:02.123Z" },
                    };
                },
            });

            expect(status).toBe(1);
        } finally {
            process.stderr.write = originalStderrWrite;
            process.stdout.write = originalStdoutWrite;
        }

        // No repair and no retry: restarting the broker is the operator's call, since a fresh
        // broker may prompt again.
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(probeCalls).toBe(2);
        expect(diagnostic).toContain(`elevation gate refused; pid=${verifiedBrokerPid}; code=hyper-v-network-elevation-cancelled; at=2026-09-27T09:16:02.123Z`);
        expect(diagnostic).toContain("Run not started, including any non-Hyper-V Level 3 steps");
        expect(diagnostic).toContain("hyper-v-network-elevation-suppressed");
        expect(diagnostic).toContain(`restart the broker to clear the refusal. Stop process ${verifiedBrokerPid}`);
        expect(diagnostic).toContain("'ccc devices setup hyper-v --confirm'");
        expect(output).not.toContain("ATTEST Hyper-V elevation gate");
    });

    it.each([
        ["port: 17373\nruntimePresent: true\n", "brokerReady: false\nbrokerRepairError: host-broker-incompatible\n"],
        ["port: 17373\n", ""],
        ["", "brokerReady: false\n"],
        ["", ""],
    ])("preserves both broker failure streams and distinguishes a normal exit from a spawn error (%#)", async (stdout, stderr) => {
        let diagnostic = "";
        const spawn = vi.fn(() => ({ status: 1, signal: null, stdout, stderr }));
        const probe = vi.fn();

        expect(await ensureHostBrokerReady("/repo", {
            spawn,
            probeHostBrokerProtocolImpl: probe,
            writeError: (message: string) => { diagnostic += message; },
        })).toBe(1);

        for (const output of [stdout, stderr].filter(Boolean)) {
            expect(diagnostic).toContain(`${output.trimEnd()}\n`);
        }
        expect(diagnostic).toContain("status=1; signal=none; error=none; timeoutMs=180000");
        expect(diagnostic).not.toContain("no-output");
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(probe).not.toHaveBeenCalled();
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
        const observedProbeTimeouts: number[] = [];
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
                probeHostBrokerProtocolImpl: async (_port: number, options: { timeoutMs?: number }) => {
                    observedProbeTimeouts.push(Number(options.timeoutMs));
                    return {
                        ok: true,
                        protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
                        pid: verifiedBrokerPid,
                        startedAt: verifiedBrokerStartedAt,
                    };
                },
            });

            expect(status).toBe(0);
            expect(observedStatusTimeouts).toEqual([100]);
            expect(observedProbeTimeouts).toEqual([60, 40]);
        } finally {
            now.mockRestore();
        }
    });

    it.each([0, DEVICE_BROKER_PROTOCOL_VERSION + 1])("rejects incompatible protocol %s before provider work", async (protocolVersion) => {
        const diagnostic = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
            expect(await ensureHostBrokerReady("/repo", {
                spawn: () => ({status: 0, stdout: brokerStatusOutput(protocolVersion)}),
            })).toBe(1);
            expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("protocol mismatch"));
        } finally { diagnostic.mockRestore(); }
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
                probeHostBrokerProtocolImpl: async () => ({
                    ok: true,
                    protocolVersion: 0,
                    pid: verifiedBrokerPid,
                    startedAt: verifiedBrokerStartedAt,
                }),
            });

            expect(status).toBe(1);
            expect(diagnostic).toContain("remote protocol attestation failed");
        } finally {
            process.stderr.write = originalWrite;
        }
    });

    it("reads capabilities directly from the running loopback broker", async () => {
        const protocolVersion = DEVICE_BROKER_PROTOCOL_VERSION;
        const observed = await probeHostBrokerProtocol(17373, {
            fetchImpl: async (url: string) => {
                expect(url).toBe("http://127.0.0.1:17373/status");
                return new Response(JSON.stringify({
                    ok: true,
                    broker: {
                        protocolVersion,
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
            protocolVersion,
            pid: verifiedBrokerPid,
            startedAt: verifiedBrokerStartedAt,
            elevationGate: { state: "unreported" },
        });
    });

    it("reads the elevation gate from the running broker and echoes only bounded values", async () => {
        const observe = (hyperVElevationGate: unknown) => probeHostBrokerProtocol(17373, {
            fetchImpl: async () => new Response(JSON.stringify({
                ok: true,
                broker: {
                    protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
                    process: { pid: verifiedBrokerPid },
                    startedAt: verifiedBrokerStartedAt,
                    hyperVElevationGate,
                },
            }), { status: 200 }),
        });

        expect((await observe({ state: "never-asked" })).elevationGate).toEqual({ state: "never-asked" });
        expect((await observe({
            state: "refused",
            code: "hyper-v-network-elevation-cancelled",
            at: "2026-09-27T09:16:02.123Z",
        })).elevationGate).toEqual({
            state: "refused",
            code: "hyper-v-network-elevation-cancelled",
            at: "2026-09-27T09:16:02.123Z",
        });
        // Still refused — the state is what stops the run — but no host text reaches the log.
        expect((await observe({
            state: "refused",
            code: "C:\\Users\\secret\\hyper-v.json",
            at: "yesterday; rm -rf",
        })).elevationGate).toEqual({ state: "refused", code: "invalid", at: "invalid" });
        expect((await observe({ state: "leased", code: "hyper-v-network-elevation-cancelled" })).elevationGate)
            .toEqual({ state: "unrecognized" });
        expect((await observe(null)).elevationGate).toEqual({ state: "unrecognized" });
    });

    it("rejects an oversized direct broker status response before reading it", async () => {
        let bodyRead = false;
        const observed = await probeHostBrokerProtocol(17373, {
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

        expect(observed).toEqual({ ok: false, error: "response-too-large", protocolVersion: null });
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
        const observed = await probeHostBrokerProtocol(17373, {
            fetchImpl: async () => new Response(body, { status: 200 }),
        });

        expect(observed).toEqual({ ok: false, error: "response-too-large", protocolVersion: null });
        expect(cancelled).toBe(true);
    });

    it("re-attests a broker that is replaced between observation and confirmation", async () => {
        const successorPid = verifiedBrokerPid + 1;
        const successorStartedAt = "2026-07-28T00:00:01.000Z";
        const successorStatus = brokerStatusOutput()
            .replace(`brokerVerifiedPid: ${verifiedBrokerPid}`, `brokerVerifiedPid: ${successorPid}`)
            .replace(`brokerVerifiedStartedAt: ${verifiedBrokerStartedAt}`, `brokerVerifiedStartedAt: ${successorStartedAt}`);
        let statusCalls = 0;
        let probeCalls = 0;
        const status = await ensureHostBrokerReady("/repo", {
            spawn: () => {
                statusCalls += 1;
                return {
                    status: 0,
                    stdout: statusCalls === 1 ? brokerStatusOutput() : successorStatus,
                    stderr: "",
                };
            },
            probeHostBrokerProtocolImpl: async () => {
                probeCalls += 1;
                return {
                    ok: true,
                    protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
                    pid: probeCalls === 1 ? verifiedBrokerPid : successorPid,
                    startedAt: probeCalls === 1 ? verifiedBrokerStartedAt : successorStartedAt,
                };
            },
        });

        expect(status).toBe(0);
        expect(statusCalls).toBe(2);
        expect(probeCalls).toBe(4);
    });

    it("rejects persistent broker process identity churn after three complete attempts", async () => {
        let statusCalls = 0;
        let probeCalls = 0;
        const status = await ensureHostBrokerReady("/repo", {
            spawn: () => {
                statusCalls += 1;
                return {
                    status: 0,
                    stdout: brokerStatusOutput(),
                    stderr: "",
                };
            },
            probeHostBrokerProtocolImpl: async () => {
                probeCalls += 1;
                return {
                    ok: true,
                    protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION,
                    pid: probeCalls % 2 === 1 ? verifiedBrokerPid : verifiedBrokerPid + 1,
                    startedAt: verifiedBrokerStartedAt,
                };
            },
        });

        expect(status).toBe(1);
        expect(statusCalls).toBe(3);
        expect(probeCalls).toBe(6);
    });

    it("rejects missing capabilities from the read-only confirmation without another repair command", async () => {
        let probeCalls = 0;
        const spawn = vi.fn(() => ({ status: 0, stdout: brokerStatusOutput(), stderr: "" }));
        const status = await ensureHostBrokerReady("/repo", {
            spawn,
            probeHostBrokerProtocolImpl: async () => {
                probeCalls += 1;
                return {
                    ok: true,
                    protocolVersion: probeCalls === 1 ? DEVICE_BROKER_PROTOCOL_VERSION : 0,
                    pid: verifiedBrokerPid,
                    startedAt: verifiedBrokerStartedAt,
                };
            },
        });

        expect(status).toBe(1);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(probeCalls).toBe(2);
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

describe("Windows Server evaluation license prompt", () => {
    const baseDeps = (overrides: any = {}) => ({
        platform: "win32",
        selectHyperVWindowsProfileImpl: () => "windows-server",
        readReceiptImpl: () => null,
        acceptLicenseImpl: vi.fn(),
        stdout: { write: vi.fn() },
        isInteractive: true,
        promptYesNoImpl: async () => true,
        ...overrides,
    });

    it("is a no-op off Windows without prompting or accepting", async () => {
        const deps = baseDeps({ platform: "linux", promptYesNoImpl: vi.fn(async () => true) });
        const result = await ensureWindowsServerEvaluationLicense("windows", deps);
        expect(result).toEqual({ ok: true, reason: "non-windows-host" });
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
        expect(deps.promptYesNoImpl).not.toHaveBeenCalled();
    });

    it("is a no-op for a linux-only target on Windows", async () => {
        const deps = baseDeps();
        expect(await ensureWindowsServerEvaluationLicense("linux", deps)).toEqual({ ok: true, reason: "linux-target" });
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
    });

    it("is a no-op when the selected profile is not windows-server", async () => {
        const deps = baseDeps({ selectHyperVWindowsProfileImpl: () => "windows-11" });
        expect(await ensureWindowsServerEvaluationLicense("windows", deps)).toEqual({ ok: true, reason: "not-windows-server-profile" });
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
    });

    it("is a no-op when the evaluation receipt already exists (no prompt)", async () => {
        const deps = baseDeps({ readReceiptImpl: () => ({ version: 2 }), promptYesNoImpl: vi.fn(async () => true) });
        expect(await ensureWindowsServerEvaluationLicense("all", deps)).toEqual({ ok: true, reason: "already-accepted" });
        expect(deps.promptYesNoImpl).not.toHaveBeenCalled();
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
    });

    it("does not hang when acceptance is missing on a non-interactive run", async () => {
        const deps = baseDeps({ isInteractive: false, promptYesNoImpl: vi.fn(async () => true) });
        const result = await ensureWindowsServerEvaluationLicense("windows", deps);
        expect(result).toEqual({ ok: false, reason: "license-required-non-interactive" });
        expect(deps.promptYesNoImpl).not.toHaveBeenCalled();
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
    });

    it("records acceptance once when the user answers yes interactively", async () => {
        const deps = baseDeps({ promptYesNoImpl: async () => true });
        const result = await ensureWindowsServerEvaluationLicense("windows", deps);
        expect(result).toEqual({ ok: true, reason: "accepted-now" });
        expect(deps.acceptLicenseImpl).toHaveBeenCalledTimes(1);
    });

    it("declines without recording acceptance when the user answers no", async () => {
        const deps = baseDeps({ promptYesNoImpl: async () => false });
        const result = await ensureWindowsServerEvaluationLicense("windows", deps);
        expect(result).toEqual({ ok: false, reason: "license-declined" });
        expect(deps.acceptLicenseImpl).not.toHaveBeenCalled();
    });

    it("stops runHyperVTests before the provider run when the license gate is not ok", async () => {
        const runSupervisedProcessImpl = vi.fn(async () => ({ status: 0 }));
        const status = await runHyperVTests("windows", {
            platform: "linux", // see above: keeps the production elevation probe out of a unit test
            buildLevel3ArtifactsImpl: () => 0,
            ensureWindowsEvaluationLicenseImpl: async () => ({ ok: false, reason: "license-declined" }),
            ensureHostBrokerReadyImpl: async () => 0,
            runSupervisedProcessImpl,
        });
        expect(status).toBe(1);
        expect(runSupervisedProcessImpl).not.toHaveBeenCalled();
    });
    // The warning exists because a real host only revealed the missing privilege after two minutes
    // of booting a VM, and then reported it as an unreadable host-locale blob. Warning before the
    // wait is the whole point, so the placement matters as much as the text.
    it("warns before the run when Windows Setup diagnostics will lack the privilege they need", () => {
        const lines: string[] = [];
        // The resolver's return value is asserted to reach the probe. resolveTrustedWindowsPowerShell
        // exists to stop a bare PATH lookup for powershell.exe; replacing the call-site argument
        // with the literal "powershell.exe" — reintroducing exactly that — left the whole suite
        // green. Both impls were injected and nothing checked the wiring between them, so the
        // hardening could be deleted in a cleanup with no test objecting.
        const trustedPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
        const isAdministratorImpl = vi.fn(() => false);
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("windows", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => trustedPowerShell,
            isAdministratorImpl,
            env: {},
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(true);
        expect(isAdministratorImpl, "the probe must get the resolved trusted path, not a PATH lookup").toHaveBeenCalledWith({ powerShellPath: trustedPowerShell });
        const output = lines.join("");
        expect(output, "must name the code the operator will actually see").toContain("hyper-v-setup-diagnostics-mount-privilege-required");
        expect(output).toContain("Automatic UAC is disabled");
        expect(output).toContain("will not open an Administrator prompt");
        expect(output).toContain("CCC_HYPER_V_SETUP_DIAGNOSTICS_ELEVATE=1");
        expect(output).not.toContain("approve elevation");
        expect(output, "must not imply the VM lifecycle is broken").toContain("lifecycle itself is unaffected");
    });

    it("describes the bounded UAC request only when diagnostic elevation is explicitly enabled", () => {
        const lines: string[] = [];
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("windows", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            isAdministratorImpl: () => false,
            env: { CCC_HYPER_V_SETUP_DIAGNOSTICS_ELEVATE: "1" },
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(true);
        const output = lines.join("");
        expect(output).toContain("approve elevation");
        for (const scope of ["force-stop", "detach", "read-only", "re-attach"]) expect(output).toContain(scope);
        expect(output).toContain("expires after ten minutes");
    });

    // The other half of the same mutation, and the half the call-site assertion above does NOT
    // close. Every one of the five warn tests injects both impls, so neither production default is
    // ever executed by this suite: replacing only the default binding with
    // `|| (() => "powershell.exe")` left 40/40 green, and tsc said nothing because the orphaned
    // import is not flagged.
    //
    // The first attempt pinned the source TEXT of that expression. It closed the mutation it named
    // and missed the same deletion one line up — repoint the import at a weakened module, leave the
    // expression byte-identical, and the hardening is gone with the suite green. Third time that
    // deletion moved rather than closed. Comparing the exported defaults against the module's own
    // exports pins the BINDING, catches the import swap, and stops failing on a line wrap; it also
    // executes neither, which is the point, since executing them on Windows spawns the
    // powershell.exe this change exists to keep out of unit tests.
    it("keeps the trusted resolver and the real probe as the production defaults", async () => {
        const elevation: any = await import("./hyper-v-windows-library-elevation.mjs");
        expect(PRIVILEGE_PROBE_DEFAULTS.resolveTrustedWindowsPowerShell).toBe(elevation.resolveTrustedWindowsPowerShell);
        expect(PRIVILEGE_PROBE_DEFAULTS.isAdministrator).toBe(elevation.isAdministrator);
    });

    it("stays silent when the run is already elevated", () => {
        const lines: string[] = [];
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("windows", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => "C:\\Windows\\System32\\powershell.exe",
            isAdministratorImpl: () => true,
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(false);
        expect(lines).toEqual([]);
    });

    // Off Windows there is no privilege to lack, and probing would spawn a PowerShell that is not
    // there. This is also what keeps the linux suite from printing a Windows warning.
    it("does not probe for elevation off Windows", () => {
        const lines: string[] = [];
        const isAdministratorImpl = vi.fn(() => false);
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("windows", {
            platform: "linux",
            isAdministratorImpl,
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(false);
        expect(isAdministratorImpl).not.toHaveBeenCalled();
        expect(lines).toEqual([]);
    });

    // A probe that throws must not be reported as "not elevated" — that would tell an operator to
    // re-run elevated when they may already be. Say only what is known.
    it("reports an undetermined probe as undetermined, not as unelevated", () => {
        const lines: string[] = [];
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("windows", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => { throw new Error("hyper-v-library-elevation-system-root-invalid"); },
            env: {},
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(false);
        expect(lines.join(""))
            .toContain("Could not determine whether this run is elevated");
        expect(lines.join(""))
            .toContain("will not open an Administrator prompt");
        expect(lines.join(""))
            .not.toContain("may ask you to approve elevation");
    });
    // D3: the diagnostic is Windows-only. captureHyperVWindowsSetupDiagnostics is reached solely
    // through level2-hyper-v-windows-vm.ts, so a linux target never captures it — warning there
    // would send the operator to redo a run for something that target does not collect.
    it("does not warn about Windows Setup diagnostics for a linux target", () => {
        const lines: string[] = [];
        const isAdministratorImpl = vi.fn(() => false);
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("linux", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => "C:\\Windows\\System32\\powershell.exe",
            isAdministratorImpl,
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(false);
        expect(isAdministratorImpl, "must not even probe for a target that never mounts").not.toHaveBeenCalled();
        expect(lines).toEqual([]);
    });

    // The inclusion the exclusion above is carved out of, and the one that was untested: `all` is
    // what runHyperVLevel3 defaults to, so `npm run test:level3:hyper-v` with no --target lands
    // here. Narrowing the guard to `target !== "windows"` left the whole suite green, which means
    // the most-used invocation silently lost its warning and nothing said so.
    it("warns for the default all target, which includes the Windows provider", () => {
        const lines: string[] = [];
        const isAdministratorImpl = vi.fn(() => false);
        const warned = warnIfSetupDiagnosticsWillLackPrivilege("all", {
            platform: "win32",
            resolveTrustedWindowsPowerShellImpl: () => "C:\\Windows\\System32\\powershell.exe",
            isAdministratorImpl,
            writeImpl: (line: string) => { lines.push(line); },
        });
        expect(warned).toBe(true);
        expect(isAdministratorImpl).toHaveBeenCalledOnce();
        expect(lines.join("")).toContain("hyper-v-setup-diagnostics-mount-privilege-required");
    });

    // D2: every other collaborator in runHyperVTests is injectable. Before this was, three existing
    // tests reached the production probe and spawned a real powershell.exe on a Windows dev host —
    // a unit test making a 10s process call, three times, and writing to real stderr.
    it("takes the elevation probe as an injectable dependency, and warns before paying for a build", async () => {
        const calls: string[] = [];
        const warnSetupDiagnosticsPrivilegeImpl = vi.fn((target: string) => {
            calls.push(`warn:${target}`);
            return true;
        });
        await runHyperVTests("windows", {
            warnSetupDiagnosticsPrivilegeImpl,
            buildLevel3ArtifactsImpl: () => {
                calls.push("build");
                return 0;
            },
            ensureWindowsEvaluationLicenseImpl: async () => {
                calls.push("license");
                return { ok: true };
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
        expect(warnSetupDiagnosticsPrivilegeImpl).toHaveBeenCalledOnce();
        // Order is the assertion. The NOTE asks for a re-run, and a re-run costs another build, so
        // warning after the build makes the operator pay for it twice.
        expect(calls).toEqual(["warn:windows", "build", "license", "broker", "run"]);
    });
});
