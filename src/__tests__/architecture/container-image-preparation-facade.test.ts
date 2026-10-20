import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeContainerImagePreparation, distributionImageBuildCommand, distributionImageBuildHint } from "../../composition/container-image-preparation.js";
import { ensureImage, getImageLabel, isImageExists, prepareProjectContainerStartup, pullImage, qualifyImageRefForRuntime, tagImage } from "../../docker.js";
import { CLI_VERSION, DOCKER_REGISTRY_IMAGE, IMAGE_NAME } from "../../utils.js";
import * as runtimeFacade from "../../container-runtime.js";
import { normalizeNativeRuntimeCall, preloadNativeRuntimeFixture } from "../helpers/native-runtime-fixture.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), runtime: vi.fn(), bind: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("../../container-runtime.js", async original => ({
    ...await original<typeof import("../../container-runtime.js")>(), runtimeCli: native.runtime,
}));
// Delegate ordinary dispatch to the real binder; failures can be injected at
// the authority boundary without inventing runtimeCli calls before native leaves.
vi.mock("../../adapters/container-runtime-invocation.js", async original => ({
    ...await original<typeof import("../../adapters/container-runtime-invocation.js")>(),
    bindNativeRuntimeInvocation: (...args: Parameters<typeof import("../../adapters/container-runtime-invocation.js").bindNativeRuntimeInvocation>) => native.bind(...args),
}));
vi.mock("../../device-lab-admin.js", () => ({ cleanupOwnerDevices: vi.fn() }));
vi.mock("../../session.js", () => ({
    getSessionLockClaimsForContainer: vi.fn(), withContainerLifecycleLock: vi.fn(), withProjectFamilyLifecycleLock: vi.fn(),
}));

const nativeInvocation = await vi.importActual<typeof import("../../adapters/container-runtime-invocation.js")>("../../adapters/container-runtime-invocation.js");
const nodeChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");

const localBuildScript = fileURLToPath(new URL("../../../scripts/build-distribution-image.mjs", import.meta.url));
const expectedBuildHint = (runtime: string) => process.platform === "win32"
    ? `You can build locally instead (PowerShell): node '${localBuildScript.replace(/'/g, "''")}' --runtime ${runtime}`
    : `You can build locally instead: node '${localBuildScript.replace(/'/g, "'\\''")}' --runtime ${runtime}`;
const remote = `${DOCKER_REGISTRY_IMAGE}:${CLI_VERSION}`;
const pulling = `Pulling ccc image v${CLI_VERSION} from registry...`;
const staleMessage = `Image version mismatch (have v0.9.0, need v${CLI_VERSION}). Pulling update...`;
let cli: string;
let trace: string[];
let results: Record<string, unknown>;

beforeEach(() => {
    vi.resetAllMocks();
    runtimeFacade._resetRuntimeCacheForTest();
    preloadNativeRuntimeFixture(runtimeFacade);
    native.bind.mockImplementation(nativeInvocation.bindNativeRuntimeInvocation);
    cli = "docker";
    trace = [];
    results = { images: { stdout: "" }, inspect: { status: 0, stdout: "0.9.0" }, pull: { status: 0 }, tag: { status: 0 } };
    native.runtime.mockImplementation(() => { trace.push(`runtime:${cli}`); return cli; });
    native.spawn.mockImplementation((...rawCall) => {
        const [runtime, args] = normalizeNativeRuntimeCall(rawCall) as [string, string[]];
        trace.push(`spawn:${runtime}:${args[0]}`);
        return results[args[0]];
    });
    vi.spyOn(console, "log").mockImplementation(message => { trace.push(`log:${message}`); });
    vi.spyOn(console, "warn").mockImplementation(message => { trace.push(`warn:${message}`); });
    vi.spyOn(console, "error").mockImplementation(message => { trace.push(`error:${message}`); });
    vi.spyOn(process, "exit").mockImplementation(code => { trace.push(`exit:${code}`); return undefined as never; });
});
afterEach(() => { runtimeFacade._resetRuntimeCacheForTest(); vi.restoreAllMocks(); });

function calls() {
    return native.spawn.mock.calls.map(call => normalizeNativeRuntimeCall(call) as [string, string[], Record<string, unknown>]);
}

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}

function preparation(registryImage = DOCKER_REGISTRY_IMAGE) {
    return createNativeContainerImagePreparation({
        get registryImage() { trace.push("registry"); return registryImage; },
        isImageExists, getImageLabel, qualifyImageRefForRuntime, pullImage, tagImage,
    });
}

function emittedPreparation(mode: "refusal" | "success") {
    // Only this owned Node child is real. Every process leaf used by the
    // emitted application is replaced before any distribution module loads.
    return nodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import childProcess from 'node:child_process';
        import {syncBuiltinESMExports} from 'node:module';
        const mode = ${JSON.stringify(mode)};
        const prefix = ['--config','/fixture/config','--host','unix:///fixture/engine.sock',
            '--tls=false','--tlscacert=','--tlscert=','--tlskey='];
        let operations = [];
        const capabilityProbes = [];
        const forbidden = [];
        let diagnostics = [];
        let local = false;
        let receipt = {status:0};
        const forbid = name => (...args) => {
            forbidden.push(name);
            throw new Error('Forbidden process effect: ' + name);
        };
        for (const name of ['spawn','exec','execSync','execFile','execFileSync','fork']) {
            childProcess[name] = forbid(name);
        }
        process.kill = forbid('process.kill');
        process.exit = forbid('process.exit');
        childProcess.spawnSync = (program, argv, options) => {
            assert.equal(program, '/fixture/runtime/docker');
            assert.deepEqual(argv.slice(0, prefix.length), prefix);
            assert.equal(options.shell, false);
            const args = argv.slice(prefix.length);
            if (args.length === 1 && args[0] === '--version') {
                capabilityProbes.push(args);
                return {status:0, stdout:'Docker version 26.1.0', stderr:'', signal:null};
            }
            if (args.length === 3 && args[0] === 'info' && args[1] === '--format'
                && args[2] === '{{.OperatingSystem}}') {
                capabilityProbes.push(args);
                return {status:0, stdout:'Fixture Linux', stderr:'', signal:null};
            }
            if (process.platform === 'linux' && args.length === 3 && args[0] === 'info'
                && args[1] === '--format' && args[2] === '{{json .SecurityOptions}}') {
                capabilityProbes.push(args);
                return {status:0, stdout:'[]', stderr:'', signal:null};
            }
            operations.push(args);
            if (args[0] === 'images') {
                assert.deepEqual(args, ['images','-q','ccc']);
                return {status:0, stdout:local ? 'stale-local-image' : ''};
            }
            if (args[0] === 'inspect' && args.includes('{{index .Config.Labels "cli.version"}}')) {
                return {status:0, stdout:'0.9.0'};
            }
            if (args[0] === 'pull') return {status:0};
            if (args[0] === 'tag') {
                assert.equal(options.stdio, 'ignore');
                return receipt;
            }
            return forbid('downstream:' + args[0])();
        };
        syncBuiltinESMExports();
        console.log = () => {};
        console.warn = message => { diagnostics.push(String(message)); };
        console.error = message => { diagnostics.push(String(message)); };
        const runtime = await import(${JSON.stringify(new URL("../../../dist/container-runtime.js", import.meta.url).href)});
        const {NATIVE_RUNTIME_SELECTOR_KEYS} = await import(${JSON.stringify(new URL("../../../dist/ports/container-runtime-invocation.js", import.meta.url).href)});
        runtime._setRuntimeInfoForTest({runtime:'docker'});
        runtime._setRuntimeInvocationForTest({
            version:1, runtime:'docker', executable:'/fixture/runtime/docker',
            transport:{kind:'docker', host:'unix:///fixture/engine.sock', configDirectory:'/fixture/config',
                tls:{enabled:false, verify:false, caFile:null, certFile:null, keyFile:null}},
            selectors:Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null])),
        });
        const docker = await import(${JSON.stringify(new URL("../../../dist/docker.js", import.meta.url).href)});
        if (mode === 'refusal') {
            for (local of [false, true]) {
                for (const sample of [
                    {receipt:{status:17}, expected:/Failed to tag CCC image; container startup was aborted/},
                    {receipt:undefined, expected:/CCC image tag could not be confirmed; container startup was aborted/},
                ]) {
                    operations = [];
                    diagnostics = [];
                    receipt = sample.receipt;
                    assert.throws(() => docker.prepareProjectContainerStartup(), sample.expected);
                    assert.deepEqual(operations.map(args => args[0]), local
                        ? ['images','inspect','pull','tag'] : ['images','pull','tag']);
                    assert.equal(diagnostics.length, 1);
                    assert.equal(diagnostics.some(message => message.includes('Using existing image')), false);
                    assert.deepEqual(forbidden, []);
                }
            }
            assert.deepEqual(capabilityProbes, [
                ['--version'], ['info','--format','{{.OperatingSystem}}'],
                ...(process.platform === 'linux' ? [['info','--format','{{json .SecurityOptions}}']] : []),
            ]);
        } else {
            assert.equal(docker.ensureImage(), undefined);
            assert.deepEqual(operations.map(args => args[0]), ['images','pull','tag']);
            assert.deepEqual(diagnostics, []);
            assert.deepEqual(capabilityProbes, []);
            assert.deepEqual(forbidden, []);
        }
        process.stdout.write('emitted image preparation ' + mode + ' PASS');
    `], {
        encoding: "utf8", timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: "" },
    });
}

describe("image preparation native composition and public facade", () => {
    it("constructs without reading registry, selecting runtime, invoking helpers or presenting", () => {
        preparation();
        expect(trace).toEqual([]);
        expect(native.spawn).not.toHaveBeenCalled();
        expect(native.runtime).not.toHaveBeenCalled();
    });

    it("requires every native helper without reading lazy registry facts", () => {
        const helpers = {
            get registryImage() { throw new Error("eager registry read"); },
            isImageExists, getImageLabel, qualifyImageRefForRuntime, pullImage, tagImage,
        };
        for (const name of ["isImageExists", "getImageLabel", "qualifyImageRefForRuntime", "pullImage", "tagImage"] as const) {
            for (const invalid of [undefined, null, false, 1, "function", {}]) {
                const supplied = Object.create(helpers);
                Object.defineProperty(supplied, name, { value: invalid });
                expect(() => createNativeContainerImagePreparation(supplied)).toThrow(TypeError);
            }
        }
        expect(trace).toEqual([]);
    });

    it.each([null, CLI_VERSION])("retains development/matching local label %s without presentation", label => {
        results.images = { stdout: "image-id" };
        results.inspect = { status: 0, stdout: label };
        expect(ensureImage()).toBeUndefined();
        expect(trace).toEqual(["spawn:docker:images", "spawn:docker:inspect"]);
        expect(calls()).toEqual([
            ["docker", ["images", "-q", IMAGE_NAME], { encoding: "utf-8" }],
            ["docker", ["inspect", IMAGE_NAME, "--format", '{{index .Config.Labels "cli.version"}}'], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }],
        ]);
    });

    it.each([false, true])("pulls and tags with exact native argv/stdio and diagnostics, local=%s", local => {
        results.images = { stdout: local ? "image-id" : "" };
        expect(ensureImage()).toBeUndefined();
        expect(trace).toEqual([
            "spawn:docker:images",
            ...(local ? ["spawn:docker:inspect"] : []),
            `log:${local ? staleMessage : pulling}`, "runtime:docker", "spawn:docker:pull", "spawn:docker:tag",
        ]);
        expect(calls().slice(-2)).toEqual([
            ["docker", ["pull", remote], { stdio: "inherit" }],
            ["docker", ["tag", remote, IMAGE_NAME], { stdio: "ignore" }],
        ]);
        expect(console.warn).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
    });

    it("warns on failed stale pull with no hint, exit or tag", () => {
        results.images = { stdout: "image-id" };
        results.pull = { status: 1 };
        expect(ensureImage()).toBeUndefined();
        expect(trace).toEqual([
            "spawn:docker:images", "spawn:docker:inspect", `log:${staleMessage}`,
            "runtime:docker", "spawn:docker:pull", `warn:Warning: Failed to pull ${remote}. Using existing image.`,
        ]);
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
    });

    it("reports failed absent pull, resolves the build hint late and unwinds startup without exiting", () => {
        results.pull = { status: null };
        expect(ensureImage).toThrow("Failed to pull CCC image; container startup was aborted.");
        expect(trace).toEqual([
            "spawn:docker:images", `log:${pulling}`, "runtime:docker", "spawn:docker:pull",
            `error:Error: Failed to pull ${remote}.`, "runtime:docker", `error:${expectedBuildHint("docker")}`,
        ]);
        expect(calls().map(call => call[1][0])).toEqual(["images", "pull"]);
        expect(console.warn).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
    });

    it("regression: existing ensureImage refuses failed or unconfirmed image publication", () => {
        // Uses the established facade only: the old implementation returns
        // successfully here after both receipts rather than refusing startup.
        for (const receipt of [{ status: 17 }, undefined]) {
            native.spawn.mockClear();
            results.tag = receipt;
            expect(() => ensureImage()).toThrow(/tag.*container startup was aborted/);
            expect(calls().map(call => call[1][0])).toEqual(["images", "pull", "tag"]);
        }
        expect(process.exit).not.toHaveBeenCalled();
    });

    it.each([
        { receipt: { status: 17 }, diagnostic: "Error: Failed to tag CCC image.", failure: "Failed to tag CCC image; container startup was aborted." },
        { receipt: undefined, diagnostic: "Error: CCC image tag could not be confirmed.", failure: "CCC image tag could not be confirmed; container startup was aborted." },
    ])("refuses startup after tag receipt $receipt before image-ID or identity-image preparation", ({ receipt, diagnostic, failure }) => {
        results.images = { stdout: "stale-local-image" };
        results.tag = receipt;
        expect(prepareProjectContainerStartup).toThrow(failure);
        expect(calls().map(call => call[1][0])).toEqual(["images", "inspect", "pull", "tag"]);
        expect(trace.at(-1)).toBe(`error:${diagnostic}`);
        expect(console.warn).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledTimes(1);
        expect(process.exit).not.toHaveBeenCalled();
    });

    it("reobserves and retries only on a subsequent explicit invocation", () => {
        results.tag = { status: 17 };
        expect(ensureImage).toThrow("Failed to tag CCC image");
        expect(calls().map(call => call[1][0])).toEqual(["images", "pull", "tag"]);
        results.tag = { status: 0 };
        expect(ensureImage()).toBeUndefined();
        expect(calls().map(call => call[1][0])).toEqual(["images", "pull", "tag", "images", "pull", "tag"]);
    });

    it("accepts freshly matching labels on retry after uncertain publication", () => {
        results.tag = { status: 0, signal: "SIGTERM" };
        expect(ensureImage).toThrow("CCC image tag could not be confirmed");
        results.images = { stdout: "now-published-image" };
        results.inspect = { status: 0, stdout: CLI_VERSION };
        expect(ensureImage()).toBeUndefined();
        expect(calls().map(call => call[1][0])).toEqual(["images", "pull", "tag", "images", "inspect"]);
    });

    it("reads registry only after the diagnostic and retains module-load CCC_REGISTRY snapshot", () => {
        const previous = process.env.CCC_REGISTRY;
        process.env.CCC_REGISTRY = "changed.invalid/image";
        try {
            preparation().run();
            expect(trace.indexOf("registry")).toBe(trace.indexOf(`log:${pulling}`) + 1);
            expect(calls()).toContainEqual(["docker", ["pull", remote], { stdio: "inherit" }]);
        } finally {
            if (previous === undefined) delete process.env.CCC_REGISTRY;
            else process.env.CCC_REGISTRY = previous;
        }
    });

});

describe("retained native observation limitations", () => {
    it.each([" image-id\n", " \n", undefined])("existence still uses stdout alone: %s", stdout => {
        results.images = {
            stdout,
            get status() { throw new Error("existence status remains unobserved"); },
            get error() { throw new Error("existence error remains unobserved"); },
        };
        expect(isImageExists()).toBe(typeof stdout === "string" && stdout.trim().length > 0);
    });

    it.each([
        { status: 0, stdout: " label \n", expected: "label" },
        { status: 0, stdout: "<no value>\n", expected: null },
        { status: 1, stdout: "private failed inspection", expected: null },
    ])("inspection retains its nullable label contract for $status/$stdout", ({ status, stdout, expected }) => {
        results.inspect = { status, stdout, get error() { throw new Error("inspection error remains unobserved"); } };
        expect(getImageLabel(IMAGE_NAME, "cli.version")).toBe(expected);
    });

    it("inspection exceptions retain the development-image admission behavior", () => {
        results.images = { stdout: "image-id" };
        results.inspect = { get status() { throw new Error("inspection unavailable"); } };
        expect(ensureImage()).toBeUndefined();
        expect(calls().map(call => call[1][0])).toEqual(["images", "inspect"]);
        expect(console.log).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it.each([0, 1, null])("pull still accepts status zero alone, status=%s", status => {
        results.pull = { status, get error() { throw new Error("unused error"); }, get stdout() { throw new Error("unused stdout"); } };
        expect(pullImage("fixture/ref")).toBe(status === 0);
    });
});

describe("native image tag normalization", () => {
    it.each([
        { name: "clean zero", receipt: { status: 0, signal: null }, expected: { kind: "completed" } },
        { name: "positive exit", receipt: { status: 17 }, expected: { kind: "failed", reason: "image-tag-failed" } },
        { name: "absent receipt", receipt: undefined, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "null receipt", receipt: null, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "missing status", receipt: {}, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "null status", receipt: { status: null }, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "negative status", receipt: { status: -1 }, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "fractional status", receipt: { status: 1.5 }, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "non-finite status", receipt: { status: Number.NaN }, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "string status", receipt: { status: "0" }, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "error despite zero", receipt: { status: 0, error: new Error("private transport detail") }, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "error despite nonzero", receipt: { status: 17, error: new Error("private transport detail") }, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "signal despite zero", receipt: { status: 0, signal: "SIGTERM" }, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
        { name: "signal despite nonzero", receipt: { status: 17, signal: "SIGTERM" }, expected: { kind: "indeterminate", reason: "image-tag-unconfirmed" } },
    ])("normalizes $name to a finite semantic observation", ({ receipt, expected }) => {
        results.tag = receipt;
        expect(tagImage("fixture/source", "fixture/target")).toEqual(expected);
        expect(calls()).toEqual([["docker", ["tag", "fixture/source", "fixture/target"], { stdio: "ignore" }]]);
        expect(console.log).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it.each([0, 17, null])("does not read stdout/stderr for status %s or include them in diagnostics", status => {
        results.tag = {
            status,
            get stdout() { throw new Error("private stdout must not be read"); },
            get stderr() { throw new Error("private stderr must not be read"); },
        };
        if (status === 0) expect(ensureImage()).toBeUndefined();
        else expect(ensureImage).toThrow(/tag.*container startup was aborted/);
        expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private");
    });

    it("gives native errors precedence without reading status or the private error message", () => {
        results.tag = {
            error: { get message() { throw new Error("private native message must not be read"); } },
            get status() { throw new Error("error already makes status unconfirmed"); },
        };
        expect(ensureImage).toThrow("CCC image tag could not be confirmed; container startup was aborted.");
        expect(console.error).toHaveBeenCalledWith("Error: CCC image tag could not be confirmed.");
        expect(console.error).toHaveBeenCalledTimes(1);
    });

    it("gives signals precedence without reading status", () => {
        results.tag = { signal: "SIGTERM", get status() { throw new Error("signal already makes status unconfirmed"); } };
        expect(tagImage("fixture/source", "fixture/target")).toEqual({ kind: "indeterminate", reason: "image-tag-unconfirmed" });
    });
});

describe("runtime qualification and observation schedule", () => {
    it.each([
        ["docker", "team/image", "team/image"],
        ["docker", "localhost/image", "localhost/image"],
        ["docker", "registry.example/image", "registry.example/image"],
        ["docker", "registry:5000/image", "registry:5000/image"],
        ["podman", "team/image", "docker.io/team/image"],
        ["podman", "localhost/image", "localhost/image"],
        ["podman", "registry.example/image", "registry.example/image"],
        ["podman", "registry:5000/image", "registry:5000/image"],
    ])("runs actual policy/composition with %s registry %s", (runtime, registry, qualified) => {
        cli = runtime;
        preloadNativeRuntimeFixture(runtimeFacade, { runtime: runtime as "docker" | "podman" });
        preparation(registry).run();
        expect(calls()).toEqual([
            [runtime, ["images", "-q", IMAGE_NAME], { encoding: "utf-8" }],
            [runtime, ["pull", `${qualified}:${CLI_VERSION}`], { stdio: "inherit" }],
            [runtime, ["tag", `${qualified}:${CLI_VERSION}`, IMAGE_NAME], { stdio: "ignore" }],
        ]);
    });

    it.each([
        ["docker", "team/image:v1", "team/image:v1"],
        ["podman", "team/image:v1", "docker.io/team/image:v1"],
        ["podman", "image", "docker.io/image"],
        ["podman", "localhost/image:v1", "localhost/image:v1"],
        ["podman", "registry.example/image:v1", "registry.example/image:v1"],
        ["podman", "registry:5000/image:v1", "registry:5000/image:v1"],
        ["podman", "image:v1", "image:v1"],
    ])("preserves %s reference %s as %s", (runtime, ref, expected) => {
        cli = runtime;
        expect(qualifyImageRefForRuntime(ref)).toBe(expected);
        expect(trace).toEqual([`runtime:${runtime}`]);
        expect(native.spawn).not.toHaveBeenCalled();
    });

    it("keeps native execution captured while qualification observes a changed runtime name", () => {
        vi.mocked(console.log).mockImplementation(message => { trace.push(`log:${message}`); cli = "podman"; });
        native.spawn.mockImplementation((...rawCall) => {
            const [runtime, args] = normalizeNativeRuntimeCall(rawCall) as [string, string[]];
            trace.push(`spawn:${runtime}:${args[0]}`);
            if (args[0] === "pull") cli = "docker";
            return results[args[0]];
        });
        preparation("team/image").run();
        const qualified = `docker.io/team/image:${CLI_VERSION}`;
        expect(calls()).toEqual([
            ["docker", ["images", "-q", IMAGE_NAME], { encoding: "utf-8" }],
            ["docker", ["pull", qualified], { stdio: "inherit" }],
            ["docker", ["tag", qualified, IMAGE_NAME], { stdio: "ignore" }],
        ]);
        expect(trace).toEqual([
            "spawn:docker:images", `log:${pulling}`, "registry", "runtime:podman",
            "spawn:docker:pull", "spawn:docker:tag",
        ]);
        expect(native.runtime).toHaveBeenCalledTimes(1);
    });

    it("observes the runtime after the failure diagnostic for the build hint", () => {
        results.pull = { status: 1 };
        vi.mocked(console.error).mockImplementation(message => { trace.push(`error:${message}`); cli = "podman"; });
        expect(ensureImage).toThrow("Failed to pull CCC image; container startup was aborted.");
        expect(trace.slice(-3)).toEqual([
            `error:Error: Failed to pull ${remote}.`, "runtime:podman", `error:${expectedBuildHint("podman")}`,
        ]);
    });
});

describe("native and presentation fault identity with no downstream effects", () => {
    const absentPre = ["spawn:docker:images", `log:${pulling}`];
    const absentPulled = [...absentPre, "runtime:docker", "spawn:docker:pull"];

    it("propagates a binding fault before any native call", () => {
        const failure = { unexpected: "native binding" };
        native.bind.mockImplementation(() => { throw failure; });
        expect(thrown(ensureImage)).toBe(failure);
        expect(trace).toEqual([]);
    });

    it("propagates a thrown tag operation instead of returning a semantic native failure", () => {
        const failure = new Error("unexpected tag implementation fault");
        native.spawn.mockImplementation((...rawCall) => {
            const [runtime, args] = normalizeNativeRuntimeCall(rawCall) as [string, string[]];
            trace.push(`spawn:${runtime}:${args[0]}`);
            if (args[0] === "tag") throw failure;
            return results[args[0]];
        });
        expect(thrown(ensureImage)).toBe(failure);
        expect(trace).toEqual([...absentPulled, "spawn:docker:tag"]);
        expect(console.error).not.toHaveBeenCalled();
    });

    it("propagates a throwing tag status accessor without reading private output", () => {
        const failure = { unexpected: "tag receipt accessor" };
        results.tag = { get status() { throw failure; }, get stdout() { throw new Error("must not read stdout"); } };
        expect(thrown(ensureImage)).toBe(failure);
        expect(trace).toEqual([...absentPulled, "spawn:docker:tag"]);
        expect(console.error).not.toHaveBeenCalled();
    });

    it("propagates a progress-report fault before pulling", () => {
        vi.mocked(console.log).mockImplementation(() => { throw undefined; });
        expect(thrown(ensureImage)).toBeUndefined();
        expect(trace).toEqual(["spawn:docker:images"]);
    });

    it("propagates a tag-diagnostic fault without a build hint or further native effect", () => {
        const failure = new Error("presentation failed");
        results.tag = { status: 17 };
        vi.mocked(console.error).mockImplementation(() => { throw failure; });
        expect(thrown(ensureImage)).toBe(failure);
        expect(trace).toEqual([...absentPulled, "spawn:docker:tag"]);
        expect(native.runtime).toHaveBeenCalledTimes(1);
    });

    it("unwinds missing pull without calling a hostile process.exit", () => {
        results.pull = { status: 1 };
        vi.mocked(process.exit).mockImplementation(() => { throw new Error("must not exit the caller"); });
        expect(thrown(ensureImage)).toEqual(new Error("Failed to pull CCC image; container startup was aborted."));
        expect(process.exit).not.toHaveBeenCalled();
        expect(trace).toEqual([...absentPulled, `error:Error: Failed to pull ${remote}.`, "runtime:docker", `error:${expectedBuildHint("docker")}`]);
    });

    it("propagates a lazy registry fault after the initial progress report", () => {
        const failure = { unexpected: "registry" };
        const app = createNativeContainerImagePreparation({
            get registryImage(): string { throw failure; },
            isImageExists, getImageLabel, qualifyImageRefForRuntime, pullImage, tagImage,
        });
        expect(trace).toEqual([]);
        expect(thrown(() => app.run())).toBe(failure);
        expect(trace).toEqual(absentPre);
    });
});

describe("packaged image recovery command quoting", () => {
    it("uses literal POSIX path quoting instead of JSON shell interpolation", () => {
        expect(distributionImageBuildCommand("docker", "/payload/a'b $x; & 雪/script.mjs", "linux"))
            .toBe("node '/payload/a'\\''b $x; & 雪/script.mjs' --runtime docker");
    });
    it("uses Windows PowerShell literal quotes with an explicit shell label", () => {
        const command = distributionImageBuildCommand("podman", "C:\\Users\\a'b %PATH% $x & 雪\\script.mjs", "win32");
        expect(command).toBe("node 'C:\\Users\\a''b %PATH% $x & 雪\\script.mjs' --runtime podman");
        expect(distributionImageBuildHint("podman", "C:\\payload space\\script.mjs", "win32"))
            .toBe("You can build locally instead (PowerShell): node 'C:\\payload space\\script.mjs' --runtime podman");
    });
});

describe("emitted image preparation", () => {
    it("emitted startup refuses unconfirmed or failed image tag before downstream image preparation", () => {
        const result = emittedPreparation("refusal");
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("emitted image preparation refusal PASS");
    });

    it("emitted ensureImage returns undefined after confirmed registry preparation", () => {
        const result = emittedPreparation("success");
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("emitted image preparation success PASS");
    });
});
