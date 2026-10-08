import { describe, expect, it } from "vitest";
import { prepareIdentityImage } from "../../application/container/identity-image.js";
import { identityImageLabels, type ContainerIdentity, type IdentityImageObservation } from "../../domain/container/identity-image.js";
import type { IdentityImagePorts } from "../../ports/container/identity-image.js";

const base = "a".repeat(64);
const builtId = "b".repeat(64);
const identity: ContainerIdentity = { uid: 1234, gid: 2345, mapping: "host", contractVersion: "1" };
const labels = identityImageLabels(base, identity);
const image = (): IdentityImageObservation => ({ Id: builtId, Config: { User: "ccc", Labels: { ...labels } } });

function fixture(observations: (IdentityImageObservation | null)[]) {
    const events: unknown[][] = [];
    let locked = false;
    const effect = (name: string, ...args: unknown[]) => {
        expect(locked).toBe(true);
        events.push([name, ...args]);
    };
    const ports: IdentityImagePorts = {
        captureLabelsDigest: () => serialized => { events.push(["digest", serialized]); return "known-label-hash"; },
        withIdentityLock: (key, operation) => {
            events.push(["lock", key]); locked = true;
            try { return operation(); } finally { locked = false; events.push(["unlock"]); }
        },
        inspectImage: name => { effect("inspect", name); return observations.shift() ?? null; },
        observeAccount: observed => { effect("probe", observed.Id); return "1234:2345:/home/ccc:ccc"; },
        tagBase: (original, tag) => { effect("tag", original, tag); return undefined; },
        buildImage: (tag, name, target, expected) => { effect("build", tag, name, target, expected); return undefined; },
        removeDerivedImage: name => { effect("remove", name); return undefined; },
    };
    return { events, ports };
}

describe("whole identity image application", () => {
    it("validates before any effect and accepts cache only inside the keyed lock", () => {
        const invalid = fixture([]);
        expect(() => prepareIdentityImage("mutable:tag", identity, invalid.ports)).toThrow("immutable sha256");
        expect(invalid.events).toEqual([]);
        const { ports, events } = fixture([image()]);
        expect(prepareIdentityImage(base, identity, ports)).toBe(builtId);
        expect(events).toEqual([
            ["digest", JSON.stringify(labels)], ["lock", "known-label-hash"],
            ["inspect", "ccc-identity:known-label-hash"], ["probe", builtId], ["unlock"],
        ]);
    });

    it("tags the original bare base, builds and revalidates before returning the original bare Id", () => {
        const { ports, events } = fixture([null, image()]);
        expect(prepareIdentityImage(base, identity, ports)).toBe(builtId);
        expect(events.map(event => event[0])).toEqual(["digest", "lock", "inspect", "tag", "build", "inspect", "probe", "unlock"]);
        expect(events[3]).toEqual(["tag", base, `ccc-identity-base:${base}`]);
        expect(events[4]).toEqual(["build", `ccc-identity-base:${base}`, "ccc-identity:known-label-hash", identity, labels]);
    });

    it.each(["id", "user", "labels", "probe"])("treats invalid cached %s as a miss", field => {
        const cached = image();
        if (field === "id") cached.Id = "mutable:tag";
        if (field === "user") cached.Config!.User = "root";
        if (field === "labels") cached.Config!.Labels!["ccc.identity.gid"] = "foreign";
        const { ports, events } = fixture([cached, image()]);
        if (field === "probe") {
            let probes = 0;
            ports.observeAccount = () => { if (!probes++) throw new Error("probe failed"); return "1234:2345:/home/ccc:ccc"; };
        }
        expect(prepareIdentityImage(base, identity, ports)).toBe(builtId);
        expect(events.some(event => event[0] === "build")).toBe(true);
    });

    it.each(["tagBase", "buildImage"] as const)("propagates %s failure without removal", operation => {
        const { ports, events } = fixture([null]);
        ports[operation] = () => { throw new Error("native mutation failed"); };
        expect(() => prepareIdentityImage(base, identity, ports)).toThrow("native mutation failed");
        expect(events.some(event => event[0] === "remove")).toBe(false);
        expect(events.at(-1)).toEqual(["unlock"]);
    });

    it("removes only the invalid derived name and preserves removal error precedence", () => {
        const first = fixture([null, null]);
        expect(() => prepareIdentityImage(base, identity, first.ports)).toThrow("Built container identity image failed");
        expect(first.events.at(-2)).toEqual(["remove", "ccc-identity:known-label-hash"]);
        const second = fixture([null, null]);
        second.ports.removeDerivedImage = () => { throw new Error("remove failed"); };
        expect(() => prepareIdentityImage(base, identity, second.ports)).toThrow("remove failed");
    });

    it("keeps inspect spawning outside validation catch and field getters inside it", () => {
        const first = fixture([]);
        first.ports.inspectImage = () => { throw new Error("inspect spawn failed"); };
        expect(() => prepareIdentityImage(base, identity, first.ports)).toThrow("inspect spawn failed");
        expect(first.events.map(event => event[0])).toEqual(["digest", "lock", "unlock"]);
        const broken = { get Id(): string { throw new Error("field failed"); } };
        const second = fixture([broken, image()]);
        expect(prepareIdentityImage(base, identity, second.ports)).toBe(builtId);
    });
});
