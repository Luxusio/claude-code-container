import { describe, expect, it } from "vitest";
import { createContainerImagePreparation } from "../../application/container-image-preparation.js";
import type {
    ContainerImagePreparationPorts,
    ContainerImagePreparationRequest,
} from "../../ports/container-image-preparation.js";

const names = [
    "exists", "label", "qualify", "pull", "tag", "reportStale", "reportPull",
    "reportFallback", "reportFailure", "reportBuildHint", "exitFailure",
] as const;
const ref = "docker.io/team/image:1.2.3";
// Assert current image admission, publication and native effects.
const missing = ["exists", "reportPull:1.2.3", "qualify:team/image:1.2.3", `pull:${ref}`];
const stale = ["exists", "label:ccc:cli.version", "reportStale:0.9.0:1.2.3", "qualify:team/image:1.2.3", `pull:${ref}`];
const scenarios = [
    { name: "development", exists: true, label: null, pull: true, trace: ["exists", "label:ccc:cli.version"] },
    { name: "matching", exists: true, label: "1.2.3", pull: true, trace: ["exists", "label:ccc:cli.version"] },
    { name: "stale success", exists: true, label: "0.9.0", pull: true, trace: [...stale, `tag:${ref}:ccc`] },
    { name: "empty label", exists: true, label: "", pull: true, trace: [...stale.map(event => event === "reportStale:0.9.0:1.2.3" ? "reportStale::1.2.3" : event), `tag:${ref}:ccc`] },
    { name: "missing success", exists: false, label: "unused", pull: true, trace: [...missing, `tag:${ref}:ccc`] },
    { name: "stale fallback", exists: true, label: "0.9.0", pull: false, trace: [...stale, `reportFallback:${ref}`] },
    { name: "missing failure", exists: false, label: "unused", pull: false, trace: [...missing, `reportFailure:${ref}`, "reportBuildHint", "exitFailure"] },
] as const;

function fixture(localExists = false, label: string | null = "0.9.0", pull = true) {
    const trace: string[] = [];
    const state = { localExists, label, pull, imageName: "ccc", version: "1.2.3", registryImage: "team/image" };
    const effect = (event: string): undefined => { trace.push(event); return undefined; };
    const ports: ContainerImagePreparationPorts = {
        exists() { trace.push("exists"); return state.localExists; },
        label(image, key) { trace.push(`label:${image}:${key}`); return state.label; },
        qualify(remote) { trace.push(`qualify:${remote}`); return `docker.io/${remote}`; },
        pull(remote) { trace.push(`pull:${remote}`); return state.pull; },
        tag(source, target) { return effect(`tag:${source}:${target}`); },
        reportStale(value, version) { return effect(`reportStale:${value}:${version}`); },
        reportPull(version) { return effect(`reportPull:${version}`); },
        reportFallback(remote) { return effect(`reportFallback:${remote}`); },
        reportFailure(remote) { return effect(`reportFailure:${remote}`); },
        reportBuildHint() { return effect("reportBuildHint"); },
        exitFailure() { return effect("exitFailure"); },
    };
    const request: ContainerImagePreparationRequest = {
        imageName: state.imageName,
        version: state.version,
        registryImage: state.registryImage,
    };
    return { ports, request, state, trace, app: createContainerImagePreparation(ports) };
}

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}

describe("image preparation required synchronous capabilities", () => {
    it("constructs purely and rejects every missing or noncallable capability before effects", () => {
        const f = fixture();
        expect(f.trace).toEqual([]);
        for (const name of names) {
            for (const invalid of [undefined, null, false, 1, "function", {}]) {
                const error = thrown(() => createContainerImagePreparation({ ...f.ports, [name]: invalid } as unknown as ContainerImagePreparationPorts));
                expect(error).toBeInstanceOf(TypeError);
                expect((error as Error).message).toBe(`Container image preparation requires a callable ${name} port.`);
            }
            const incomplete = { ...f.ports };
            Reflect.deleteProperty(incomplete, name);
            expect(() => createContainerImagePreparation(incomplete)).toThrow(TypeError);
        }
        for (const absent of [undefined, null]) {
            expect(() => createContainerImagePreparation(absent as unknown as ContainerImagePreparationPorts)).toThrow(TypeError);
        }
        expect(f.trace).toEqual([]);
    });

    it("keeps independent instances and repeats observations on every run", () => {
        const first = fixture(true, null);
        const second = fixture(false, "unused", false);
        first.app.run(first.request);
        second.app.run(second.request);
        first.app.run(first.request);
        expect(first.trace).toEqual([...scenarios[0].trace, ...scenarios[0].trace]);
        expect(second.trace).toEqual(scenarios[6].trace);
    });
});

describe("image preparation admission and effects", () => {
    it.each(scenarios)("handles $name with the expected effects", scenario => {
        const f = fixture(scenario.exists, scenario.label, scenario.pull);
        expect(f.app.run(f.request)).toBeUndefined();
        expect(f.trace).toEqual(scenario.trace);
    });

;
});

describe("image preparation exact exception and stop boundaries", () => {
    for (const scenario of scenarios) {
        for (const name of names) {
            const index = scenario.trace.findIndex(event => event === name || event.startsWith(`${name}:`));
            if (index < 0) continue;
            it.each([new Error("native fault"), { fault: true }, "native fault", null, undefined])(
                `${scenario.name}: propagates ${name} thrown value %s`, failure => {
                    const f = fixture(scenario.exists, scenario.label, scenario.pull);
                    Object.assign(f.ports, { [name]: () => { throw failure; } });
                    expect(thrown(() => f.app.run(f.request))).toBe(failure);
                    expect(f.trace).toEqual(scenario.trace.slice(0, index));
                },
            );
        }

    }
});
