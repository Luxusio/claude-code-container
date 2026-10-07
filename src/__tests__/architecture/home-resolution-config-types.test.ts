import { describe, expect, it } from "vitest";
import { createHomeLayoutPaths } from "../../application/home/layout-paths.js";
import { createCccConfig } from "../../application/home/config.js";
import type { HomePathPorts } from "../../ports/home/layout-paths.js";
import type { CccConfigPorts } from "../../ports/home/config.js";
import type * as Native from "../../home-layout.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type PathKeys = "homeDirectory" | "joinHostPath" | "entryExists" | "createDirectory" | "writeMarker";
type ConfigKeys = "resolveConfigPath" | "resolveHomePath" | "createDirectory" | "fileExists" | "readText" | "processId" | "writeText" | "replaceFile";
type ExactPaths = Assert<Equal<keyof HomePathPorts, PathKeys>>;
type ExactConfig = Assert<Equal<keyof CccConfigPorts, ConfigKeys>>;
type CorePaths = ReturnType<typeof createHomeLayoutPaths>;
type CoreConfig = ReturnType<typeof createCccConfig>;
type CoreEnsure = Assert<Equal<ReturnType<CorePaths["ensureDefaultProfileDir"]>, undefined>>;
type CoreUpdate = Assert<Equal<ReturnType<CoreConfig["update"]>, undefined>>;
type PublicEnsure = Assert<Equal<ReturnType<typeof Native.ensureDefaultProfileDir>, void>>;
type PublicUpdate = Assert<Equal<ReturnType<typeof Native.updateCccConfig>, void>>;
type Read = Assert<Equal<ReturnType<CoreConfig["read"]>, Record<string, unknown>>>;
type Mutate = Assert<Equal<Parameters<CoreConfig["update"]>[0], (config: Record<string, unknown>) => void>>;
function contracts(paths: HomePathPorts, config: CccConfigPorts, native: typeof Native) {
    const core = createCccConfig(config);
    const update: undefined = core.update(async value => { value.synthetic = true; });
    const ensure: undefined = createHomeLayoutPaths(paths, "default", ".marker", []).ensureDefaultProfileDir();
    native.updateCccConfig(async value => { value.synthetic = true; });
    native.updateCccConfig(() => 42);
    core.update(() => 42);
    // @ts-expect-error Observed config values remain unknown.
    core.update(value => { const text: string = value.synthetic; void text; });
    // @ts-expect-error Native facade historical void is not undefined.
    const strictNative: undefined = native.updateCccConfig(() => {});
    // @ts-expect-error Missing factory dependencies.
    createCccConfig();
    // @ts-expect-error Original entry reference is explicit.
    createHomeLayoutPaths(paths, "default", ".marker");
    void [update, ensure, strictNative];
    // @ts-expect-error homeDirectory is readonly.
    paths.homeDirectory = paths.homeDirectory;
    { const { homeDirectory: omitted, ...remaining } = paths; void omitted;
        // @ts-expect-error homeDirectory is required.
        createHomeLayoutPaths(remaining, "default", ".marker", []);
    }
    // @ts-expect-error homeDirectory cannot return a Promise.
    createHomeLayoutPaths({ ...paths, homeDirectory: async (...args: Parameters<typeof paths.homeDirectory>) => paths.homeDirectory(...args) }, "default", ".marker", []);
    // @ts-expect-error joinHostPath is readonly.
    paths.joinHostPath = paths.joinHostPath;
    { const { joinHostPath: omitted, ...remaining } = paths; void omitted;
        // @ts-expect-error joinHostPath is required.
        createHomeLayoutPaths(remaining, "default", ".marker", []);
    }
    // @ts-expect-error joinHostPath cannot return a Promise.
    createHomeLayoutPaths({ ...paths, joinHostPath: async (...args: Parameters<typeof paths.joinHostPath>) => paths.joinHostPath(...args) }, "default", ".marker", []);
    // @ts-expect-error entryExists is readonly.
    paths.entryExists = paths.entryExists;
    { const { entryExists: omitted, ...remaining } = paths; void omitted;
        // @ts-expect-error entryExists is required.
        createHomeLayoutPaths(remaining, "default", ".marker", []);
    }
    // @ts-expect-error entryExists cannot return a Promise.
    createHomeLayoutPaths({ ...paths, entryExists: async (...args: Parameters<typeof paths.entryExists>) => paths.entryExists(...args) }, "default", ".marker", []);
    // @ts-expect-error createDirectory is readonly.
    paths.createDirectory = paths.createDirectory;
    { const { createDirectory: omitted, ...remaining } = paths; void omitted;
        // @ts-expect-error createDirectory is required.
        createHomeLayoutPaths(remaining, "default", ".marker", []);
    }
    // @ts-expect-error createDirectory cannot return a Promise.
    createHomeLayoutPaths({ ...paths, createDirectory: async (...args: Parameters<typeof paths.createDirectory>) => paths.createDirectory(...args) }, "default", ".marker", []);
    // @ts-expect-error writeMarker is readonly.
    paths.writeMarker = paths.writeMarker;
    { const { writeMarker: omitted, ...remaining } = paths; void omitted;
        // @ts-expect-error writeMarker is required.
        createHomeLayoutPaths(remaining, "default", ".marker", []);
    }
    // @ts-expect-error writeMarker cannot return a Promise.
    createHomeLayoutPaths({ ...paths, writeMarker: async (...args: Parameters<typeof paths.writeMarker>) => paths.writeMarker(...args) }, "default", ".marker", []);
    // @ts-expect-error resolveConfigPath is readonly.
    config.resolveConfigPath = config.resolveConfigPath;
    { const { resolveConfigPath: omitted, ...remaining } = config; void omitted;
        // @ts-expect-error resolveConfigPath is required.
        createCccConfig(remaining);
    }
    // @ts-expect-error resolveConfigPath cannot return a Promise.
    createCccConfig({ ...config, resolveConfigPath: async (...args: Parameters<typeof config.resolveConfigPath>) => config.resolveConfigPath(...args) });
    // @ts-expect-error resolveHomePath is readonly.
    config.resolveHomePath = config.resolveHomePath;
    { const { resolveHomePath: omitted, ...remaining } = config; void omitted;
        // @ts-expect-error resolveHomePath is required.
        createCccConfig(remaining);
    }
    // @ts-expect-error resolveHomePath cannot return a Promise.
    createCccConfig({ ...config, resolveHomePath: async (...args: Parameters<typeof config.resolveHomePath>) => config.resolveHomePath(...args) });
    // @ts-expect-error createDirectory is readonly.
    config.createDirectory = config.createDirectory;
    { const { createDirectory: omitted, ...remaining } = config; void omitted;
        // @ts-expect-error createDirectory is required.
        createCccConfig(remaining);
    }
    // @ts-expect-error createDirectory cannot return a Promise.
    createCccConfig({ ...config, createDirectory: async (...args: Parameters<typeof config.createDirectory>) => config.createDirectory(...args) });
    // @ts-expect-error fileExists is readonly.
    config.fileExists = config.fileExists;
    { const { fileExists: omitted, ...remaining } = config; void omitted;
        // @ts-expect-error fileExists is required.
        createCccConfig(remaining);
    }
    // @ts-expect-error fileExists cannot return a Promise.
    createCccConfig({ ...config, fileExists: async (...args: Parameters<typeof config.fileExists>) => config.fileExists(...args) });
    // @ts-expect-error readText is readonly.
    config.readText = config.readText;
    { const { readText: omitted, ...remaining } = config; void omitted;
        // @ts-expect-error readText is required.
        createCccConfig(remaining);
    }
    // @ts-expect-error readText cannot return a Promise.
    createCccConfig({ ...config, readText: async (...args: Parameters<typeof config.readText>) => config.readText(...args) });
    // @ts-expect-error processId is readonly.
    config.processId = config.processId;
    { const { processId: omitted, ...remaining } = config; void omitted;
        // @ts-expect-error processId is required.
        createCccConfig(remaining);
    }
    // @ts-expect-error processId cannot return a Promise.
    createCccConfig({ ...config, processId: async (...args: Parameters<typeof config.processId>) => config.processId(...args) });
    // @ts-expect-error writeText is readonly.
    config.writeText = config.writeText;
    { const { writeText: omitted, ...remaining } = config; void omitted;
        // @ts-expect-error writeText is required.
        createCccConfig(remaining);
    }
    // @ts-expect-error writeText cannot return a Promise.
    createCccConfig({ ...config, writeText: async (...args: Parameters<typeof config.writeText>) => config.writeText(...args) });
    // @ts-expect-error replaceFile is readonly.
    config.replaceFile = config.replaceFile;
    { const { replaceFile: omitted, ...remaining } = config; void omitted;
        // @ts-expect-error replaceFile is required.
        createCccConfig(remaining);
    }
    // @ts-expect-error replaceFile cannot return a Promise.
    createCccConfig({ ...config, replaceFile: async (...args: Parameters<typeof config.replaceFile>) => config.replaceFile(...args) });
    // @ts-expect-error New effects explicitly return undefined rather than void.
    createCccConfig({ ...config, replaceFile: (): void => {} });
    // @ts-expect-error Directory options require recursive true.
    paths.createDirectory("private", { recursive: false, mode: 0o700 });
    config.writeText("private", undefined, { mode: 0o600 });
}
void contracts;
export type HomeContractProofs = [ExactPaths, ExactConfig, CoreEnsure, CoreUpdate, PublicEnsure, PublicUpdate, Read, Mutate];
describe("home resolution and config synchronous contracts", () => {
    it("keeps the synchronous core read value", () => {
        const config = createCccConfig({ resolveConfigPath: () => "private", resolveHomePath: () => "private", createDirectory: () => undefined, fileExists: () => false, readText: () => "{}", processId: () => 1, writeText: () => undefined, replaceFile: () => undefined });
        expect(config.read()).toEqual({}); expect(config.update(() => {})).toBeUndefined();
    });
});
