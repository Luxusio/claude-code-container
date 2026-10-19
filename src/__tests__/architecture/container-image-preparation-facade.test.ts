import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeContainerImagePreparation, distributionImageBuildCommand, distributionImageBuildHint } from "../../composition/container-image-preparation.js";
import { ensureImage, getImageLabel, isImageExists, pullImage, qualifyImageRefForRuntime, tagImage } from "../../docker.js";
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
    results = { images: { stdout: "" }, inspect: { status: 0, stdout: "0.9.0" }, pull: { status: 0 }, tag: undefined };
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

describe("unchanged native result interpretation", () => {
    for (const status of [0, 1, null]) {
        for (const error of [undefined, new Error("native")]) {
            it.each([" image-id\n", " \n", "", null, undefined])(`existence uses stdout alone with status=${status}, error=${String(error)}: %s`, stdout => {
                let ignored = 0;
                results.images = {
                    stdout,
                    get status() { ignored++; return status; },
                    get error() { ignored++; return error; },
                };
                expect(isImageExists()).toBe(typeof stdout === "string" && stdout.trim().length > 0);
                expect(ignored).toBe(0);
                ensureImage();
                expect(ignored).toBe(0);
                expect(calls().map(call => call[1][0])).toEqual(
                    typeof stdout === "string" && stdout.trim().length > 0
                        ? ["images", "images", "inspect", "pull", "tag"] : ["images", "images", "pull", "tag"],
                );
            });
        }
    }

    for (const status of [0, 1, null]) {
        it.each([" label \n", "", " \n", "<no value>", null, undefined])(`inspection status=${status} preserves nullable label: %s`, stdout => {
            results.images = { stdout: "image-id" };
            let reads = 0;
            results.inspect = {
                status,
                get stdout() { reads++; return stdout; },
                get error() { throw new Error("unused error field"); },
            };
            const expected = status === 0 && typeof stdout === "string" && stdout.trim() && stdout.trim() !== "<no value>" ? stdout.trim() : null;
            expect(getImageLabel(IMAGE_NAME, "cli.version")).toBe(expected);
            expect(reads).toBe(status === 0 ? 1 : 0);
            ensureImage();
            expect(calls().map(call => call[1][0])).toEqual(expected === null
                ? ["inspect", "images", "inspect"] : ["inspect", "images", "inspect", "pull", "tag"]);
        });
    }

    it.each(["binding", "spawn", "status", "stdout"] as const)("inspection catches thrown %s and retains the local image", stage => {
        const failure = { inspect: stage };
        results.images = { stdout: "image-id" };
        if (stage === "binding") native.bind.mockImplementationOnce(nativeInvocation.bindNativeRuntimeInvocation).mockImplementationOnce(() => { throw failure; });
        if (stage === "spawn") native.spawn.mockImplementation((...rawCall) => {
            const [runtime, args] = normalizeNativeRuntimeCall(rawCall) as [string, string[]];
            trace.push(`spawn:${runtime}:${args[0]}`);
            if (args[0] === "inspect") throw failure;
            return results[args[0]];
        });
        if (stage === "status") results.inspect = { get status() { throw failure; }, get stdout() { throw new Error("must not read stdout"); } };
        if (stage === "stdout") results.inspect = { status: 0, get stdout() { throw failure; } };
        expect(ensureImage()).toBeUndefined();
        expect(console.log).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
        expect(calls().some(call => call[1][0] === "pull")).toBe(false);
    });

    it.each([0, 1, -1, null, undefined])("pull accepts status zero only and never reads error/stdout, status=%s", status => {
        results.pull = { status, get error() { throw new Error("unused error"); }, get stdout() { throw new Error("unused stdout"); } };
        expect(pullImage("fixture/ref")).toBe(status === 0);
        if (status === 0) expect(ensureImage()).toBeUndefined();
        else expect(ensureImage).toThrow("Failed to pull CCC image; container startup was aborted.");
        expect(process.exit).not.toHaveBeenCalled();
    });

    it.each([undefined, null, { status: 1 }, { status: null }, { status: 0, error: new Error("ignored tag failure") }])("tag ignores every returned result: %s", result => {
        results.tag = result;
        expect(ensureImage()).toBeUndefined();
        expect(process.exit).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
    });

    it("tag never reads result accessors", () => {
        results.tag = {
            get status() { throw new Error("unused status"); },
            get error() { throw new Error("unused error"); },
            get stdout() { throw new Error("unused stdout"); },
        };
        expect(ensureImage()).toBeUndefined();
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
    const stalePre = ["spawn:docker:images", "spawn:docker:inspect", `log:${staleMessage}`];
    const absentPulled = [...absentPre, "runtime:docker", "spawn:docker:pull"];
    const stalePulled = [...stalePre, "runtime:docker", "spawn:docker:pull"];

    for (const local of [false, true]) {
        const pre = local ? stalePre : absentPre;
        const stages = [
            { name: "existence binding", boundary: "binding", observation: 1, prefix: [] },
            { name: "qualification runtime", boundary: "runtime", observation: 1, prefix: pre },
            { name: "pull binding", boundary: "binding", observation: local ? 3 : 2, prefix: [...pre, "runtime:docker"] },
            { name: "tag binding", boundary: "binding", observation: local ? 4 : 3, prefix: [...pre, "runtime:docker", "spawn:docker:pull"] },
        ];
        for (const stage of stages) {
            it.each([new Error("native runtime"), { runtime: true }, "native runtime"])(`${stage.name}, local=${local}, preserves %s`, failure => {
                results.images = { stdout: local ? "image-id" : "" };
                let observations = 0;
                if (stage.boundary === "binding") native.bind.mockImplementation(invocation => {
                    if (++observations === stage.observation) throw failure;
                    return nativeInvocation.bindNativeRuntimeInvocation(invocation);
                });
                else native.runtime.mockImplementation(() => {
                    if (++observations === stage.observation) throw failure;
                    trace.push("runtime:docker");
                    return "docker";
                });
                expect(thrown(ensureImage)).toBe(failure);
                expect(trace).toEqual(stage.prefix);
            });
        }
        for (const operation of ["images", "pull", "tag"] as const) {
            it.each([new Error("spawn"), { spawn: true }, "spawn"])(`native ${operation} throw, local=${local}, preserves %s`, failure => {
                results.images = { stdout: local ? "image-id" : "" };
                native.spawn.mockImplementation((...rawCall) => {
                    const [runtime, args] = normalizeNativeRuntimeCall(rawCall) as [string, string[]];
                    trace.push(`spawn:${runtime}:${args[0]}`);
                    if (args[0] === operation) throw failure;
                    return results[args[0]];
                });
                expect(thrown(ensureImage)).toBe(failure);
                const expected = operation === "images" ? ["spawn:docker:images"]
                    : operation === "pull" ? [...pre, "runtime:docker", "spawn:docker:pull"]
                    : [...pre, "runtime:docker", "spawn:docker:pull", "spawn:docker:tag"];
                expect(trace).toEqual(expected);
            });
        }
    }

    const reports = [
        { name: "missing report", local: false, pull: true, stream: "log", nth: 1, prefix: ["spawn:docker:images"] },
        { name: "stale report", local: true, pull: true, stream: "log", nth: 1, prefix: ["spawn:docker:images", "spawn:docker:inspect"] },
        { name: "fallback warning", local: true, pull: false, stream: "warn", nth: 1, prefix: stalePulled },
        { name: "failure error", local: false, pull: false, stream: "error", nth: 1, prefix: absentPulled },
        { name: "build hint error", local: false, pull: false, stream: "error", nth: 2, prefix: [...absentPulled, `error:Error: Failed to pull ${remote}.`, "runtime:docker"] },
    ] as const;
    for (const report of reports) {
        it.each([new Error("presentation"), { presentation: true }, "presentation"])(`${report.name} preserves %s`, failure => {
            results.images = { stdout: report.local ? "image-id" : "" };
            results.pull = { status: report.pull ? 0 : 1 };
            let calls = 0;
            vi.mocked(console[report.stream]).mockImplementation(message => {
                if (++calls === report.nth) throw failure;
                trace.push(`${report.stream}:${message}`);
            });
            expect(thrown(ensureImage)).toBe(failure);
            expect(trace).toEqual(report.prefix);
        });
    }

    it.each([new Error("hint runtime"), { hint: true }])("build hint runtime failure follows failure diagnostic: %s", failure => {
        results.pull = { status: 1 };
        let observations = 0;
        native.runtime.mockImplementation(() => {
            if (++observations === 2) throw failure;
            trace.push("runtime:docker");
            return "docker";
        });
        expect(thrown(ensureImage)).toBe(failure);
        expect(trace).toEqual([...absentPulled, `error:Error: Failed to pull ${remote}.`]);
    });

    it.each([new Error("exit"), { exit: true }, null, undefined])("unwinds without calling a hostile process.exit: %s", failure => {
        results.pull = { status: 1 };
        vi.mocked(process.exit).mockImplementation(() => { throw failure; });
        expect(thrown(ensureImage)).toEqual(new Error("Failed to pull CCC image; container startup was aborted."));
        expect(process.exit).not.toHaveBeenCalled();
        expect(trace).toEqual([...absentPulled, `error:Error: Failed to pull ${remote}.`, "runtime:docker", `error:${expectedBuildHint("docker")}`]);
    });

    it.each([new Error("stdout"), { stdout: true }])("existence stdout failure escapes before any report: %s", failure => {
        results.images = { get stdout() { throw failure; } };
        expect(thrown(ensureImage)).toBe(failure);
        expect(trace).toEqual(["spawn:docker:images"]);
    });

    it.each([new Error("status"), { status: true }])("pull status failure escapes before tag/failure presentation: %s", failure => {
        results.pull = { get status() { throw failure; } };
        expect(thrown(ensureImage)).toBe(failure);
        expect(trace).toEqual(absentPulled);
    });

    it.each([new Error("registry"), { registry: true }])("lazy supplied registry failure follows the initial report: %s", failure => {
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
