import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeContainerImagePreparation } from "../../composition/container-image-preparation.js";
import {
    ensureImage, getImageLabel, isImageExists, pullImage, qualifyImageRefForRuntime, tagImage,
} from "../../docker.js";
import { CLI_VERSION, DOCKER_REGISTRY_IMAGE, IMAGE_NAME } from "../../utils.js";

const native = vi.hoisted(() => ({ spawn: vi.fn(), runtime: vi.fn() }));
vi.mock("child_process", async original => ({
    ...await original<typeof import("node:child_process")>(), spawnSync: native.spawn,
}));
vi.mock("../../container-runtime.js", async original => ({
    ...await original<typeof import("../../container-runtime.js")>(), runtimeCli: native.runtime,
}));
vi.mock("../../device-lab-admin.js", () => ({ cleanupOwnerDevices: vi.fn() }));
vi.mock("../../session.js", () => ({
    getSessionLockClaimsForContainer: vi.fn(), withContainerLifecycleLock: vi.fn(), withProjectFamilyLifecycleLock: vi.fn(),
}));

const remote = `${DOCKER_REGISTRY_IMAGE}:${CLI_VERSION}`;
const pulling = `Pulling ccc image v${CLI_VERSION} from registry...`;
const staleMessage = `Image version mismatch (have v0.9.0, need v${CLI_VERSION}). Pulling update...`;
let cli: string;
let trace: string[];
let results: Record<string, unknown>;

beforeEach(() => {
    vi.resetAllMocks();
    cli = "docker";
    trace = [];
    results = { images: { stdout: "" }, inspect: { status: 0, stdout: "0.9.0" }, pull: { status: 0 }, tag: undefined };
    native.runtime.mockImplementation(() => { trace.push(`runtime:${cli}`); return cli; });
    native.spawn.mockImplementation((runtime: string, args: string[]) => {
        trace.push(`spawn:${runtime}:${args[0]}`);
        return results[args[0]];
    });
    vi.spyOn(console, "log").mockImplementation(message => { trace.push(`log:${message}`); });
    vi.spyOn(console, "warn").mockImplementation(message => { trace.push(`warn:${message}`); });
    vi.spyOn(console, "error").mockImplementation(message => { trace.push(`error:${message}`); });
    vi.spyOn(process, "exit").mockImplementation(code => { trace.push(`exit:${code}`); return undefined as never; });
});
afterEach(() => { vi.restoreAllMocks(); });

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
        expect(trace).toEqual(["runtime:docker", "spawn:docker:images", "runtime:docker", "spawn:docker:inspect"]);
        expect(native.spawn.mock.calls).toEqual([
            ["docker", ["images", "-q", IMAGE_NAME], { encoding: "utf-8" }],
            ["docker", ["inspect", IMAGE_NAME, "--format", '{{index .Config.Labels "cli.version"}}'], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }],
        ]);
    });

    it.each([false, true])("pulls and tags with exact native argv/stdio and diagnostics, local=%s", local => {
        results.images = { stdout: local ? "image-id" : "" };
        expect(ensureImage()).toBeUndefined();
        expect(trace).toEqual([
            "runtime:docker", "spawn:docker:images",
            ...(local ? ["runtime:docker", "spawn:docker:inspect"] : []),
            `log:${local ? staleMessage : pulling}`, "runtime:docker", "runtime:docker", "spawn:docker:pull", "runtime:docker", "spawn:docker:tag",
        ]);
        expect(native.spawn.mock.calls.slice(-2)).toEqual([
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
            "runtime:docker", "spawn:docker:images", "runtime:docker", "spawn:docker:inspect", `log:${staleMessage}`,
            "runtime:docker", "runtime:docker", "spawn:docker:pull", `warn:Warning: Failed to pull ${remote}. Using existing image.`,
        ]);
        expect(console.error).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
    });

    it("reports failed absent pull, resolves the build hint late and unwinds startup without exiting", () => {
        results.pull = { status: null };
        expect(ensureImage).toThrow("Failed to pull CCC image; container startup was aborted.");
        expect(trace).toEqual([
            "runtime:docker", "spawn:docker:images", `log:${pulling}`, "runtime:docker", "runtime:docker", "spawn:docker:pull",
            `error:Error: Failed to pull ${remote}.`, "runtime:docker", "error:You can build locally instead: docker build -t ccc .",
        ]);
        expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(["images", "pull"]);
        expect(console.warn).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
    });

    it("reads registry only after the diagnostic and retains module-load CCC_REGISTRY snapshot", () => {
        const previous = process.env.CCC_REGISTRY;
        process.env.CCC_REGISTRY = "changed.invalid/image";
        try {
            preparation().run();
            expect(trace.indexOf("registry")).toBe(trace.indexOf(`log:${pulling}`) + 1);
            expect(native.spawn).toHaveBeenCalledWith("docker", ["pull", remote], { stdio: "inherit" });
        } finally {
            if (previous === undefined) delete process.env.CCC_REGISTRY;
            else process.env.CCC_REGISTRY = previous;
        }
    });

    it("keeps supplied helper receivers and downstream replacements live", () => {
        const calls: string[] = [];
        const helpers = {
            registryImage: "custom/image",
            isImageExists() {
                expect(this).toBe(helpers); calls.push("exists");
                this.pullImage = function (ref) { expect(this).toBe(helpers); calls.push(`replacement-pull:${ref}`); return true; };
                return false;
            },
            getImageLabel: vi.fn(() => null),
            qualifyImageRefForRuntime(ref: string) { expect(this).toBe(helpers); calls.push(`qualify:${ref}`); return `qualified/${ref}`; },
            pullImage: (_ref: string) => false,
            tagImage(source: string, target: string) { expect(this).toBe(helpers); calls.push(`tag:${source}:${target}`); },
        };
        const app = createNativeContainerImagePreparation(helpers);
        expect(app.run()).toBeUndefined();
        expect(calls).toEqual(["exists", `qualify:custom/image:${CLI_VERSION}`, `replacement-pull:qualified/custom/image:${CLI_VERSION}`, `tag:qualified/custom/image:${CLI_VERSION}:${IMAGE_NAME}`]);
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
                expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(
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
            expect(native.spawn.mock.calls.map(call => call[1][0])).toEqual(expected === null
                ? ["inspect", "images", "inspect"] : ["inspect", "images", "inspect", "pull", "tag"]);
        });
    }

    it.each(["runtime", "spawn", "status", "stdout"] as const)("inspection catches thrown %s and retains the local image", stage => {
        const failure = { inspect: stage };
        results.images = { stdout: "image-id" };
        if (stage === "runtime") native.runtime.mockImplementationOnce(() => "docker").mockImplementationOnce(() => { throw failure; });
        if (stage === "spawn") native.spawn.mockImplementation((runtime, args) => {
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
        expect(native.spawn.mock.calls.some(call => call[1][0] === "pull")).toBe(false);
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
        preparation(registry).run();
        expect(native.spawn.mock.calls).toEqual([
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

    it("observes runtime changes separately at report, qualification, pull and tag", () => {
        vi.mocked(console.log).mockImplementation(message => { trace.push(`log:${message}`); cli = "podman"; });
        let observations = 0;
        native.runtime.mockImplementation(() => {
            const current = cli;
            trace.push(`runtime:${current}`);
            if (++observations === 2) cli = "docker";
            return current;
        });
        native.spawn.mockImplementation((runtime, args) => {
            trace.push(`spawn:${runtime}:${args[0]}`);
            if (args[0] === "pull") cli = "podman";
            return results[args[0]];
        });
        preparation("team/image").run();
        const qualified = `docker.io/team/image:${CLI_VERSION}`;
        expect(native.spawn.mock.calls).toEqual([
            ["docker", ["images", "-q", IMAGE_NAME], { encoding: "utf-8" }],
            ["docker", ["pull", qualified], { stdio: "inherit" }],
            ["podman", ["tag", qualified, IMAGE_NAME], { stdio: "ignore" }],
        ]);
        expect(trace).toEqual([
            "runtime:docker", "spawn:docker:images", `log:${pulling}`, "registry", "runtime:podman",
            "runtime:docker", "spawn:docker:pull", "runtime:podman", "spawn:podman:tag",
        ]);
    });

    it("observes the runtime after the failure diagnostic for the build hint", () => {
        results.pull = { status: 1 };
        vi.mocked(console.error).mockImplementation(message => { trace.push(`error:${message}`); cli = "podman"; });
        expect(ensureImage).toThrow("Failed to pull CCC image; container startup was aborted.");
        expect(trace.slice(-3)).toEqual([
            `error:Error: Failed to pull ${remote}.`, "runtime:podman", "error:You can build locally instead: podman build -t ccc .",
        ]);
    });
});

describe("native and presentation fault identity with no downstream effects", () => {
    const absentPre = ["runtime:docker", "spawn:docker:images", `log:${pulling}`];
    const stalePre = ["runtime:docker", "spawn:docker:images", "runtime:docker", "spawn:docker:inspect", `log:${staleMessage}`];
    const absentPulled = [...absentPre, "runtime:docker", "runtime:docker", "spawn:docker:pull"];
    const stalePulled = [...stalePre, "runtime:docker", "runtime:docker", "spawn:docker:pull"];

    for (const local of [false, true]) {
        const pre = local ? stalePre : absentPre;
        const stages = [
            { name: "existence runtime", observation: 1, prefix: [] },
            { name: "qualification runtime", observation: local ? 3 : 2, prefix: pre },
            { name: "pull runtime", observation: local ? 4 : 3, prefix: [...pre, "runtime:docker"] },
            { name: "tag runtime", observation: local ? 5 : 4, prefix: [...pre, "runtime:docker", "runtime:docker", "spawn:docker:pull"] },
        ];
        for (const stage of stages) {
            it.each([new Error("native runtime"), { runtime: true }, "native runtime"])(`${stage.name}, local=${local}, preserves %s`, failure => {
                results.images = { stdout: local ? "image-id" : "" };
                let observations = 0;
                native.runtime.mockImplementation(() => {
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
                native.spawn.mockImplementation((runtime, args) => {
                    trace.push(`spawn:${runtime}:${args[0]}`);
                    if (args[0] === operation) throw failure;
                    return results[args[0]];
                });
                expect(thrown(ensureImage)).toBe(failure);
                const expected = operation === "images" ? ["runtime:docker", "spawn:docker:images"]
                    : operation === "pull" ? [...pre, "runtime:docker", "runtime:docker", "spawn:docker:pull"]
                    : [...pre, "runtime:docker", "runtime:docker", "spawn:docker:pull", "runtime:docker", "spawn:docker:tag"];
                expect(trace).toEqual(expected);
            });
        }
    }

    const reports = [
        { name: "missing report", local: false, pull: true, stream: "log", nth: 1, prefix: ["runtime:docker", "spawn:docker:images"] },
        { name: "stale report", local: true, pull: true, stream: "log", nth: 1, prefix: ["runtime:docker", "spawn:docker:images", "runtime:docker", "spawn:docker:inspect"] },
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
            if (++observations === 4) throw failure;
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
        expect(trace).toEqual([...absentPulled, `error:Error: Failed to pull ${remote}.`, "runtime:docker", "error:You can build locally instead: docker build -t ccc ."]);
    });

    it.each([new Error("stdout"), { stdout: true }])("existence stdout failure escapes before any report: %s", failure => {
        results.images = { get stdout() { throw failure; } };
        expect(thrown(ensureImage)).toBe(failure);
        expect(trace).toEqual(["runtime:docker", "spawn:docker:images"]);
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
