import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import ts from "typescript";
import { createNativeCleanupRealm, nativeCleanupRoot, project } from "../helpers/native-cleanup-fixture.js";

function checkDeclarationConsumers(candidate: string) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-native-cleanup-types-"));
    const fixture = path.join(directory, "consumer.ts");
    const implementationSpecifier = (file: string) => file.replace(/\.d\.ts$/, ".js").replace(/\.ts$/, ".js");
    fs.writeFileSync(fixture, `
        import * as Candidate from ${JSON.stringify(implementationSpecifier(candidate))};
        import * as CandidateNative from ${JSON.stringify(path.join(nativeCleanupRoot, candidate.endsWith(".d.ts") ? "dist/adapters/session-cleanup.js" : "src/adapters/session-cleanup.js"))};
        const cleanupArguments: Parameters<typeof Candidate.cleanupOwnerDevices> = ["/project", 5000, "work"];
        const result = Candidate.cleanupOwnerDevices(...cleanupArguments);
        const backend: typeof Candidate.DEVICE_BACKENDS[number] = Candidate.DEVICE_BACKENDS[0];
        void [result, backend];
        // @ts-expect-error Promise result cannot implement synchronous current cleanup
        const asyncCandidate: typeof Candidate.cleanupOwnerDevices = async () => ({ ownerId: "owner", results: [] });
        // @ts-expect-error current result requires the same shape
        const wrongCandidate: ReturnType<typeof Candidate.cleanupOwnerDevices> = { ownerId: 7, results: [] };
        void [asyncCandidate, wrongCandidate];
        // @ts-expect-error current cleanup preserves native timeout argument typing
        Candidate.cleanupOwnerDevices("/project", "5000");
        // @ts-expect-error current internal native cleanup still requires timeoutMs
        CandidateNative.cleanupNativeSessionDevices("/project");
        // @ts-expect-error current native stop still requires its reader
        CandidateNative.stopNativeSessionContainer();
    `);
    try {
        const configFile = ts.readConfigFile(path.join(nativeCleanupRoot, "tsconfig.json"), ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, nativeCleanupRoot);
        const options: ts.CompilerOptions = { ...parsed.options, rootDir: undefined, noEmit: true,
            skipLibCheck: false, declaration: false, incremental: false,
            baseUrl: nativeCleanupRoot, paths: { "@ccc/device-lab/*.js": ["packages/device-lab/dist/*.d.ts"],
                "@ccc/hyper-v": ["packages/hyper-v/dist/index.d.ts"], "@ccc/hyper-v/*.js": ["packages/hyper-v/dist/*.d.ts"] },
            typeRoots: [path.join(nativeCleanupRoot, "node_modules/@types")],
        };
        const host = ts.createCompilerHost(options);
        const program = ts.createProgram([fixture], options, host);
        expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

describe("native cleanup current facade and synchronous declaration contracts", () => {
    it("retains admin native export identities, not copied wrappers", () => {
        const realm = createNativeCleanupRealm();
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
    it("strictly checks whole authentic current source declarations", () => {
        checkDeclarationConsumers(path.join(nativeCleanupRoot, "src/device-lab-admin.ts"));
    }, 30000);
    it("strictly checks whole authentic current emitted declarations", () => {
        checkDeclarationConsumers(path.join(nativeCleanupRoot, "dist/device-lab-admin.d.ts"));
    }, 30000);
});
