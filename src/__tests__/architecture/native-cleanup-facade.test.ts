import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import ts from "typescript";
import { createNativeCleanupRealm, nativeCleanupRoot, materializeOriginalPayload, NATIVE_CLEANUP_ORIGINAL, project } from "../helpers/native-cleanup-fixture.js";

/** Whole authentic declaration namespaces are compared, including the private
 * carriers referenced by exported signatures. No tiny replacement declaration
 * or skipLibCheck waiver is supplied by these fixtures. */
function checkDeclarationConsumers(candidate: string) {
    const originalFiles = materializeOriginalPayload();
    const originalPayload = originalFiles.root;
    const original = path.join(originalPayload, "dist/device-lab-admin.d.ts");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-native-cleanup-types-"));
    const fixture = path.join(directory, "consumer.ts");
    const implementationSpecifier = (file: string) => file.replace(/\.d\.ts$/, ".js").replace(/\.ts$/, ".js");
    fs.writeFileSync(fixture, `
        import * as Previous from ${JSON.stringify(implementationSpecifier(original))};
        import * as Candidate from ${JSON.stringify(implementationSpecifier(candidate))};
        import * as PreviousNative from ${JSON.stringify(path.join(originalPayload, "dist/adapters/session-cleanup.js"))};
        import * as CandidateNative from ${JSON.stringify(path.join(nativeCleanupRoot, candidate.endsWith(".d.ts") ? "dist/adapters/session-cleanup.js" : "src/adapters/session-cleanup.js"))};
        const legacy: typeof Previous = Candidate;
        const current: typeof Candidate = Previous;
        type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
        type Assert<T extends true> = T;
        type PublicNames = Assert<Equal<keyof typeof Previous, keyof typeof Candidate>>;
        type CleanupParams = Assert<Equal<Parameters<typeof Previous.cleanupOwnerDevices>, Parameters<typeof Candidate.cleanupOwnerDevices>>>;
        type CleanupResult = Assert<Equal<ReturnType<typeof Previous.cleanupOwnerDevices>, ReturnType<typeof Candidate.cleanupOwnerDevices>>>;
        type AsyncCliParams = Assert<Equal<Parameters<typeof Previous.devicesCliAsync>, Parameters<typeof Candidate.devicesCliAsync>>>;
        const equalityProofs: [PublicNames, CleanupParams, CleanupResult, AsyncCliParams] = [true, true, true, true];
        const cleanupArguments: Parameters<typeof Candidate.cleanupOwnerDevices> = ["/project", 5000, "work"];
        const result = Candidate.cleanupOwnerDevices(...cleanupArguments);
        const originalResult: ReturnType<typeof Previous.cleanupOwnerDevices> = result;
        const backend: typeof Previous.DEVICE_BACKENDS[number] = Candidate.DEVICE_BACKENDS[0];
        // Meaningful negative fixtures bind BOTH whole genuine namespaces.
        // An async operation cannot satisfy the original synchronous result.
        // @ts-expect-error Promise result cannot implement synchronous original cleanup
        const asyncPrevious: typeof Previous.cleanupOwnerDevices = async () => ({ ownerId: "owner", results: [] });
        // @ts-expect-error Promise result cannot implement synchronous current cleanup
        const asyncCandidate: typeof Candidate.cleanupOwnerDevices = async () => ({ ownerId: "owner", results: [] });
        // @ts-expect-error original result requires the real ownerId and native results shape
        const wrongPrevious: ReturnType<typeof Previous.cleanupOwnerDevices> = { ownerId: 7, results: [] };
        // @ts-expect-error current result requires the same shape
        const wrongCandidate: ReturnType<typeof Candidate.cleanupOwnerDevices> = { ownerId: 7, results: [] };
        // @ts-expect-error cleanup command timeout is a number, not a string
        Previous.cleanupOwnerDevices("/project", "5000");
        // @ts-expect-error current cleanup preserves native timeout argument typing
        Candidate.cleanupOwnerDevices("/project", "5000");
        // @ts-expect-error original internal native cleanup requires projectPath AND timeoutMs
        PreviousNative.cleanupNativeSessionDevices("/project");
        // @ts-expect-error current internal native cleanup still requires timeoutMs
        CandidateNative.cleanupNativeSessionDevices("/project");
        // @ts-expect-error original native stop requires the container-ID reader
        PreviousNative.stopNativeSessionContainer();
        // @ts-expect-error current native stop still requires its reader
        CandidateNative.stopNativeSessionContainer();
        void legacy; void current; void originalResult; void backend; void equalityProofs;
        void asyncPrevious; void asyncCandidate; void wrongPrevious; void wrongCandidate;
    `);
    try {
        originalFiles.assertAuthenticated();
        const configFile = ts.readConfigFile(path.join(nativeCleanupRoot, "tsconfig.json"), ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, nativeCleanupRoot);
        const options: ts.CompilerOptions = { ...parsed.options, rootDir: undefined, noEmit: true,
            skipLibCheck: false, declaration: false, incremental: false,
            baseUrl: nativeCleanupRoot, paths: { "@ccc/device-lab/*.js": ["packages/device-lab/dist/*.d.ts"],
                "@ccc/hyper-v": ["packages/hyper-v/dist/index.d.ts"], "@ccc/hyper-v/*.js": ["packages/hyper-v/dist/*.d.ts"] },
            typeRoots: [path.join(nativeCleanupRoot, "node_modules/@types")],
        };
        const host = ts.createCompilerHost(options);
        const readFile = host.readFile, fileExists = host.fileExists;
        const isOriginal = (file: string) => file === originalPayload || file.startsWith(originalPayload + path.sep);
        const originalKey = (file: string) => path.relative(originalPayload, file).split(path.sep).join("/");
        host.fileExists = file => isOriginal(file) ? Object.hasOwn(NATIVE_CLEANUP_ORIGINAL.files, originalKey(file)) : fileExists(file);
        host.readFile = file => isOriginal(file) ? originalFiles.read(file) : readFile(file);
        // Original package imports resolve to original declarations and actual
        // package metadata, never candidate carriers via the project's aliases.
        host.resolveModuleNames = (names, containingFile) => names.map(name => ts.resolveModuleName(name, containingFile,
            isOriginal(containingFile) ? { ...options, baseUrl: originalPayload, paths: {
                "@ccc/device-lab/*.js": ["dist/packages/device-lab/dist/*.d.ts"],
                "@ccc/hyper-v": ["dist/packages/hyper-v/dist/index.d.ts"],
                "@ccc/hyper-v/*.js": ["dist/packages/hyper-v/dist/*.d.ts"],
            } } : options, host).resolvedModule);
        const originalDeclarations = Object.keys(NATIVE_CLEANUP_ORIGINAL.files).filter(file => file.endsWith(".d.ts"))
            .map(file => path.join(originalPayload, file));
        expect(originalDeclarations).toHaveLength(52);
        const program = ts.createProgram([fixture, ...originalDeclarations], options, host);
        expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
        originalFiles.assertAuthenticated();
    } finally { originalFiles.cleanup(); fs.rmSync(directory, { recursive: true, force: true }); }
}

describe("native cleanup exact facade and whole declaration compatibility", () => {
    it("retains admin native export identities, not copied wrappers", () => {
        const realm = createNativeCleanupRealm(false);
        try {
            realm.assertZero();
            const admin = realm.load("src/device-lab-admin.ts"); realm.assertZero();
            for (const name of ["DEVICE_BACKENDS", "deviceLabOwnerIdentity", "deviceLabOwnerId", "cleanupOwnerDevices"] as const) {
                expect(admin[name]).toBe(realm.native[name]);
            }
            realm.writeJson(realm.ownerFile("android"), { devices: [{ id: "native-a", status: "running", serial: "emulator-5554" }] });
            const result = admin.cleanupOwnerDevices(project, 5000);
            realm.assertZero();
            expect(result.results[0].status).toBe("stopped");
        } finally { realm.cleanup(); }
    });
    it("retains the full admin namespace against the genuine original emitted facade", () => {
        const original = createNativeCleanupRealm(true), candidate = createNativeCleanupRealm(false);
        try {
            const before = original.load("src/device-lab-admin.ts"); original.assertZero();
            const after = candidate.load("src/device-lab-admin.ts"); candidate.assertZero();
            expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
            expect(after.cleanupOwnerDevices.length).toBe(before.cleanupOwnerDevices.length);
        } finally { original.cleanup(); candidate.cleanup(); }
    });
    it("strictly checks whole authentic original versus current source declarations", () => {
        checkDeclarationConsumers(path.join(nativeCleanupRoot, "src/device-lab-admin.ts"));
    }, 30000);
    it("strictly checks whole authentic original versus current emitted declarations", () => {
        checkDeclarationConsumers(path.join(nativeCleanupRoot, "dist/device-lab-admin.d.ts"));
    }, 30000);
    it("passes through the same raw stop object and preserves original error-field short circuit", () => {
        const snapshots: unknown[] = [];
        for (const original of [true, false]) {
            const realm = createNativeCleanupRealm(original);
            try {
                const adapter = realm.load("src/adapters/session-cleanup.ts"); realm.assertZero();
                realm.load("src/container-runtime.ts")._setRuntimeInfoForTest({ runtime: "docker" }); realm.assertZero();
                const sentinel = Object.assign(new Error("private raw error"), { code: "ETIMEDOUT" });
                realm.state.stopError = sentinel;
                let thrown: unknown;
                try { adapter.stopNativeSessionContainer(() => "fixture-container"); } catch (error) { thrown = error; }
                realm.assertZero();
                expect((thrown as Error).message).toContain("error=ETIMEDOUT");
                expect(realm.state.stopError).toBe(sentinel);
                expect(realm.trace.filter(row => String(row[0]).startsWith("stop.")).map(row => row[0]))
                    .toEqual(["stop.error", "stop.error", "stop.status", "stop.signal"]);
                snapshots.push(realm.normalize({ thrown, trace: realm.trace }));
            } finally { realm.cleanup(); }
        }
        expect(snapshots[1]).toEqual(snapshots[0]);
    });
});
