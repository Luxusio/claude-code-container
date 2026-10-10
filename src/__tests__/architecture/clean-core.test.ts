import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { CleanPorts, CleanMutationPorts } from "../../ports/clean.js";
import type { CleanOptions, CleanInventoryResult } from "../../domain/clean.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ID = "aabbccddeeff";
function setup() {
    const trace: unknown[] = []; let denied = 0; const fault = { identity: "raw" };
    const deny = (site: string): never => { denied++; throw new Error(`Denied ${site}`); };
    const fence = (site: string) => new Proxy({}, { get: (_target, key) => deny(`${site}.${String(key)}`) });
    const cache = new Map<string, Record<string, unknown>>();
    function load(file: string): Record<string, unknown> {
        if (cache.has(file)) return cache.get(file)!;
        const exports = {}; cache.set(file, exports);
        const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        const requireModule = (name: string) => {
            const target = resolve(dirname(file), name.replace(/\.js$/, ".ts"));
            if (![resolve(root, "src/domain/clean.ts"), resolve(root, "src/ports/clean.ts")].includes(target)) return deny(`import ${name}`);
            return load(target);
        };
        runInNewContext(code, { exports, require: requireModule, console: fence("console"), process: fence("process"), Buffer: fence("Buffer"), fetch: () => deny("fetch"), setTimeout: () => deny("timer"), setInterval: () => deny("timer"), setImmediate: () => deny("timer") }, { filename: file, timeout: 1000 });
        return exports;
    }
    const createClean = load(resolve(root, "src/application/clean.ts")).createClean as (ports: CleanPorts) => (options: CleanOptions) => Promise<void>;
    const raw = (stdout = ""): CleanInventoryResult => ({ stdout, status: 0 });
    const mutation: CleanMutationPorts = {
        stopContainer: id => { trace.push(["stop", id]); return { status: 0 }; },
        removeContainer: id => { trace.push(["rm", id]); return { status: 0 }; },
        removeImage: id => { trace.push(["rmi", id]); return { status: 0 }; },
        removeVolume: name => { trace.push(["volume-rm", name]); return { status: 0 }; },
    };
    const ports: CleanPorts = {
        ensureRuntimeReady: () => { trace.push("ready"); },
        observeContainers: () => { trace.push("containers"); return raw(`${ID}\tccc-target\tUp 1 minute`); },
        observeImages: repo => { trace.push(["images", repo]); return raw(); },
        registryImage: "registry/ccc",
        observeVolumes: () => { trace.push("volumes"); return raw(); },
        confirm: async () => { trace.push("prompt"); return "yes"; },
        captureMutationRuntime: () => { trace.push("mutation:capture"); return mutation; },
        withLifecycleLock: (prefix, operation) => { trace.push(["lock", prefix]); const value = operation(); expect(value).toBeUndefined(); },
        sessionClaims: prefix => { trace.push(["claims", prefix]); return []; },
        capturePublication: () => { trace.push("publication:capture"); return text => { trace.push(["publish", text]); }; },
        exitSuccess: () => { trace.push("exit"); throw fault; },
    };
    async function run(options: CleanOptions = { all: true, yes: true }, replacement: Partial<CleanPorts> = {}) {
        let error: unknown;
        try { await createClean({ ...ports, ...replacement })(options); } catch (caught) { error = caught; }
        finally { expect(denied, "zero denied effects after every positive or thrown case").toBe(0); }
        return error;
    }
    return { createClean, ports, mutation, raw, run, trace, fault, checkFence: () => expect(denied).toBe(0) };
}
describe("complete inward clean policy", () => {
    it("constructs without observing lazy ports and retains async public identity", () => {
        const f = setup(); let reads = 0;
        const ports = new Proxy(f.ports, { get(target, key) { reads++; return Reflect.get(target, key); } });
        const clean = f.createClean(ports); expect(reads).toBe(0); expect(clean.name).toBe("cleanContainers"); expect(clean.length).toBe(1);
        f.checkFence();
    });
    it("default excludes the exact running ID; all stops then removes it inside one synchronous lock", async () => {
        const a = setup(); await a.run({ yes: true }); expect(a.trace).not.toContainEqual(["rm", ID]); expect(a.trace).not.toContainEqual(["stop", ID]);
        const b = setup(); expect(await b.run()).toBe(b.fault);
        const selected = b.trace.filter(item => Array.isArray(item) && ["lock", "claims", "stop", "rm"].includes(String(item[0])));
        expect(selected).toEqual([["lock", "target"], ["claims", "target"], ["stop", ID], ["rm", ID]]);
    });
    it.each(["", "n", "YES", false, undefined, null, " yes "])("declines unnormalized prompt %j without capture/mutation/exit", async answer => {
        const f = setup(); await f.run({ all: true }, { confirm: (() => Promise.resolve(answer)) as unknown as CleanPorts["confirm"] });
        expect(f.trace).toContainEqual(["publish", "Aborted."]); expect(f.trace).not.toContain("mutation:capture"); expect(f.trace).not.toContain("exit");
    });
    it.each(["y", "yes"])("accepts exact prompt %s after its only asynchronous boundary", async answer => {
        const f = setup(); let release!: (value: string) => void;
        const pending = f.run({ all: true }, { confirm: () => new Promise(resolve => { release = resolve; }) });
        expect(f.trace).not.toContain("mutation:capture"); release(answer); expect(await pending).toBe(f.fault); expect(f.trace).toContainEqual(["rm", ID]);
    });
    it("propagates rejected confirmation by identity", async () => {
        const f = setup(); expect(await f.run({ all: true }, { confirm: () => Promise.reject(f.fault) })).toBe(f.fault); expect(f.trace).not.toContain("mutation:capture");
    });

    it("retains raw claim veto including malformed/stale/profile claims while images continue", async () => {
        const f = setup(); await f.run(undefined, { sessionClaims: () => ["not-a-pid.profile-old.lock"], observeImages: () => f.raw("ccc\ti\t1MB") });
        expect(f.trace).not.toContainEqual(["stop", ID]); expect(f.trace).not.toContainEqual(["rm", ID]); expect(f.trace).toContainEqual(["rmi", "i"]);
        expect(f.trace).toContainEqual(["publish", "\nDone. Removed 1 item(s)."]);
    });
    it("empty prefix remains a refusal before lock/claims/deletion", async () => {
        const f = setup(); const error = await f.run(undefined, { observeContainers: () => f.raw(`${ID}\tccc-\tExited`) });
        expect(error).toHaveProperty("message", "Refusing to clean unmanaged container name: ccc-");
        expect(f.trace.some(item => Array.isArray(item) && ["lock", "claims", "rm"].includes(String(item[0])))).toBe(false);
    });
    it("retains duplicate container rows and name-based stop membership", async () => {
        const f = setup(); await f.run(undefined, { observeContainers: () => f.raw(`${ID}\tccc-target\tUp\n001122334455\tccc-target\tExited`) });
        expect(f.trace.filter(item => Array.isArray(item) && ["stop", "rm"].includes(String(item[0])))).toEqual([["stop", ID], ["rm", ID], ["stop", "001122334455"], ["rm", "001122334455"]]);
    });
    it("first mutation failure preserves earlier effects and denies every later ID/image/volume and summary", async () => {
        const f = setup(); const mutation = { ...f.mutation, removeContainer: (id: string) => { f.trace.push(["rm", id]); return { status: id === "001122334455" ? 7 : 0 }; } };
        await f.run(undefined, { observeContainers: () => f.raw(`${ID}\tccc-one\tExited\n001122334455\tccc-two\tExited\nffeeddccbbaa\tccc-three\tExited`), observeImages: () => f.raw("ccc\ti\t1MB"), observeVolumes: () => f.raw("ccc-volume"), captureMutationRuntime: () => mutation });
        expect(f.trace.filter(item => Array.isArray(item) && ["rm", "rmi", "volume-rm"].includes(String(item[0])))).toEqual([["rm", ID], ["rm", "001122334455"]]);
        expect(f.trace).not.toContain("exit"); expect(f.trace.some(item => Array.isArray(item) && item[0] === "publish" && String(item[1]).includes("Done."))).toBe(false);
    });

    it("raw publication/callback/exit exceptions retain identity", async () => {
        for (const site of ["publication", "lock", "claim", "exit"] as const) {
            const f = setup(); const overrides: Partial<CleanPorts> = site === "publication" ? { capturePublication: () => { throw f.fault; } } : site === "lock" ? { withLifecycleLock: () => { throw f.fault; } } : site === "claim" ? { sessionClaims: () => { throw f.fault; } } : {};
            expect(await f.run(undefined, overrides)).toBe(f.fault);
        }
    });

    it.each([null, undefined, ""])("successful nullish/empty stdout %j remains an empty inventory", async stdout => {
        const f = setup(); await f.run({ all: true }, { observeContainers: () => ({ status: 0, stdout }), observeImages: () => ({ status: 0, stdout }), observeVolumes: () => ({ status: 0, stdout }) });
        expect(f.trace).toContainEqual(["publish", "Nothing to clean."]); expect(f.trace).not.toContain("mutation:capture"); expect(f.trace).not.toContain("prompt"); expect(f.trace).not.toContain("exit");
    });
    it("keeps duplicate volume rows, permissive image IDs and first-ID ordering", async () => {
        const f = setup(); let query = 0;
        await f.run({ all: true, yes: true }, { observeContainers: () => f.raw(), observeImages: () => f.raw(++query === 1 ? " repo \t not-hex \t 1MB \nrepo\tsecond\t2MB" : "other\tnot-hex\t9MB\nother\tthird\t3MB"), observeVolumes: () => f.raw(" v \n\nv\n foreign ") });
        expect(f.trace.filter(item => Array.isArray(item) && ["rmi", "volume-rm"].includes(String(item[0])))).toEqual([["rmi", "not-hex"], ["rmi", "second"], ["rmi", "third"], ["volume-rm", "v"], ["volume-rm", "v"], ["volume-rm", "foreign"]]);
    });
    it("retains exact 12–64 case-insensitive hex/prefix parsing and tab status rules", async () => {
        const f = setup(); const long = "A".repeat(64);
        const inventory = [`  ABCDEF123456 \t ccc-upper \tExited\t (0)  `, `${long}\tccc-long\tUPstream`, `${"a".repeat(11)}\tccc-short\tExited`, `${"b".repeat(65)}\tccc-too-long\tExited`, "not-hex\tccc-bad\tExited", `${ID}\tCCC-uppercase-prefix\tExited`].join("\n");
        await f.run({ yes: true }, { observeContainers: () => f.raw(inventory) });
        expect(f.trace.filter(item => Array.isArray(item) && item[0] === "rm")).toEqual([["rm", "ABCDEF123456"]]);
        expect(f.trace).toContainEqual(["publish", "  ccc-upper  (Exited\t (0))"]);
    });
    it("missing options is not silently defaulted", async () => {
        const f = setup(); let error: unknown;
        try { await f.createClean(f.ports)(undefined as unknown as CleanOptions); } catch (caught) { error = caught; }
        finally { f.checkFence(); }
        expect(error).toHaveProperty("name", "TypeError"); expect(f.trace).not.toContain("mutation:capture");
    });
});
