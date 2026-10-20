import { describe, expect, it } from "vitest";
import { createContainerImagePreparation } from "../../application/container-image-preparation.js";
import type {
    ContainerImagePreparationOutcome,
    ContainerImagePreparationPorts,
    ContainerImagePreparationRequest,
    ImageTagOutcome,
} from "../../ports/container-image-preparation.js";

const ref = "docker.io/team/image:1.2.3";
const missing = ["exists", "reportPull:1.2.3", "qualify:team/image:1.2.3", `pull:${ref}`];
const stale = ["exists", "label:ccc:cli.version", "reportStale:0.9.0:1.2.3", "qualify:team/image:1.2.3", `pull:${ref}`];
const tagged = `tag:${ref}:ccc`;

function fixture(localExists = false, label: string | null = "0.9.0", pull = true) {
    const trace: string[] = [];
    const state = { localExists, label, pull, tag: { kind: "completed" } as ImageTagOutcome };
    const ports: ContainerImagePreparationPorts = {
        exists() { trace.push("exists"); return state.localExists; },
        label(image, key) { trace.push(`label:${image}:${key}`); return state.label; },
        qualify(remote) { trace.push(`qualify:${remote}`); return `docker.io/${remote}`; },
        pull(remote) { trace.push(`pull:${remote}`); return state.pull; },
        tag(source, target) { trace.push(`tag:${source}:${target}`); return state.tag; },
        reportStale(value, version) { trace.push(`reportStale:${value}:${version}`); },
        reportPull(version) { trace.push(`reportPull:${version}`); },
        reportFallback(remote) { trace.push(`reportFallback:${remote}`); },
    };
    const request: ContainerImagePreparationRequest = {
        imageName: "ccc", version: "1.2.3", registryImage: "team/image",
    };
    return { ports, request, state, trace, app: createContainerImagePreparation(ports) };
}

function thrown(operation: () => unknown): unknown {
    try { operation(); } catch (error) { return error; }
    throw new Error("Expected an exception");
}

describe("image preparation synchronous capabilities", () => {
    it("constructs without effects and rejects a missing or noncallable observation", () => {
        const f = fixture();
        expect(f.trace).toEqual([]);
        expect(() => createContainerImagePreparation({ ...f.ports, tag: undefined } as unknown as ContainerImagePreparationPorts))
            .toThrow("Container image preparation requires a callable tag port.");
        expect(() => createContainerImagePreparation(null as unknown as ContainerImagePreparationPorts)).toThrow(TypeError);
        expect(f.trace).toEqual([]);
    });

    it("needs only semantic observations and progress reports to return a missing-pull failure", () => {
        const f = fixture(false, null, false);
        expect(f.app.run(f.request)).toEqual({ kind: "failed", reason: "image-pull-failed", reference: ref });
        expect(f.trace).toEqual(missing);
    });
});

describe("image preparation outcomes and effects", () => {
    it.each([
        { name: "development", exists: true, label: null, pull: true, source: "development", trace: ["exists", "label:ccc:cli.version"] },
        { name: "matching", exists: true, label: "1.2.3", pull: true, source: "matching", trace: ["exists", "label:ccc:cli.version"] },
        { name: "stale registry image", exists: true, label: "0.9.0", pull: true, source: "registry", trace: [...stale, tagged] },
        { name: "empty version label", exists: true, label: "", pull: true, source: "registry", trace: ["exists", "label:ccc:cli.version", "reportStale::1.2.3", "qualify:team/image:1.2.3", `pull:${ref}`, tagged] },
        { name: "missing registry image", exists: false, label: null, pull: true, source: "registry", trace: [...missing, tagged] },
        { name: "local fallback", exists: true, label: "0.9.0", pull: false, source: "fallback", trace: [...stale, `reportFallback:${ref}`] },
    ])("completes with $source for $name", scenario => {
        const f = fixture(scenario.exists, scenario.label, scenario.pull);
        expect(f.app.run(f.request)).toEqual({ kind: "completed", source: scenario.source });
        expect(f.trace).toEqual(scenario.trace);
    });

    it.each([false, true])("reports failed publication without local fallback or another native effect, local=%s", local => {
        const f = fixture(local);
        f.state.tag = { kind: "failed", reason: "image-tag-failed" };
        expect(f.app.run(f.request)).toEqual({ kind: "failed", reason: "image-tag-failed" });
        expect(f.trace).toEqual([...(local ? stale : missing), tagged]);
    });

    it.each([false, true])("reports unconfirmed publication without retry or compensation, local=%s", local => {
        const f = fixture(local);
        f.state.tag = { kind: "indeterminate", reason: "image-tag-unconfirmed" };
        expect(f.app.run(f.request)).toEqual({ kind: "indeterminate", reason: "image-tag-unconfirmed" });
        expect(f.trace).toEqual([...(local ? stale : missing), tagged]);
    });

    it("reobserves the next explicit invocation and can retry a failed publication", () => {
        const f = fixture();
        f.state.tag = { kind: "failed", reason: "image-tag-failed" };
        const failed: ContainerImagePreparationOutcome = f.app.run(f.request);
        expect(failed).toEqual({ kind: "failed", reason: "image-tag-failed" });
        expect(f.trace).toEqual([...missing, tagged]);
        f.state.tag = { kind: "completed" };
        expect(f.app.run(f.request)).toEqual({ kind: "completed", source: "registry" });
        expect(f.trace).toEqual([...missing, tagged, ...missing, tagged]);
    });

    it("accepts a freshly matching image on an explicit retry after an uncertain tag", () => {
        const f = fixture();
        f.state.tag = { kind: "indeterminate", reason: "image-tag-unconfirmed" };
        expect(f.app.run(f.request)).toEqual({ kind: "indeterminate", reason: "image-tag-unconfirmed" });
        f.state.localExists = true;
        f.state.label = "1.2.3";
        expect(f.app.run(f.request)).toEqual({ kind: "completed", source: "matching" });
        expect(f.trace).toEqual([...missing, tagged, "exists", "label:ccc:cli.version"]);
    });

    it("keeps independent instances and observes every run", () => {
        const first = fixture(true, null);
        const second = fixture(false, null, false);
        expect(first.app.run(first.request)).toEqual({ kind: "completed", source: "development" });
        expect(second.app.run(second.request)).toEqual({ kind: "failed", reason: "image-pull-failed", reference: ref });
        expect(first.app.run(first.request)).toEqual({ kind: "completed", source: "development" });
        expect(first.trace).toEqual(["exists", "label:ccc:cli.version", "exists", "label:ccc:cli.version"]);
        expect(second.trace).toEqual(missing);
    });
});

describe("image preparation programming exceptions", () => {
    it("preserves a thrown observation value before reports or effects", () => {
        const f = fixture();
        const failure = { unexpected: "exists" };
        f.ports.exists = () => { throw failure; };
        expect(thrown(() => f.app.run(f.request))).toBe(failure);
        expect(f.trace).toEqual([]);
    });

    it("preserves a thrown tag value without turning it into a fallback", () => {
        const f = fixture(true);
        const failure = new Error("unexpected tag implementation fault");
        f.ports.tag = () => { throw failure; };
        expect(thrown(() => f.app.run(f.request))).toBe(failure);
        expect(f.trace).toEqual(stale);
    });

    it("stops before pull when the progress reporter throws", () => {
        const f = fixture();
        f.ports.reportPull = () => { throw undefined; };
        expect(thrown(() => f.app.run(f.request))).toBeUndefined();
        expect(f.trace).toEqual(["exists"]);
    });
});
