import { describe, expect, it } from "vitest";
import { createInstallerApplication } from "../../../scripts/install/application.mjs";
import type { InstallerBuildResult, InstallerEvent, InstallerPorts } from "../../../scripts/install/ports.mjs";

const ports: InstallerPorts = {
    platform: () => "unix", sourceRoot: () => "/source",
    installDirectory: () => "/owned-bin", runtimeOverride: () => undefined, githubTokenConfigured: () => false,
    sourceBuild: () => undefined, contentHash: () => "current-content", runtimeAvailable: () => false,
    imageLabel: () => null, buildContainer: () => ({ status: "ready" }),
    resolvePath: path => path, joinPath: (...parts) => parts.join("/"), parentPath: () => "/", basePath: path => path,
    exists: () => false, pathKind: () => "missing", realPath: path => path,
    createExclusiveDirectory: () => undefined, createTemporaryDirectory: prefix => prefix + "owned",
    removeEmptyDirectory: () => undefined, renamePath: () => undefined,
    removeFile: () => undefined, removeDirectory: () => undefined, ensureDirectory: () => undefined,
    copy: () => undefined, writeUnixPackage: () => undefined, unixWrapperContent: () => "native Unix launcher",
    writeUnixLauncher: () => undefined, writeWindowsLauncher: () => undefined,
    observeUnixLauncherAliases: () => [], publishUnixLauncherAlias: () => undefined,
    readUserPath: () => "", writeUserPath: () => undefined, present: () => undefined,
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
    const { renamePath, ...missingRename } = ports; void renamePath;
    // @ts-expect-error publication and restoration require explicit native rename
    createInstallerApplication(missingRename);
    const { createExclusiveDirectory, ...missingGuard } = ports; void createExclusiveDirectory;
    // @ts-expect-error cooperative exclusion cannot be omitted
    createInstallerApplication(missingGuard);
    const { createTemporaryDirectory, ...missingStage } = ports; void createTemporaryDirectory;
    // @ts-expect-error staging requires a fresh owned sibling directory
    createInstallerApplication(missingStage);
    const { pathKind, ...missingKind } = ports; void pathKind;
    // @ts-expect-error destination safety requires immediate lstat facts
    createInstallerApplication(missingKind);
    const { realPath, ...missingCanonicalPath } = ports; void realPath;
    // @ts-expect-error destination overlap safety requires canonical paths
    createInstallerApplication(missingCanonicalPath);
    const { removeEmptyDirectory, ...missingRelease } = ports; void removeEmptyDirectory;
    // @ts-expect-error the destination guard needs an explicit native release
    createInstallerApplication(missingRelease);
    const { basePath, ...missingBasePath } = ports; void basePath;
    // @ts-expect-error canonical target resolution requires its final path component
    createInstallerApplication(missingBasePath);
    const { writeUserPath, ...missingPathWrite } = ports; void writeUserPath;
    // @ts-expect-error Windows User PATH persistence cannot be omitted
    createInstallerApplication(missingPathWrite);
    // @ts-expect-error source build must complete before installer publication
    const deferredBuild: InstallerPorts = { ...ports, sourceBuild: async () => undefined };
    // @ts-expect-error native copy cannot become an unawaited Promise
    const deferredCopy: InstallerPorts = { ...ports, copy: async () => undefined };
    // @ts-expect-error publication cannot continue before a rename settles
    const deferredRename: InstallerPorts = { ...ports, renamePath: async () => undefined };
    // @ts-expect-error guard acquisition must be exclusive before publication begins
    const deferredGuard: InstallerPorts = { ...ports, createExclusiveDirectory: async () => undefined };
    // @ts-expect-error stage creation must return an immediate owned path
    const deferredStage: InstallerPorts = { ...ports, createTemporaryDirectory: async () => "/stage" };
    // @ts-expect-error guard release cannot become an unawaited operation
    const deferredRelease: InstallerPorts = { ...ports, removeEmptyDirectory: async () => undefined };
    // @ts-expect-error destination type must be observed synchronously
    const deferredKind: InstallerPorts = { ...ports, pathKind: async () => "missing" as const };
    // @ts-expect-error canonical path must be a concrete native observation
    const deferredCanonicalPath: InstallerPorts = { ...ports, realPath: async path => path };
    // @ts-expect-error destination types are finite native facts
    const arbitraryKind: InstallerPorts = { ...ports, pathKind: () => "arbitrary" };
    // @ts-expect-error User PATH writes must settle synchronously
    const deferredPathWrite: InstallerPorts = { ...ports, writeUserPath: async () => undefined };
    // @ts-expect-error User PATH must be observed as a concrete string
    const deferredPathRead: InstallerPorts = { ...ports, readUserPath: async () => "" };
    // @ts-expect-error image command receipt must be immediate
    const deferredImage: InstallerPorts = { ...ports, buildContainer: async () => ({ status: "ready" as const }) };
    // @ts-expect-error a settled-looking receipt cannot carry deferred completion
    const thenableImage: InstallerPorts = { ...ports, buildContainer: () => ({ status: "ready", then: () => undefined }) };
    // @ts-expect-error raw process status is not an image build observation
    const processReceipt: InstallerBuildResult = { status: 0 };
    // @ts-expect-error failed image observation must retain its original cause
    const missingCause: InstallerBuildResult = { status: "failed" };
    const cause = new Error("original image cause");
    const failedImage: InstallerBuildResult = { status: "failed", cause };
    // @ts-expect-error source compilation remains undefined-or-throw, not an image receipt
    const imageLikeSource: InstallerPorts = { ...ports, sourceBuild: () => ({ status: "failed", cause }) };
    // @ts-expect-error native event publication must complete before installer continuation
    const deferredPresentation: InstallerPorts = { ...ports, present: async () => undefined };
    // @ts-expect-error Unix launcher publication cannot defer bytes or chmod
    const deferredUnixLauncher: InstallerPorts = { ...ports, writeUnixLauncher: async () => undefined };
    // @ts-expect-error Windows launcher publication cannot become deferred
    const deferredWindowsLauncher: InstallerPorts = { ...ports, writeWindowsLauncher: async () => undefined };
    // @ts-expect-error native package materialization must complete before launcher publication
    const deferredPackage: InstallerPorts = { ...ports, writeUnixPackage: async () => undefined };
    const { writeUnixPackage, ...missingPackage } = ports; void writeUnixPackage;
    // @ts-expect-error required native package materialization cannot be omitted
    createInstallerApplication(missingPackage);
    const { present, ...missingPresentation } = ports; void present;
    // @ts-expect-error required native presentation cannot be omitted
    createInstallerApplication(missingPresentation);
    // @ts-expect-error a source build failure is not a skippable finite event
    const skippedSource: InstallerEvent = { kind: "source-build-skipped", cause };
    // @ts-expect-error process termination cannot return and continue publication
    const returningExit: InstallerPorts = { ...ports, terminate: () => undefined };
    void image; void installed; void removed; void postinstalled; void wrapper;
    void deferredBuild; void deferredCopy; void deferredPathWrite; void deferredPathRead; void deferredImage; void thenableImage; void returningExit;
    void deferredRename; void deferredGuard; void deferredStage; void deferredRelease; void deferredKind; void deferredCanonicalPath; void arbitraryKind;
    void processReceipt; void missingCause; void failedImage; void imageLikeSource; void deferredPresentation;
    void deferredUnixLauncher; void deferredWindowsLauncher; void deferredPackage; void missingPackage; void missingPresentation; void skippedSource;
}
void consumedContracts;

describe("consumed installer capabilities", () => {
    it("uses immediate native facts to skip an unavailable runtime", () => {
        expect(app.buildImage()).toEqual({ status: "skipped", reason: "no runtime detected" });
    });
});
