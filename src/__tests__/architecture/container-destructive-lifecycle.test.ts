import { describe, expect, it } from "vitest";
import { createContainerDestructiveLifecycle } from "../../application/container-destructive-lifecycle.js";
import type {
    ContainerDestructiveLifecycleOptions,
    ContainerDestructiveLifecyclePorts,
    DestructiveContainerIdentity,
} from "../../ports/container-destructive-lifecycle.js";

function fixture() {
    const trace: string[] = [];
    const state = {
        claims: [] as string[],
        identity: { containerId: "pinned-id", running: true } as DestructiveContainerIdentity | null,
        cleanupError: undefined as unknown,
    };
    let resolutions = 0;
    const effect = (event: string): undefined => { trace.push(event); return undefined; };
    const ports: ContainerDestructiveLifecyclePorts = {
        resolvePath: path => { trace.push(`resolve:${path}`); return `/full/${++resolutions}`; },
        projectId: path => { trace.push(`project:${path}`); return "project-id"; },
        containerName: (path, profile) => { trace.push(`name:${path}:${String(profile)}`); return "container-name"; },
        withLifecycleLock: (prefix, operation) => {
            effect(`lock:${prefix}`);
            operation();
            return effect("unlock");
        },
        sessionClaims: prefix => { trace.push(`claims:${prefix}`); return state.claims; },
        ensureRuntime: () => effect("runtime"),
        managedIdentity: (name, path) => { trace.push(`identity:${name}:${path}`); return state.identity; },
        cleanupDevices: (path, timeout, profile) => {
            effect(`cleanup:${path}:${timeout}:${String(profile)}`);
            if (state.cleanupError !== undefined) throw state.cleanupError;
            return undefined;
        },
        stop: id => effect(`stop:${id}`),
        remove: id => effect(`remove:${id}`),
        reportNotFound: () => effect("not-found"),
        reportStopping: (name, path) => effect(`stopping:${name}:${path}`),
        reportStopped: () => effect("stopped"),
        reportRemoving: (name, path) => effect(`removing:${name}:${path}`),
        reportRemoved: () => effect("removed"),
        reportDeviceCleanupFailure: error => effect(`cleanup-warning:${String(error)}`),
        throwSessionClaims: (count, path) => { trace.push(`refuse:${count}:${path}`); throw new Error(`claimed:${count}`); },
    };
    return { trace, state, ports, app: createContainerDestructiveLifecycle(ports) };
}

const guard = ["resolve:input", "project:/full/1", "lock:project-id", "claims:project-id", "runtime"];
const stopProof = ["resolve:input", "name:/full/2:undefined", "identity:container-name:/full/2"];
const removeProof = ["resolve:input", "name:/full/2:undefined", "resolve:input", "identity:container-name:/full/3"];
const stopRunning = [...guard, ...stopProof, "cleanup:/full/2:5000:undefined", "stopping:container-name:/full/2", "stop:pinned-id", "stopped", "unlock"];
const removeRunning = [...guard, ...removeProof, "resolve:input", "cleanup:/full/4:5000:undefined", "stopping:container-name:/full/3", "stop:pinned-id", "stopped", "removing:container-name:/full/3", "remove:pinned-id", "removed", "unlock"];

function throwsSame(operation: () => unknown, failure: unknown): void {
    try {
        operation();
        throw new Error("expected the original failure");
    } catch (error) {
        expect(error).toBe(failure);
    }
}

describe("required destructive lifecycle capabilities", () => {
    it("constructs without effects and rejects every missing or noncallable capability", () => {
        const f = fixture();
        for (const name of Object.keys(f.ports)) {
            const absent: Record<string, unknown> = { ...f.ports };
            delete absent[name];
            expect(() => createContainerDestructiveLifecycle(absent as unknown as ContainerDestructiveLifecyclePorts)).toThrow(`callable ${name}`);
            for (const invalid of [undefined, null, false, 1, "function", {}]) {
                expect(() => createContainerDestructiveLifecycle({ ...f.ports, [name]: invalid } as unknown as ContainerDestructiveLifecyclePorts)).toThrow(`callable ${name}`);
            }
        }
        for (const invalid of [undefined, null, {}]) {
            expect(() => createContainerDestructiveLifecycle(invalid as ContainerDestructiveLifecyclePorts)).toThrow(TypeError);
        }
        expect(f.trace).toEqual([]);
    });

});

describe("destructive claim authorization", () => {
    it.each(["stop", "remove"] as const)("%s reads force only after nonempty raw claims", operation => {
        const f = fixture();
        const options = { get force(): boolean { f.trace.push("force-read"); throw new Error("force-read"); } };
        f.app[operation]("input", undefined, options);
        expect(f.trace).not.toContain("force-read");
        f.trace.length = 0;
        f.state.claims = ["raw-stale-claim", "raw-live-claim"];
        expect(() => f.app[operation]("input", undefined, options)).toThrow("force-read");
        expect(f.trace).toEqual(["resolve:input", `project:/full/${operation === "stop" ? 3 : 5}`, "lock:project-id", "claims:project-id", "force-read"]);
    });

    it.each(["stop", "remove"] as const)("%s accepts only exact force true", operation => {
        for (const force of [undefined, false, 0, 1, "true", {}, true]) {
            const f = fixture(); f.state.claims = ["claim", "claim-2"];
            const run = () => f.app[operation]("input", undefined, { force } as ContainerDestructiveLifecycleOptions);
            if (force === true) {
                expect(run()).toBeUndefined();
                expect(f.trace).toEqual(operation === "stop" ? stopRunning : removeRunning);
            } else {
                expect(run).toThrow("claimed:2");
                expect(f.trace).toEqual(["resolve:input", "project:/full/1", "lock:project-id", "claims:project-id", "refuse:2:/full/1"]);
            }
        }
    });

    it.each(["stop", "remove"] as const)("%s retains the options reference across the claim callback", operation => {
        for (const updatedForce of [true, false]) {
            const f = fixture();
            const options = { force: !updatedForce };
            f.ports.sessionClaims = prefix => {
                f.trace.push(`claims:${prefix}`); options.force = updatedForce; return ["claim"];
            };
            if (updatedForce) expect(f.app[operation]("input", undefined, options)).toBeUndefined();
            else expect(() => f.app[operation]("input", undefined, options)).toThrow("claimed:1");
            expect(f.trace.includes("runtime")).toBe(updatedForce);
        }
    });

    it.each(["stop", "remove"] as const)("%s preserves absent, empty and populated profile values", operation => {
        for (const profile of [undefined, "", "dev"]) {
            const f = fixture(); f.app[operation]("input", profile);
            const prefix = profile ? "project-id--p--dev" : "project-id";
            expect(f.trace.slice(0, 5)).toEqual(["resolve:input", "project:/full/1", `lock:${prefix}`, `claims:${prefix}`, "runtime"]);
            expect(f.trace).toContain(`name:/full/2:${String(profile)}`);
            expect(f.trace).toContain(`cleanup:/full/${operation === "stop" ? 2 : 4}:5000:${String(profile)}`);
        }
    });
});

describe("critical section callback semantics", () => {
    it.each(["stop", "remove"] as const)("%s performs no guarded work without a callback and discards incidental return", operation => {
        const f = fixture();
        f.ports.withLifecycleLock = ((prefix: string) => {
            f.trace.push(`lock:${prefix}`); return "incidental";
        }) as unknown as ContainerDestructiveLifecyclePorts["withLifecycleLock"];
        expect(f.app[operation]("input")).toBeUndefined();
        expect(f.trace).toEqual(["resolve:input", "project:/full/1", "lock:project-id"]);
    });

    it.each(["stop", "remove"] as const)("%s preserves deferred and repeated lock callbacks", operation => {
        const f = fixture(); let callback: () => undefined = () => undefined;
        f.ports.withLifecycleLock = (prefix, supplied) => {
            f.trace.push(`lock:${prefix}`); callback = supplied; return undefined;
        };
        const options = { force: false };
        expect(f.app[operation]("input", undefined, options)).toBeUndefined();
        expect(f.trace).toEqual(["resolve:input", "project:/full/1", "lock:project-id"]);
        f.state.claims = ["claim"];
        expect(callback).toThrow("claimed:1");
        options.force = true;
        expect(callback()).toBeUndefined();
        f.state.identity = null;
        expect(callback()).toBeUndefined();
        expect(f.trace.filter(event => event === "claims:project-id")).toHaveLength(3);
        expect(f.trace.filter(event => event === "runtime")).toHaveLength(2);
        expect(f.trace.at(-1)).toBe("not-found");
        expect(f.trace.filter(event => event === "stop:pinned-id")).toHaveLength(1);
    });

    it.each(["stop", "remove"] as const)("%s preserves lock failure after the completed native effect", operation => {
        const f = fixture(); const failure = { failure: "unlock" };
        f.ports.withLifecycleLock = (_prefix, callback) => { callback(); throw failure; };
        throwsSame(() => f.app[operation]("input"), failure);
        expect(f.trace).toContain(operation === "stop" ? "stopped" : "removed");
    });
});

describe("ordered managed destruction", () => {
    it("stops by proven ID and reuses its single runtime path", () => {
        const f = fixture(); expect(f.app.stop("input")).toBeUndefined();
        expect(f.trace).toEqual(stopRunning);
    });
    it("removes by proven ID with three independent runtime path observations", () => {
        const f = fixture(); expect(f.app.remove("input")).toBeUndefined();
        expect(f.trace).toEqual(removeRunning);
    });
    it("cleans an already stopped container and still reports stopped", () => {
        const f = fixture(); f.state.identity!.running = false; f.app.stop("input");
        expect(f.trace).toEqual([...guard, ...stopProof, "cleanup:/full/2:5000:undefined", "stopped", "unlock"]);
    });
    it("removes an already stopped container without a stopped presentation", () => {
        const f = fixture(); f.state.identity!.running = false; f.app.remove("input");
        expect(f.trace).toEqual([...guard, ...removeProof, "resolve:input", "cleanup:/full/4:5000:undefined", "removing:container-name:/full/3", "remove:pinned-id", "removed", "unlock"]);
    });
    it.each(["stop", "remove"] as const)("%s refuses an unavailable managed identity even when forced", operation => {
        const f = fixture(); f.state.identity = null; f.state.claims = ["claim"];
        f.app[operation]("input", undefined, { force: true });
        expect(f.trace).toEqual([...guard, ...(operation === "stop" ? stopProof : removeProof), "not-found", "unlock"]);
    });
    it.each(["stop", "remove"] as const)("%s continues after Error and non-Error cleanup failures", operation => {
        for (const failure of [new Error("cleanup"), "cleanup", null, { cleanup: false }]) {
            const f = fixture(); f.state.cleanupError = failure; f.app[operation]("input");
            const expected = [...(operation === "stop" ? stopRunning : removeRunning)];
            expected.splice(expected.findIndex(event => event.startsWith("cleanup:")) + 1, 0, `cleanup-warning:${String(failure)}`);
            expect(f.trace).toEqual(expected);
        }
    });
    it.each(["stop", "remove"] as const)("%s propagates warning failure and prevents native dispatch", operation => {
        const f = fixture(); const failure = { failure: "warning" };
        f.state.cleanupError = new Error("cleanup");
        f.ports.reportDeviceCleanupFailure = error => {
            expect(error).toBe(f.state.cleanupError); f.trace.push("warning"); throw failure;
        };
        throwsSame(() => f.app[operation]("input"), failure);
        expect(f.trace.at(-1)).toBe("warning");
        expect(f.trace.some(event => event.startsWith("stop:") || event.startsWith("remove:"))).toBe(false);
    });
    it.each(["stop", "remove"] as const)("%s refreshes all facts on a subsequent invocation", operation => {
        const f = fixture(); f.app[operation]("input"); f.trace.length = 0;
        f.state.claims = ["new-claim"];
        expect(() => f.app[operation]("input")).toThrow("claimed:1");
        expect(f.trace).not.toContain("runtime"); f.trace.length = 0;
        f.state.claims = []; f.state.identity = { containerId: "successor-id", running: true };
        f.app[operation]("input");
        expect(f.trace).toContain("stop:successor-id");
        if (operation === "remove") expect(f.trace).toContain("remove:successor-id");
        expect(f.trace).not.toContain("stop:pinned-id");
    });
});

describe("fallible capability boundaries", () => {
    const cases: Array<["stop" | "remove", keyof ContainerDestructiveLifecyclePorts, number]> = [];
    for (const operation of ["stop", "remove"] as const) {
        for (const port of ["resolvePath", "projectId", "withLifecycleLock", "sessionClaims", "ensureRuntime", "containerName", "managedIdentity", "reportStopping", "stop", "reportStopped"] as const) {
            cases.push([operation, port, 1]);
        }
        cases.push([operation, "resolvePath", 2]);
    }
    cases.push(["remove", "resolvePath", 3], ["remove", "resolvePath", 4], ["remove", "reportRemoving", 1], ["remove", "remove", 1], ["remove", "reportRemoved", 1]);

    it.each(cases)("%s propagates %s failure at call %s without later effects", (operation, port, atCall) => {
        const f = fixture(); const failure = { port, atCall };
        const baseline = operation === "stop" ? stopRunning : removeRunning;
        const original = f.ports[port]; let calls = 0;
        Object.assign(f.ports, { [port]: function (this: ContainerDestructiveLifecyclePorts, ...args: unknown[]) {
            if (++calls === atCall) { f.trace.push(`failure:${port}`); throw failure; }
            return Reflect.apply(original, this, args);
        } });
        throwsSame(() => f.app[operation]("input"), failure);
        const eventForPort: Partial<Record<keyof ContainerDestructiveLifecyclePorts, string>> = {
            resolvePath: "resolve:input", projectId: "project:/full/1", withLifecycleLock: "lock:project-id",
            sessionClaims: "claims:project-id", ensureRuntime: "runtime", containerName: "name:/full/2:undefined",
            managedIdentity: operation === "stop" ? "identity:container-name:/full/2" : "identity:container-name:/full/3",
            reportStopping: `stopping:container-name:/full/${operation === "stop" ? 2 : 3}`, stop: "stop:pinned-id", reportStopped: "stopped",
            reportRemoving: "removing:container-name:/full/3", remove: "remove:pinned-id", reportRemoved: "removed",
        };
        let seen = 0;
        const index = baseline.findIndex(event => event === eventForPort[port] && ++seen === atCall);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(f.trace).toEqual([...baseline.slice(0, index), `failure:${port}`]);
    });

    it.each(["stop", "remove"] as const)("%s propagates missing-identity presentation failure", operation => {
        const f = fixture(); f.state.identity = null; const failure = new Error("not-found-log");
        f.ports.reportNotFound = () => { throw failure; };
        expect(() => f.app[operation]("input")).toThrow(failure);
        expect(f.trace).toEqual([...guard, ...(operation === "stop" ? stopProof : removeProof)]);
    });
});
