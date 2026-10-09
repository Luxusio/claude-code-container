import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseVerificationArgs, runOwnedShippingProgram, runVerificationSelection, verifyCurrentDeclarationContracts } from "../../scripts/test-workspace-packages.mjs";

const payloadRoot = resolve("assembled payload");
const preflightArgs = ["--preflight", "--payload-root", payloadRoot];
const partialReport = {
    mode: "preflight", partial: true, complete: false,
    gates: ["current-declarations", "image-preparation"], payloadRoot,
};

function operations() {
    const trace: string[] = [];
    return {
        trace,
        validate: vi.fn(async (_root: string) => { trace.push("validate"); }),
        prepare: vi.fn(async () => { trace.push("prepare"); }),
        declarations: vi.fn(async (_root: string) => { trace.push("declarations"); }),
        imagePreparation: vi.fn(async (_root: string) => { trace.push("imagePreparation"); }),
        full: vi.fn(async () => { trace.push("full"); }),
        report: vi.fn((_report: unknown) => { trace.push("report"); }),
    };
}

describe("workspace package verification selection", () => {
    it("keeps no-argument invocation in complete full mode", async () => {
        const ops = operations();
        expect(parseVerificationArgs([])).toEqual({ mode: "full" });
        await expect(runVerificationSelection(parseVerificationArgs([]), ops))
            .resolves.toEqual({ mode: "full", partial: false, complete: true });
        expect(ops.trace).toEqual(["prepare", "full"]);
        expect(ops.report).not.toHaveBeenCalled();
        expect(ops.validate).not.toHaveBeenCalled();
        expect(ops.declarations).not.toHaveBeenCalled();
        expect(ops.imagePreparation).not.toHaveBeenCalled();
    });

    it("accepts exactly the fixed preflight API, including spaces in a canonical path", () => {
        expect(parseVerificationArgs(preflightArgs)).toEqual({ mode: "preflight", payloadRoot });
    });

    it.each([
        ["--unknown"], ["--preflight"], ["--payload-root", payloadRoot],
        ["--preflight", "--payload-root"], ["--preflight", "--payload-root", ""],
        ["--preflight", "--payload-root", "relative/payload"],
        ["--preflight", "--payload-root", `${payloadRoot}/../payload`],
        ["--preflight", "--payload-root", `${payloadRoot}/.`],
        ["--preflight", "--payload-root", `${payloadRoot}/`],
        ["--preflight", "--payload-root", `${payloadRoot}//child`],
        ["--payload-root", payloadRoot, "--preflight"],
        ["--preflight", "--preflight", "--payload-root", payloadRoot],
        ["--preflight", "--payload-root", payloadRoot, "--payload-root", payloadRoot],
        ["--preflight", "--payload-root", payloadRoot, "extra"],
    ])("rejects invalid arguments %j before any operation", async (...args: string[]) => {
        const ops = operations();
        await expect((async () => runVerificationSelection(parseVerificationArgs(args), ops))())
            .rejects.toThrow();
        expect(ops.trace).toEqual([]);
        for (const name of ["validate", "prepare", "declarations", "imagePreparation", "full", "report"] as const) {
            expect(ops[name]).not.toHaveBeenCalled();
        }
    });

    it("validates before scratch preparation and completes declarations before the image gate", async () => {
        const ops = operations();
        let releaseDeclarations!: () => void;
        let signalDeclarations!: () => void;
        const pendingDeclarations = new Promise<void>(resolveDone => { releaseDeclarations = resolveDone; });
        const enteredDeclarations = new Promise<void>(resolveDone => { signalDeclarations = resolveDone; });
        ops.declarations.mockImplementation(async () => {
            ops.trace.push("declarations");
            signalDeclarations();
            await pendingDeclarations;
        });
        const run = runVerificationSelection(parseVerificationArgs(preflightArgs), ops);
        await enteredDeclarations;
        expect(ops.trace).toEqual(["validate", "prepare", "declarations"]);
        expect(ops.imagePreparation).not.toHaveBeenCalled();
        expect(ops.report).not.toHaveBeenCalled();
        releaseDeclarations();
        await expect(run).resolves.toEqual(partialReport);
        expect(ops.trace).toEqual(["validate", "prepare", "declarations", "imagePreparation", "report"]);
        expect(ops.validate).toHaveBeenCalledExactlyOnceWith(payloadRoot);
        expect(ops.declarations).toHaveBeenCalledExactlyOnceWith(payloadRoot);
        expect(ops.imagePreparation).toHaveBeenCalledExactlyOnceWith(payloadRoot);
        expect(ops.report).toHaveBeenCalledExactlyOnceWith(partialReport);
        // Full dispatch owns packing, materialization and the expensive consumers.
        expect(ops.full).not.toHaveBeenCalled();
    });

    it.each(["validate", "prepare", "declarations", "imagePreparation"] as const)(
        "%s failure preserves its error and vetoes subsequent gates and success reporting",
        async failedStage => {
            const ops = operations();
            const failure = new Error(`${failedStage} failed`);
            ops[failedStage].mockImplementation(async () => {
                ops.trace.push(failedStage);
                throw failure;
            });
            await expect(runVerificationSelection(parseVerificationArgs(preflightArgs), ops))
                .rejects.toBe(failure);
            const stages = ["validate", "prepare", "declarations", "imagePreparation"];
            expect(ops.trace).toEqual(stages.slice(0, stages.indexOf(failedStage) + 1));
            expect(ops.full).not.toHaveBeenCalled();
            expect(ops.report).not.toHaveBeenCalled();
        },
    );

    it("does not return complete success when full verification fails", async () => {
        const ops = operations();
        const failure = new Error("full payload verification failed");
        ops.full.mockRejectedValue(failure);
        await expect(runVerificationSelection(parseVerificationArgs([]), ops)).rejects.toBe(failure);
        expect(ops.report).not.toHaveBeenCalled();
    });
});

// These fixtures exercise the gate's filesystem ownership and evidence policy;
// the injected compiler supplies raw process results without compiling anything.
function declarationFixture(check: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), "ccc-declaration-retention-"));
    const birth = lstatSync(directory);
    const providers = join(directory, "dist/packages/device-lab/providers");
    const inputs = [
        ...["domain", "ports", "application"].flatMap(layer =>
            ["windows-sandbox-stop", "windows-sandbox-create"].map(name => `${layer}/lifecycle/${name}.mjs`)),
        "state/state-file.mjs", "adapters/state/state-file.mjs",
    ];
    for (const input of inputs) {
        const path = join(providers, input);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, "export const fixture = 1;\n", { flag: "wx", mode: 0o600 });
    }
    try {
        check(directory);
        const current = lstatSync(directory);
        expect([current.dev, current.ino, current.uid]).toEqual([birth.dev, birth.ino, birth.uid]);
        expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
        rmSync(directory, { recursive: true });
    } catch (error) {
        console.error(`Retained declaration test fixture: ${directory}`);
        throw error;
    }
}

const compiled = { status: 0, stdout: "", stderr: "", signal: null };
function evidenceDirectory(directory: string) {
    const entries = readdirSync(directory).filter(name => name.startsWith("reviewed-declaration-evidence-"));
    expect(entries).toHaveLength(1);
    return join(directory, entries[0]);
}

// These ownership checks require real POSIX UID and permission semantics.
// Argument parsing and dispatch coverage above runs on every platform.
describe.skipIf(typeof process.getuid !== "function")("current declaration evidence and owned cleanup with POSIX ownership and modes", () => {
    it.each([1, 2])("retains submitted inputs, sidecars and the raw failed result at compiler call %i", failedCall => {
        declarationFixture(directory => {
            const failure = { status: 23, signal: "SIGTERM", stdout: "compiler output marker", stderr: "compile failure marker" };
            const submitted: { args: string[]; inputs: { path: string; text: string }[] }[] = [];
            const compiler = vi.fn((_executable: string, args: string[], options: Record<string, unknown>) => {
                expect(_executable).toBe(process.execPath);
                expect(options).toMatchObject({ encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
                expect(args).toContain("--strict");
                expect(args.slice(args.indexOf("--skipLibCheck"), args.indexOf("--skipLibCheck") + 2)).toEqual(["--skipLibCheck", "false"]);
                const inputs = args.filter(path => /\.(mjs|mts)$/.test(path)).map(path => ({ path, text: readFileSync(path, "utf8") }));
                submitted.push({ args: [...args], inputs });
                if (submitted.length === 1) {
                    const output = args[args.indexOf("--outDir") + 1];
                    expect(lstatSync(output).mode & 0o777).toBe(0o700);
                    writeFileSync(join(output, "emitted.d.mts"), "export declare const fixture: 1;\n", { flag: "wx", mode: 0o600 });
                }
                return submitted.length === failedCall ? failure : compiled;
            });
            const report = vi.spyOn(console, "error").mockImplementation(() => {});
            try {
                expect(() => verifyCurrentDeclarationContracts(directory, compiler)).toThrow(/compile failure marker/);
                expect(compiler).toHaveBeenCalledTimes(failedCall);
                const evidence = evidenceDirectory(directory);
                expect(report.mock.calls.some(call => call.some(value => String(value).includes(evidence)))).toBe(true);
                expect(lstatSync(evidence).mode & 0o777).toBe(0o700);
                expect(readFileSync(join(directory, "reviewed-sandbox-declarations/emitted.d.mts"), "utf8")).toContain("fixture");
                expect(readdirSync(directory).filter(name => /^reviewed-wave-.*-consumer\.mts$/.test(name)).length).toBeGreaterThan(0);
                for (const [index, call] of submitted.entries()) {
                    const invocationPath = join(evidence, `invocation-${index + 1}.json`);
                    const invocation = JSON.parse(readFileSync(invocationPath, "utf8"));
                    expect(lstatSync(invocationPath).mode & 0o777).toBe(0o600);
                    expect(invocation.executable).toBe(process.execPath);
                    expect(invocation.args).toEqual(call.args);
                    expect(invocation.inputs.map((input: { path: string }) => input.path)).toEqual(call.inputs.map(input => input.path));
                    for (const input of invocation.inputs) {
                        expect(readFileSync(input.path, "utf8")).toBe(call.inputs.find(item => item.path === input.path)!.text);
                        expect(readFileSync(join(evidence, input.snapshot), "utf8")).toBe(call.inputs.find(item => item.path === input.path)!.text);
                    }
                }
                const resultPath = join(evidence, `result-${failedCall}.json`);
                expect(lstatSync(resultPath).mode & 0o777).toBe(0o600);
                expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual({ ...failure, error: null });
            } finally { report.mockRestore(); }
        });
    });

    it("refuses a preexisting output directory and preserves its contents before compiler dispatch", () => {
        declarationFixture(directory => {
            const output = join(directory, "reviewed-sandbox-declarations");
            mkdirSync(output, { mode: 0o700 });
            const sentinel = join(output, "existing.txt");
            writeFileSync(sentinel, "preexisting output");
            const birth = lstatSync(output);
            const compiler = vi.fn(() => compiled);
            expect(() => verifyCurrentDeclarationContracts(directory, compiler)).toThrow();
            expect(compiler).not.toHaveBeenCalled();
            expect(lstatSync(output).ino).toBe(birth.ino);
            expect(readFileSync(sentinel, "utf8")).toBe("preexisting output");
        });
    });

    it("records a raw spawn error before rethrowing the original error", () => {
        declarationFixture(directory => {
            const error = Object.assign(new Error("compiler unavailable"), { code: "ENOENT" });
            const compiler = vi.fn(() => ({ status: null, signal: null, stdout: "raw stdout", stderr: "raw stderr", error }));
            let caught: unknown;
            try { verifyCurrentDeclarationContracts(directory, compiler); } catch (failure) { caught = failure; }
            expect(caught).toBe(error);
            expect(compiler).toHaveBeenCalledTimes(1);
            const evidence = evidenceDirectory(directory);
            expect(JSON.parse(readFileSync(join(evidence, "result-1.json"), "utf8"))).toEqual({
                status: null, signal: null, stdout: "raw stdout", stderr: "raw stderr",
                error: { name: "Error", message: "compiler unavailable", code: "ENOENT" },
            });
            expect(readdirSync(directory).some(name => /^reviewed-wave-.*-consumer\.mts$/.test(name))).toBe(true);
        });
    });

    it("retains unknown output entries introduced after declaration emission", () => {
        declarationFixture(directory => {
            const output = join(directory, "reviewed-sandbox-declarations");
            const compiler = vi.fn((_executable: string, args: string[]) => {
                writeFileSync(join(output, args.includes("--outDir") ? "emitted.d.mts" : "unknown.txt"), "preserve output", { mode: 0o600 });
                return compiled;
            });
            expect(() => verifyCurrentDeclarationContracts(directory, compiler)).toThrow();
            expect(compiler).toHaveBeenCalledTimes(2);
            expect(readFileSync(join(output, "unknown.txt"), "utf8")).toBe("preserve output");
            expect(readFileSync(join(output, "emitted.d.mts"), "utf8")).toBe("preserve output");
            expect(evidenceDirectory(directory)).toBeTruthy();
            expect(readdirSync(directory).some(name => /^reviewed-wave-.*-consumer\.mts$/.test(name))).toBe(true);
        });
    });

    it("refuses substituted output without removing either the replacement or the allocated directory", () => {
        declarationFixture(directory => {
            const output = join(directory, "reviewed-sandbox-declarations");
            const moved = join(directory, "allocated-output");
            const foreign = join(directory, "foreign-output");
            mkdirSync(foreign, { mode: 0o700 });
            writeFileSync(join(foreign, "sentinel.txt"), "replacement must survive");
            let allocatedInode: number | undefined;
            const compiler = vi.fn((_executable: string, args: string[]) => {
                if (args.includes("--outDir")) {
                    allocatedInode = lstatSync(output).ino;
                    writeFileSync(join(output, "emitted.d.mts"), "allocated declaration");
                    renameSync(output, moved);
                    symlinkSync(foreign, output, "dir");
                }
                return compiled;
            });
            expect(() => verifyCurrentDeclarationContracts(directory, compiler)).toThrow();
            expect(lstatSync(output).isSymbolicLink()).toBe(true);
            expect(lstatSync(moved).ino).toBe(allocatedInode);
            expect(readFileSync(join(moved, "emitted.d.mts"), "utf8")).toBe("allocated declaration");
            expect(readFileSync(join(foreign, "sentinel.txt"), "utf8")).toBe("replacement must survive");
            expect(evidenceDirectory(directory)).toBeTruthy();
        });
    });

    it("cleans successful owned outputs, consumers and evidence while preserving unrelated files", () => {
        declarationFixture(directory => {
            writeFileSync(join(directory, "unrelated.txt"), "keep me");
            const priorEvidence = join(directory, "reviewed-declaration-evidence-prior");
            mkdirSync(priorEvidence, { mode: 0o700 });
            writeFileSync(join(priorEvidence, "result-1.json"), "previous evidence", { mode: 0o600 });
            const priorBirth = lstatSync(priorEvidence);
            const compiler = vi.fn((_executable: string, args: string[]) => {
                if (args.includes("--outDir")) {
                    const output = args[args.indexOf("--outDir") + 1];
                    mkdirSync(join(output, "domain"), { mode: 0o700 });
                    writeFileSync(join(output, "domain/emitted.d.mts"), "export declare const fixture: 1;\n", { mode: 0o600 });
                }
                return compiled;
            });
            expect(verifyCurrentDeclarationContracts(directory, compiler)).toMatchObject({ sourceAndEmitted: true, skipLibCheck: false });
            expect(compiler).toHaveBeenCalledTimes(2);
            expect(compiler.mock.calls[1][1]).toContain("--noEmit");
            expect(readdirSync(directory).sort()).toEqual(["dist", "reviewed-declaration-evidence-prior", "unrelated.txt"]);
            expect(readFileSync(join(directory, "unrelated.txt"), "utf8")).toBe("keep me");
            expect(lstatSync(priorEvidence).ino).toBe(priorBirth.ino);
            expect(readFileSync(join(priorEvidence, "result-1.json"), "utf8")).toBe("previous evidence");
        });
    });
});

function shippingProgramFixture(check: (directory: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), "ccc-owned-shipping-program-"));
    const birth = lstatSync(directory);
    try {
        check(directory);
        const current = lstatSync(directory);
        expect([current.dev, current.ino, current.uid]).toEqual([birth.dev, birth.ino, birth.uid]);
        expect(current.isDirectory() && !current.isSymbolicLink()).toBe(true);
        rmSync(directory, { recursive: true });
    } catch (error) {
        console.error(`Retained shipping program fixture: ${directory}`);
        throw error;
    }
}

function shippingProgramOptions(directory: string) {
    return {
        cwd: directory,
        env: { HOME: directory, USERPROFILE: directory, TMP: directory, TEMP: directory, PATH: "",
            ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
            SHIPPING_TEST_TOKEN: "private UTF-8 Ω 🦊 'quoted'" },
        encoding: "utf8" as const,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        shell: false,
        windowsHide: true,
    };
}

describe("actual owned shipping program stdin transport", () => {
    it("runs a module above the single-argument limit with exact UTF-8 and literal quotes in its private cwd/environment", () => {
        shippingProgramFixture(directory => {
            const literal = "'single' \"double\" `backtick` \\backslash ${literal} $(literal)\n日本語 Ω 🦊\n";
            const payload = literal.repeat(4096);
            const program = `import { createHash } from 'node:crypto';
const payload = ${JSON.stringify(payload)};
process.stdout.write(JSON.stringify({
    sha256: createHash('sha256').update(payload, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(payload, 'utf8'), first: payload.slice(0, ${literal.length}), last: payload.slice(-${literal.length}),
    cwd: process.cwd(), token: process.env.SHIPPING_TEST_TOKEN, argv: process.argv.slice(1), parentPid: process.ppid,
}));`;
            expect(Buffer.byteLength(program, "utf8")).toBeGreaterThan(128 * 1024);
            const options = shippingProgramOptions(directory);
            const result = runOwnedShippingProgram(program, options);
            expect(result.error).toBeUndefined(); expect(result.status, String(result.stderr)).toBe(0); expect(result.signal).toBeNull();
            expect(typeof result.stdout).toBe("string"); expect(result.stderr).toBe("");
            expect(JSON.parse(String(result.stdout))).toEqual({
                sha256: createHash("sha256").update(payload, "utf8").digest("hex"), bytes: Buffer.byteLength(payload, "utf8"),
                first: literal, last: literal, cwd: directory, token: options.env.SHIPPING_TEST_TOKEN, argv: [], parentPid: process.pid,
            });
            expect(options).not.toHaveProperty("input");
        });
    });

    it("returns actual nonzero exit, partial stdout and UTF-8 stderr without replacing the native result", () => {
        shippingProgramFixture(directory => {
            const program = "process.stdout.write('partial stdout Ω'); process.stderr.write('controlled failure 🦊'); process.exitCode = 19;";
            const result = runOwnedShippingProgram(program, shippingProgramOptions(directory));
            expect(result.error).toBeUndefined(); expect(result.status).toBe(19); expect(result.signal).toBeNull();
            expect(result.stdout).toBe("partial stdout Ω"); expect(result.stderr).toBe("controlled failure 🦊");
        });
    });

    it("preserves the caller timeout and raw spawn error/signal when its owned program remains active", () => {
        shippingProgramFixture(directory => {
            const options = { ...shippingProgramOptions(directory), timeout: 1000, killSignal: "SIGTERM" as const };
            const result = runOwnedShippingProgram("await new Promise(resolve => setTimeout(resolve, 10000));", options);
            expect(result.error).toMatchObject({ code: "ETIMEDOUT" }); expect(result.status).toBeNull(); expect(result.signal).toBe("SIGTERM");
            expect(options.timeout).toBe(1000);
        });
    });

    it("preserves the caller output bound and raw overflow error instead of accepting truncated output", () => {
        shippingProgramFixture(directory => {
            const result = runOwnedShippingProgram("process.stdout.write('x'.repeat(65536)); await new Promise(resolve => setTimeout(resolve, 10000));", { ...shippingProgramOptions(directory), maxBuffer: 512 });
            expect(result.error).toMatchObject({ code: "ENOBUFS" }); expect(result.status).toBeNull();
            expect(result.signal).toBe("SIGTERM");
        });
    });

    it("refuses shell transport before evaluating a supplied program", () => {
        shippingProgramFixture(directory => {
            expect(() => runOwnedShippingProgram("process.stdout.write('must not execute');", { ...shippingProgramOptions(directory), shell: true }))
                .toThrow("shipping program transport does not use a shell");
        });
    });
});
