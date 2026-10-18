import type { ProfileCatalogPorts, ProfileSettings } from "../ports/profile-catalog.js";

export interface ProfileCatalog {
    validate(name: string): boolean;
    list(): string[];
    exists(name: string): boolean;
    isBuiltin(name: string): boolean;
    create(name: string, settings?: ProfileSettings): void;
    ensure(name: string): boolean;
    remove(name: string): void;
}

export function validateProfileName(name: string): boolean {
    return /^[a-z0-9][a-z0-9_.\-]{0,63}$/.test(name);
}

export function createProfileCatalog(ports: ProfileCatalogPorts, defaultProfileName: string): ProfileCatalog {
    for (const name of ["listProfileDirectoryNames", "profileEntryExists", "writeProfile", "removeProfileDirectory", "hasBuiltinProfile", "readBuiltinSettings"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Profile catalog requires a callable ${name} port.`);
        }
    }

    function exists(name: string): boolean {
        return validateProfileName(name) && (name === defaultProfileName || ports.profileEntryExists(name));
    }

    function create(name: string, settings?: ProfileSettings): void {
        if (!validateProfileName(name)) throw new Error(`Invalid profile name "${name}".`);
        if (name === defaultProfileName) throw new Error(`Profile "${defaultProfileName}" is reserved.`);
        ports.writeProfile(name, settings);
    }

    return {
        validate: validateProfileName,

        list() {
            const named = ports.listProfileDirectoryNames().filter((name) => name !== defaultProfileName);
            return [defaultProfileName, ...named];
        },

        exists,

        isBuiltin(name) {
            return validateProfileName(name) && ports.hasBuiltinProfile(name);
        },

        create,

        ensure(name) {
            if (!validateProfileName(name)) throw new Error(`Invalid profile name "${name}".`);
            if (exists(name)) return false;
            if (!ports.hasBuiltinProfile(name)) {
                throw new Error(`Profile "${name}" does not exist. Create it with: ccc profile add ${name}`);
            }
            create(name, ports.readBuiltinSettings(name));
            return true;
        },

        remove(name) {
            if (!validateProfileName(name)) throw new Error(`Invalid profile name "${name}".`);
            if (name === defaultProfileName) throw new Error(`Profile "${defaultProfileName}" cannot be removed.`);
            ports.removeProfileDirectory(name);
        },
    };
}
