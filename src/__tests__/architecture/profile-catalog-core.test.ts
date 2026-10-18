import { describe, expect, it, vi } from "vitest";
import { createProfileCatalog, validateProfileName } from "../../application/profile-catalog.js";
import type { ProfileCatalogPorts, ProfileSettings } from "../../ports/profile-catalog.js";

const defaultName = "injected-default";
const portNames = ["listProfileDirectoryNames", "profileEntryExists", "writeProfile", "removeProfileDirectory", "hasBuiltinProfile", "readBuiltinSettings"] as const;
function ports() {
    return {
        listProfileDirectoryNames: vi.fn<ProfileCatalogPorts["listProfileDirectoryNames"]>(() => []),
        profileEntryExists: vi.fn<ProfileCatalogPorts["profileEntryExists"]>(() => false),
        writeProfile: vi.fn<ProfileCatalogPorts["writeProfile"]>(),
        removeProfileDirectory: vi.fn<ProfileCatalogPorts["removeProfileDirectory"]>(),
        hasBuiltinProfile: vi.fn<ProfileCatalogPorts["hasBuiltinProfile"]>(() => false),
        readBuiltinSettings: vi.fn<ProfileCatalogPorts["readBuiltinSettings"]>(() => undefined),
    };
}
function thrown(action: () => unknown): unknown {
    try { action(); } catch (error) { return error; }
    throw new Error("Expected action to throw");
}
function untouched(bindings: ReturnType<typeof ports>) {
    for (const binding of Object.values(bindings)) expect(binding).not.toHaveBeenCalled();
}

describe("profile catalog pure policy", () => {
    it.each(portNames)("requires callable %s without invoking any port", name => {
        for (const invalid of [undefined, null, false, 0, {}, "function"]) {
            const bindings = ports();
            const error = thrown(() => createProfileCatalog({ ...bindings, [name]: invalid } as unknown as ProfileCatalogPorts, defaultName));
            expect(error).toBeInstanceOf(TypeError);
            expect((error as Error).message).toContain(name);
            untouched(bindings);
        }
    });
    it("constructs without reading native state or invoking bindings", () => {
        const bindings = ports();
        createProfileCatalog(bindings, defaultName);
        untouched(bindings);
    });
    it.each(["a", "0", "local-llm", "a._-09", "a".repeat(64)])("accepts unchanged name syntax %s", name => {
        expect(validateProfileName(name)).toBe(true);
        const bindings = ports();
        expect(createProfileCatalog(bindings, defaultName).validate(name)).toBe(true);
        untouched(bindings);
    });
    it.each(["", "A", "aA", " a", "a ", "a/b", "a\\b", ".a", "_a", "-a", "한글", "a\nb", "a".repeat(65)])("rejects unchanged name syntax %j", name => {
        expect(validateProfileName(name)).toBe(false);
        const bindings = ports();
        expect(createProfileCatalog(bindings, defaultName).validate(name)).toBe(false);
        untouched(bindings);
    });
    it.each(["..", "../outside", "./default", "a/b", "a\\b", "/absolute", "C:\\absolute", "", "UPPER", "a".repeat(65)])("refuses invalid identity %j before native ports or settings evaluation", name => {
        const bindings = ports();
        const settingsRead = vi.fn(() => { throw new Error("must not evaluate invalid profile settings"); });
        const settings = Object.defineProperties({}, {
            env: { get: settingsRead },
            toJSON: { get: settingsRead },
        }) as ProfileSettings;
        const app = createProfileCatalog(bindings, defaultName);

        expect(app.exists(name)).toBe(false);
        expect(app.isBuiltin(name)).toBe(false);
        const message = `Invalid profile name "${name}".`;
        expect(() => app.create(name, settings)).toThrow(message);
        expect(() => app.ensure(name)).toThrow(message);
        expect(() => app.remove(name)).toThrow(message);
        expect(settingsRead).not.toHaveBeenCalled();
        untouched(bindings);
    });
    it("prepends the injected default, filtering only exact default entries without sorting or deduplication", () => {
        const bindings = ports();
        const names = ["z", defaultName, "a", "z", "default", defaultName];
        bindings.listProfileDirectoryNames.mockReturnValue(names);
        expect(createProfileCatalog(bindings, defaultName).list()).toEqual([defaultName, "z", "a", "z", "default"]);
        expect(names).toEqual(["z", defaultName, "a", "z", "default", defaultName]);
        expect(bindings.listProfileDirectoryNames).toHaveBeenCalledExactlyOnceWith();
    });
    it("lists only the injected default when native listing is empty", () => {
        expect(createProfileCatalog(ports(), defaultName).list()).toEqual([defaultName]);
    });
    it("short-circuits default existence and ensure without any catalog or IO effects", () => {
        const bindings = ports();
        const app = createProfileCatalog(bindings, defaultName);
        expect(app.exists(defaultName)).toBe(true);
        expect(app.ensure(defaultName)).toBe(false);
        untouched(bindings);
    });
    it.each([false, true])("returns native existence %s and forwards names unchanged", exists => {
        const bindings = ports();
        bindings.profileEntryExists.mockReturnValue(exists);
        expect(createProfileCatalog(bindings, defaultName).exists("plain-file")).toBe(exists);
        expect(bindings.profileEntryExists).toHaveBeenCalledExactlyOnceWith("plain-file");
    });
    it.each([false, true])("delegates built-in membership %s without reading settings", builtin => {
        const bindings = ports();
        bindings.hasBuiltinProfile.mockReturnValue(builtin);
        expect(createProfileCatalog(bindings, defaultName).isBuiltin(defaultName)).toBe(builtin);
        expect(bindings.hasBuiltinProfile).toHaveBeenCalledExactlyOnceWith(defaultName);
        expect(bindings.readBuiltinSettings).not.toHaveBeenCalled();
    });
    it("rejects reserved create and remove using the supplied default and no effects", () => {
        const bindings = ports();
        const app = createProfileCatalog(bindings, defaultName);
        expect(() => app.create(defaultName)).toThrow(`Profile "${defaultName}" is reserved.`);
        expect(() => app.remove(defaultName)).toThrow(`Profile "${defaultName}" cannot be removed.`);
        untouched(bindings);
    });
    it.each([undefined, { env: { EXAMPLE: "fixture" }, extra: { nested: true } }])("passes supplied settings by identity without validation or cloning", settings => {
        const bindings = ports();
        expect(createProfileCatalog(bindings, defaultName).create("named-profile", settings)).toBeUndefined();
        expect(bindings.writeProfile).toHaveBeenCalledExactlyOnceWith("named-profile", settings);
        expect(bindings.writeProfile.mock.calls[0][1]).toBe(settings);
        expect(bindings.profileEntryExists).not.toHaveBeenCalled();
        expect(bindings.hasBuiltinProfile).not.toHaveBeenCalled();
    });
    it("removes an admitted name without probing existence", () => {
        const bindings = ports();
        expect(createProfileCatalog(bindings, defaultName).remove("named-profile")).toBeUndefined();
        expect(bindings.removeProfileDirectory).toHaveBeenCalledExactlyOnceWith("named-profile");
        expect(bindings.profileEntryExists).not.toHaveBeenCalled();
    });
    it("returns false for an existing entry without inspecting built-ins", () => {
        const bindings = ports();
        bindings.profileEntryExists.mockReturnValue(true);
        expect(createProfileCatalog(bindings, defaultName).ensure("existing")).toBe(false);
        expect(bindings.profileEntryExists).toHaveBeenCalledExactlyOnceWith("existing");
        expect(bindings.hasBuiltinProfile).not.toHaveBeenCalled();
        expect(bindings.readBuiltinSettings).not.toHaveBeenCalled();
        expect(bindings.writeProfile).not.toHaveBeenCalled();
    });
    it("reports the exact unknown-profile error after existence and membership only", () => {
        const bindings = ports();
        const trace: string[] = [];
        bindings.profileEntryExists.mockImplementation(() => { trace.push("exists"); return false; });
        bindings.hasBuiltinProfile.mockImplementation(() => { trace.push("membership"); return false; });
        const error = thrown(() => createProfileCatalog(bindings, defaultName).ensure("unknown"));
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Profile "unknown" does not exist. Create it with: ccc profile add unknown');
        expect(trace).toEqual(["exists", "membership"]);
        expect(bindings.readBuiltinSettings).not.toHaveBeenCalled();
        expect(bindings.writeProfile).not.toHaveBeenCalled();
    });
    it.each([undefined, { env: { FIXTURE: "only" } } satisfies ProfileSettings])("ensures a missing built-in in exists→membership→settings→write order", settings => {
        const bindings = ports();
        const trace: string[] = [];
        bindings.profileEntryExists.mockImplementation(name => { trace.push(`exists:${name}`); return false; });
        bindings.hasBuiltinProfile.mockImplementation(name => { trace.push(`membership:${name}`); return true; });
        bindings.readBuiltinSettings.mockImplementation(name => { trace.push(`settings:${name}`); return settings; });
        bindings.writeProfile.mockImplementation((name, received) => { trace.push(`write:${name}`); expect(received).toBe(settings); });
        expect(createProfileCatalog(bindings, defaultName).ensure("builtin")).toBe(true);
        expect(trace).toEqual(["exists:builtin", "membership:builtin", "settings:builtin", "write:builtin"]);
        for (const name of ["profileEntryExists", "hasBuiltinProfile", "readBuiltinSettings", "writeProfile"] as const) expect(bindings[name]).toHaveBeenCalledTimes(1);
    });
    it.each(portNames)("propagates the original thrown value from %s without retries or later effects", stage => {
        const bindings = ports();
        const failure = { stage };
        bindings.hasBuiltinProfile.mockReturnValue(true);
        bindings[stage].mockImplementation(() => { throw failure; });
        const app = createProfileCatalog(bindings, defaultName);
        const action = stage === "listProfileDirectoryNames" ? () => app.list()
            : stage === "removeProfileDirectory" ? () => app.remove("builtin") : () => app.ensure("builtin");
        expect(thrown(action)).toBe(failure);
        expect(bindings[stage]).toHaveBeenCalledTimes(1);
        if (["profileEntryExists", "hasBuiltinProfile"].includes(stage)) expect(bindings.readBuiltinSettings).not.toHaveBeenCalled();
        if (["profileEntryExists", "hasBuiltinProfile", "readBuiltinSettings"].includes(stage)) expect(bindings.writeProfile).not.toHaveBeenCalled();
    });
});
