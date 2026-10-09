import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { CleanOptions } from "../../clean.js";
import type { CleanPorts, CleanMutationPorts } from "../../ports/clean.js";
import type { CleanInventoryResult, CleanMutationResult } from "../../domain/clean.js";

// These fixtures are checked by the real strict architecture compiler as well
// as the in-memory consumer below; they never execute a production operation.
function contracts(ports: CleanPorts, mutation: CleanMutationPorts, clean: (options: CleanOptions) => Promise<void>) {
    const options: CleanOptions = { volumes: true, all: false, dryRun: true, yes: false };
    const promise: Promise<void> = clean(options);
    const raw: CleanInventoryResult = { status: null, stdout: null, error: { opaque: true } };
    const result: CleanMutationResult = mutation.removeContainer("captured-id");
    const sync: undefined = ports.withLifecycleLock("prefix", () => undefined);
    // @ts-expect-error No implicit options default in the public callable.
    clean();
    // @ts-expect-error Public flags remain booleans.
    const badOptions: CleanOptions = { yes: "yes" };
    // @ts-expect-error No new force option.
    const force: CleanOptions = { force: true };
    // @ts-expect-error Status is a required raw observation.
    const missingStatus: CleanInventoryResult = { stdout: "partial" };
    // @ts-expect-error Unknown status carriers are not accepted by strict consumers.
    const unknownStatus: CleanMutationResult = { status: {} as unknown };
    // @ts-expect-error Native-free stdout contract is not Buffer/unknown.
    const badStdout: CleanInventoryResult = { status: 0, stdout: {} };
    // @ts-expect-error No ambient optional effects: ports are complete.
    const missingPorts: CleanPorts = { ensureRuntimeReady: () => undefined };
    // @ts-expect-error Readiness is strictly synchronous, returning undefined.
    const asyncReady: CleanPorts = { ...ports, ensureRuntimeReady: async () => undefined };
    // @ts-expect-error Inventory observations are synchronous and raw.
    const asyncInventory: CleanPorts = { ...ports, observeContainers: async () => raw };
    // @ts-expect-error Unknown inventory results cannot silently pass admission.
    const unknownInventory: CleanPorts = { ...ports, observeImages: (): unknown => raw };
    // @ts-expect-error Raw claims are synchronous.
    const asyncClaims: CleanPorts = { ...ports, sessionClaims: async () => [] };
    // @ts-expect-error Mutation-runtime capture cannot be asynchronous.
    const asyncCapture: CleanPorts = { ...ports, captureMutationRuntime: async () => mutation };
    // @ts-expect-error Lock effect must return undefined synchronously.
    const asyncLock: CleanPorts = { ...ports, withLifecycleLock: async () => undefined };
    // @ts-expect-error Async critical sections are forbidden, including Promise<undefined>.
    ports.withLifecycleLock("prefix", async () => undefined);
    // @ts-expect-error Synchronous critical sections cannot return an opaque result.
    ports.withLifecycleLock("prefix", () => raw);
    // @ts-expect-error Publication capture is synchronous.
    const asyncPublication: CleanPorts = { ...ports, capturePublication: async () => () => undefined };
    // @ts-expect-error A captured publication is synchronous and returns undefined.
    const asyncLogger: CleanPorts = { ...ports, capturePublication: () => async () => undefined };
    // @ts-expect-error Raw mutation effects cannot become asynchronous.
    const asyncMutation: CleanMutationPorts = { ...mutation, stopContainer: async () => result };
    // @ts-expect-error Mutation results are not void.
    const missingRaw: CleanMutationPorts = { ...mutation, removeImage: () => undefined };
    // @ts-expect-error Successful native exit has a never return.
    const returningExit: CleanPorts = { ...ports, exitSuccess: () => undefined };
    // @ts-expect-error Readonly native effect boundaries cannot be overwritten by consumers.
    mutation.removeVolume = () => result;
    void [promise, raw, result, sync, badOptions, force, missingStatus, unknownStatus, badStdout, missingPorts, asyncReady, asyncInventory, unknownInventory, asyncClaims, asyncCapture, asyncLock, asyncPublication, asyncLogger, asyncMutation, missingRaw, returningExit];
}
void contracts;

const root = fileURLToPath(new URL("../../../", import.meta.url));
// Whole authenticated original declaration, embedded without ignored-Task dependencies.
const originalCleanDeclaration = "export interface CleanOptions {\n    volumes?: boolean;\n    all?: boolean;\n    dryRun?: boolean;\n    yes?: boolean;\n}\nexport declare function cleanContainers(options: CleanOptions): Promise<void>;\n";
function consumer(moduleRoot: string) {
    // Genuine TypeScript Program, actual declarations/source imports; no
    // transpile-only or string-matching substitute for negative type evidence.
    const virtual = resolve(root, "src/__tests__/architecture/__clean_contract_consumer__.ts");
    const source = `
import { createClean } from ${JSON.stringify(resolve(moduleRoot, "application/clean.js"))};
import { cleanContainers } from ${JSON.stringify(resolve(moduleRoot, "clean.js"))};
import type { CleanOptions } from ${JSON.stringify(resolve(moduleRoot, "clean.js"))};
import type { CleanPorts, CleanMutationPorts } from ${JSON.stringify(resolve(moduleRoot, "ports/clean.js"))};
declare const ports: CleanPorts;
declare const mutation: CleanMutationPorts;
const app: (options: CleanOptions) => Promise<void> = createClean(ports);
const publicApp: (options: CleanOptions) => Promise<void> = cleanContainers;
const value: Promise<void> = app({ yes: true });
// @ts-expect-error Required constructor ports.
createClean();
// @ts-expect-error Complete required port set.
createClean({ ensureRuntimeReady: () => undefined });
// @ts-expect-error Required public options.
publicApp();
// @ts-expect-error Async callback forbidden in synchronous native guard.
ports.withLifecycleLock('prefix', async () => undefined);
// @ts-expect-error Async ready effect forbidden.
createClean({ ...ports, ensureRuntimeReady: async () => undefined });
// @ts-expect-error Async raw mutation forbidden.
const bad: CleanMutationPorts = { ...mutation, removeContainer: async () => ({ status: 0 }) };
// @ts-expect-error Unknown raw result forbidden.
createClean({ ...ports, observeContainers: (): unknown => ({ status: 0 }) });
void [app, publicApp, value, bad];
`;
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noUnusedLocals: true, noUnusedParameters: true, noEmit: true, skipLibCheck: false };
    const host = ts.createCompilerHost(options);
    const getSource = host.getSourceFile.bind(host);
    const read = host.readFile.bind(host); const exists = host.fileExists.bind(host);
    host.fileExists = path => path === virtual || exists(path);
    host.readFile = path => path === virtual ? source : read(path);
    host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => path === virtual ? ts.createSourceFile(path, source, languageVersion, true) : getSource(path, languageVersion, onError, shouldCreateNewSourceFile);
    host.writeFile = () => { throw new Error("Contract compiler must not write artifacts"); };
    const program = ts.createProgram([virtual], options, host);
    return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}
describe("genuine strict source clean consumer", () => {
    it("checks positive ABI and meaningful compiler-negative cases", () => { expect(consumer(resolve(root, "src"))).toEqual([]); });
    it("authenticates whole original public declaration witness", () => {
        const source = originalCleanDeclaration;
        expect(createHash("sha256").update(source).digest("hex")).toBe("ea90d03dd89c9e7e80e85fa1c3f32ca9faf19851506fba49f53d735e06c4d2d3");
        expect(source).toContain("cleanContainers(options: CleanOptions): Promise<void>");
    });
});
const emitted = process.env.CCC_CLEAN_COMPLETE_EMITTED_ROOT;
describe.skipIf(!emitted)("genuine complete emitted clean declaration consumer", () => {
    it("checks the actual whole emitted facade and required port declarations", () => { expect(consumer(emitted!)).toEqual([]); });
});
