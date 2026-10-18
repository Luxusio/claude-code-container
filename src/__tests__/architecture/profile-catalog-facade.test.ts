import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = vi.hoisted(() => ({
    roots: [] as string[], root: "", trace: [] as unknown[][],
    failureAt: "", failureOccurrence: 1, occurrences: {} as Record<string, number>,
    error: new Error("controlled native failure"), forbid: false,
}));
vi.mock("../../home-layout.js", () => ({
    DEFAULT_PROFILE_NAME: "default",
    profilesDir: () => {
        if (fixture.forbid) throw new Error("import resolved home");
        fixture.trace.push(["root"]);
        return fixture.roots.shift() ?? fixture.root;
    },
}));
vi.mock("../../utils.js", () => ({ LAB_RUNNER_PROFILE_NAME: "lab-runner" }));
vi.mock("fs", async original => {
    const actual = await original<typeof import("node:fs")>();
    const wrap = (name: "existsSync" | "mkdirSync" | "readdirSync" | "rmSync" | "writeFileSync") => (...args: unknown[]) => {
        if (fixture.forbid) throw new Error(`import called ${name}`);
        fixture.trace.push([name, ...args]);
        const count = fixture.occurrences[name] = (fixture.occurrences[name] ?? 0) + 1;
        if (fixture.failureAt === name && count === fixture.failureOccurrence) throw fixture.error;
        return (actual[name] as (...values: unknown[]) => unknown)(...args);
    };
    return { ...actual, existsSync: wrap("existsSync"), mkdirSync: wrap("mkdirSync"),
        readdirSync: wrap("readdirSync"), rmSync: wrap("rmSync"), writeFileSync: wrap("writeFileSync") };
});

const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const profile = await import("../../profile.js");
const catalog = profile.BUILTIN_PROFILES;
let root: string;
let descriptors: PropertyDescriptorMap;
let prototype: object | null;
beforeEach(() => {
    root = nativeFs.mkdtempSync(join(tmpdir(), "ccc-profile-facade-"));
    nativeFs.chmodSync(root, 0o700);
    fixture.root = join(root, "profiles"); fixture.roots = []; fixture.trace = [];
    fixture.failureAt = ""; fixture.failureOccurrence = 1; fixture.occurrences = {}; fixture.forbid = false;
    fixture.error = new Error("controlled native failure");
    descriptors = Object.getOwnPropertyDescriptors(catalog); prototype = Object.getPrototypeOf(catalog) as object | null;
});
afterEach(() => {
    fixture.forbid = false;
    // Every changed descriptor and the prototype are restored even after assertions throw.
    try {
        for (const key of Reflect.ownKeys(catalog)) Reflect.deleteProperty(catalog, key);
        Object.defineProperties(catalog, descriptors); Object.setPrototypeOf(catalog, prototype);
    } finally { nativeFs.rmSync(root, { recursive: true, force: true }); }
});
const define = (name: string, descriptor: PropertyDescriptor) => Object.defineProperty(catalog, name, { configurable: true, ...descriptor });
const effects = () => fixture.trace.filter(([name]) => name === "mkdirSync" || name === "writeFileSync" || name === "rmSync");

describe("profile catalog public native facade compatibility", () => {
    it("keeps exactly the eight runtime exports and the catalog object identity", async () => {
        expect(Object.keys(profile).sort()).toEqual(["BUILTIN_PROFILES", "createProfile", "ensureProfile", "isBuiltinProfile", "listProfiles", "profileExists", "removeProfile", "validateProfileName"].sort());
        expect((await import("../../profile.js")).BUILTIN_PROFILES).toBe(catalog);
        expect(catalog["local-llm"].settings).toEqual({ env: { CLAUDE_CODE_ATTRIBUTION_HEADER: "0" } });
        expect(catalog["lab-runner"].settings).toBeUndefined();
    });
    it("imports the facade without native effects or resolving a home", async () => {
        vi.resetModules(); fixture.forbid = true;
        try { await expect(import("../../profile.js")).resolves.toBeDefined(); }
        finally { fixture.forbid = false; }
        expect(fixture.trace).toEqual([]);
    });
    it("resolves an absent listing root once and does not create it", () => {
        expect(profile.listProfiles()).toEqual(["default"]);
        expect(fixture.trace).toEqual([["root"], ["existsSync", fixture.root]]);
        expect(nativeFs.existsSync(fixture.root)).toBe(false);
    });
    it("resolves a present listing root twice, using the second root and native directory order", () => {
        const first = join(root, "first"), second = join(root, "second");
        nativeFs.mkdirSync(first); nativeFs.mkdirSync(second);
        for (const name of ["zeta", "default", "alpha"]) nativeFs.mkdirSync(join(second, name));
        nativeFs.writeFileSync(join(second, "plain"), "fixture");
        const expected = nativeFs.readdirSync(second, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== "default").map(d => d.name);
        fixture.roots = [first, second];
        expect(profile.listProfiles()).toEqual(["default", ...expected]);
        expect(fixture.trace).toEqual([["root"], ["existsSync", first], ["root"], ["readdirSync", second, { withFileTypes: true }]]);
    });
    it("resolves roots lazily on later calls and counts plain files as existing profiles", () => {
        const one = join(root, "one"), two = join(root, "two");
        nativeFs.mkdirSync(one); nativeFs.mkdirSync(two); nativeFs.writeFileSync(join(two, "plain"), "fixture");
        fixture.root = one; expect(profile.profileExists("plain")).toBe(false);
        fixture.root = two; expect(profile.profileExists("plain")).toBe(true);
        expect(profile.listProfiles()).toEqual(["default"]);
    });
    it("keeps default query and reserved mutations free from root and catalog access", () => {
        define("default", { get: () => { throw new Error("must not read default"); } });
        expect(profile.profileExists("default")).toBe(true); expect(profile.ensureProfile("default")).toBe(false);
        expect(() => profile.createProfile("default")).toThrow('Profile "default" is reserved.');
        expect(() => profile.removeProfile("default")).toThrow('Profile "default" cannot be removed.');
        expect(fixture.trace).toEqual([]);
    });
    it("keeps skeleton write order, modes, bytes and deferred serialization", () => {
        const settings = { toJSON() { fixture.trace.push(["serialize"]); return { env: { FIXTURE: "value" } }; } };
        profile.createProfile("work", settings);
        const base = join(fixture.root, "work"), claude = join(base, "claude");
        expect(fixture.trace).toEqual([["root"], ["mkdirSync", claude, { recursive: true, mode: 0o700 }],
            ["mkdirSync", join(base, "codex"), { recursive: true, mode: 0o700 }],
            ["writeFileSync", join(base, "claude.json"), "{}", { mode: 0o600 }], ["serialize"],
            ["writeFileSync", join(claude, "settings.json"), JSON.stringify({ env: { FIXTURE: "value" } }, null, 2), { mode: 0o600 }]]);
        expect(nativeFs.readFileSync(join(base, "claude.json"), "utf8")).toBe("{}");
        if (process.platform !== "win32") {
            for (const dir of [claude, join(base, "codex")]) expect(nativeFs.statSync(dir).mode & 0o777).toBe(0o700);
            for (const file of [join(base, "claude.json"), join(claude, "settings.json")]) expect(nativeFs.statSync(file).mode & 0o777).toBe(0o600);
        }
    });
    it.each([undefined, null, false, 0, ""])("retains the runtime falsy settings branch (%s)", settings => {
        profile.createProfile("work", settings as never);
        expect(effects()).toHaveLength(3);
        expect(nativeFs.existsSync(join(fixture.root, "work", "claude", "settings.json"))).toBe(false);
    });
    it.each([["mkdirSync", 1, 0], ["mkdirSync", 2, 1], ["writeFileSync", 1, 2], ["writeFileSync", 2, 3]] as const)("propagates native %s failure %i unchanged and keeps preceding effects", (name, occurrence, completed) => {
        fixture.failureAt = name; fixture.failureOccurrence = occurrence;
        let thrown: unknown; try { profile.createProfile("work", { env: { FIXTURE: "value" } }); } catch (error) { thrown = error; }
        expect(thrown).toBe(fixture.error); expect(effects()).toHaveLength(completed + 1);
        const base = join(fixture.root, "work");
        expect(nativeFs.existsSync(join(base, "claude"))).toBe(completed >= 1);
        expect(nativeFs.existsSync(join(base, "codex"))).toBe(completed >= 2);
        expect(nativeFs.existsSync(join(base, "claude.json"))).toBe(completed >= 3);
    });
    it("retains a skeleton after serialization throws and preserves the thrown value", () => {
        const error = { fixture: "serialization" };
        let thrown: unknown; try { profile.createProfile("work", { toJSON() { throw error; } }); } catch (value) { thrown = value; }
        expect(thrown).toBe(error); expect(effects()).toHaveLength(3);
        expect(nativeFs.readFileSync(join(fixture.root, "work", "claude.json"), "utf8")).toBe("{}");
        expect(nativeFs.existsSync(join(fixture.root, "work", "codex"))).toBe(true);
        expect(nativeFs.existsSync(join(fixture.root, "work", "claude", "settings.json"))).toBe(false);
    });
    it("preserves circular serialization failure after the skeleton", () => {
        const settings: Record<string, unknown> = {}; settings.self = settings;
        expect(() => profile.createProfile("work", settings)).toThrow(TypeError); expect(effects()).toHaveLength(3);
    });
    it.each(["existsSync", "readdirSync", "rmSync"] as const)("propagates query/removal %s error identity", name => {
        nativeFs.mkdirSync(fixture.root); fixture.failureAt = name;
        let thrown: unknown; try { if (name === "rmSync") profile.removeProfile("work"); else profile.listProfiles(); } catch (error) { thrown = error; }
        expect(thrown).toBe(fixture.error);
    });
    it.each(["..", "./default"])("refuses removal of %j while preserving default credentials and the parent sentinel", name => {
        // Both aliases resolve inside this test's entirely owned root, even on the unfixed facade.
        const credentials = join(fixture.root, "default", "claude.json");
        const sentinel = join(root, "parent-sentinel.txt");
        nativeFs.mkdirSync(join(fixture.root, "default"), { recursive: true });
        nativeFs.writeFileSync(credentials, '{"fixture":"default credentials"}');
        nativeFs.writeFileSync(sentinel, "owned parent sentinel");

        expect(() => profile.removeProfile(name)).toThrow(`Invalid profile name "${name}".`);

        expect(nativeFs.readFileSync(credentials, "utf8")).toBe('{"fixture":"default credentials"}');
        expect(nativeFs.readFileSync(sentinel, "utf8")).toBe("owned parent sentinel");
        expect(fixture.trace).toEqual([]);
    });
    it("removes an admitted custom profile while preserving default credentials", () => {
        const credentials = join(fixture.root, "default", "claude.json");
        const custom = join(fixture.root, "work");
        nativeFs.mkdirSync(join(fixture.root, "default"), { recursive: true });
        nativeFs.mkdirSync(custom);
        nativeFs.writeFileSync(credentials, '{"fixture":"default credentials"}');
        nativeFs.writeFileSync(join(custom, "claude.json"), '{"fixture":"custom credentials"}');

        profile.removeProfile("work");

        expect(nativeFs.existsSync(custom)).toBe(false);
        expect(nativeFs.readFileSync(credentials, "utf8")).toBe('{"fixture":"default credentials"}');
    });
    it("removes with recursive force without an existence probe", () => {
        profile.removeProfile("absent");
        expect(fixture.trace).toEqual([["root"], ["rmSync", join(fixture.root, "absent"), { recursive: true, force: true }]]);
    });
    it.each([undefined, null])("recognizes an own unusable catalog value (%s) then retains TypeError before writes", value => {
        define("mutable", { value }); expect(profile.isBuiltinProfile("mutable")).toBe(true);
        expect(() => profile.ensureProfile("mutable")).toThrow(TypeError); expect(effects()).toEqual([]);
        expect(fixture.trace).toEqual([["root"], ["existsSync", join(fixture.root, "mutable")]]);
    });
    it("does not evaluate built-in getters for membership or an existing profile", () => {
        const getter = vi.fn(() => { throw fixture.error; }); define("mutable", { get: getter });
        expect(profile.isBuiltinProfile("mutable")).toBe(true); expect(getter).not.toHaveBeenCalled();
        nativeFs.mkdirSync(fixture.root); nativeFs.writeFileSync(join(fixture.root, "mutable"), "fixture");
        expect(profile.ensureProfile("mutable")).toBe(false); expect(getter).not.toHaveBeenCalled(); expect(effects()).toEqual([]);
    });
    it("reads the current value and settings exactly once, after existence and before creation", () => {
        define("mutable", { get() { fixture.trace.push(["catalog-value"]); return { get settings() { fixture.trace.push(["settings"]); return { env: { FIXTURE: "current" } }; } }; } });
        expect(profile.ensureProfile("mutable")).toBe(true);
        expect(fixture.trace.slice(0, 5)).toEqual([["root"], ["existsSync", join(fixture.root, "mutable")], ["catalog-value"], ["settings"], ["root"]]);
        expect(fixture.trace.filter(([name]) => name === "catalog-value" || name === "settings")).toEqual([["catalog-value"], ["settings"]]);
    });
    it.each(["value", "settings"])("propagates a throwing built-in %s getter by identity before writes", kind => {
        define("mutable", kind === "value" ? { get() { throw fixture.error; } } : { value: { get settings() { throw fixture.error; } } });
        let thrown: unknown; try { profile.ensureProfile("mutable"); } catch (error) { thrown = error; }
        expect(thrown).toBe(fixture.error); expect(effects()).toEqual([]);
    });
    it("rejects inherited entries without evaluating their getters", () => {
        const getter = vi.fn(() => { throw fixture.error; });
        const inherited = Object.create(prototype) as object; Object.defineProperty(inherited, "inherited", { get: getter }); Object.setPrototypeOf(catalog, inherited);
        expect(profile.isBuiltinProfile("inherited")).toBe(false);
        expect(() => profile.ensureProfile("inherited")).toThrow('Profile "inherited" does not exist. Create it with: ccc profile add inherited');
        expect(getter).not.toHaveBeenCalled(); expect(effects()).toEqual([]);
    });
});
