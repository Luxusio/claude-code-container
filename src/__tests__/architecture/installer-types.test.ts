import { describe, expect, it } from "vitest";
import { createInstallerApplication } from "../../../scripts/install/application.mjs";
import type { InstallerPorts } from "../../../scripts/install/ports.mjs";

const ports: InstallerPorts = {
    platform: () => "unix", sourceRoot: () => "/source", sourceEntry: () => "/source/dist/index.js",
    installDirectory: () => "/owned-bin", runtimeOverride: () => undefined, githubTokenConfigured: () => false,
    sourceBuild: () => undefined, contentHash: () => "current-content", runtimeAvailable: () => false,
    imageLabel: () => null, buildContainer: () => ({ status: 0 }),
    resolvePath: path => path, joinPath: (...parts) => parts.join("/"), parentPath: () => "/",
    fileUrl: path => "file://" + path, exists: () => false, isSymlink: () => false,
    removeFile: () => undefined, removeDirectory: () => undefined, ensureDirectory: () => undefined,
    copy: () => undefined, readPackage: () => ({ version: "1.0.0" }), writeText: () => undefined,
    setMode: () => undefined, readUserPath: () => "", writeUserPath: () => undefined,
    log: () => undefined, warn: () => undefined, error: () => undefined,
    terminate: code => { throw new Error(`terminated ${code}`); },
};
const app = createInstallerApplication(ports);
function consumedContracts() {
    const image: { status: "ready" } | { status: "failed" } | { status: "skipped"; reason: string } = app.buildImage();
    const installed: void = app.install({ skipImage: true });
    const removed: void = app.uninstall(), postinstalled: void = app.postinstall();
    const wrapper: string = app.unixWrapperContent("/owned-bin/ccc-dist");
    const { sourceBuild, ...missingBuild } = ports; void sourceBuild;
    // @ts-expect-error source compilation must be explicitly provided
    createInstallerApplication(missingBuild);
    const { copy, ...missingCopy } = ports; void copy;
    // @ts-expect-error materialization requires its native copy capability
    createInstallerApplication(missingCopy);
    const { writeUserPath, ...missingPathWrite } = ports; void writeUserPath;
    // @ts-expect-error Windows User PATH persistence cannot be omitted
    createInstallerApplication(missingPathWrite);
    // @ts-expect-error source build must complete before installer publication
    const deferredBuild: InstallerPorts = { ...ports, sourceBuild: async () => undefined };
    // @ts-expect-error native copy cannot become an unawaited Promise
    const deferredCopy: InstallerPorts = { ...ports, copy: async () => undefined };
    // @ts-expect-error User PATH writes must settle synchronously
    const deferredPathWrite: InstallerPorts = { ...ports, writeUserPath: async () => undefined };
    // @ts-expect-error User PATH must be observed as a concrete string
    const deferredPathRead: InstallerPorts = { ...ports, readUserPath: async () => "" };
    // @ts-expect-error image command receipt must be immediate
    const deferredImage: InstallerPorts = { ...ports, buildContainer: async () => ({ status: 0 }) };
    // @ts-expect-error a settled-looking receipt cannot carry deferred completion
    const thenableImage: InstallerPorts = { ...ports, buildContainer: () => ({ status: 0, then: () => undefined }) };
    // @ts-expect-error process termination cannot return and continue publication
    const returningExit: InstallerPorts = { ...ports, terminate: () => undefined };
    void image; void installed; void removed; void postinstalled; void wrapper;
    void deferredBuild; void deferredCopy; void deferredPathWrite; void deferredPathRead; void deferredImage; void thenableImage; void returningExit;
}
void consumedContracts;

describe("consumed installer capabilities", () => {
    it("uses immediate native facts to skip an unavailable runtime", () => {
        expect(app.buildImage()).toEqual({ status: "skipped", reason: "no runtime detected" });
    });
});
