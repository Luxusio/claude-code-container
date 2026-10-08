import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createLabRunnerDiagnostics } from "../../application/lab-runner-diagnostics.js";
import type { LabRunnerConfigObservation, LabRunnerSnapshot, ContainerVmContractSnapshot } from "../../domain/lab-runner-diagnostics.js";
import type { LabRunnerRunConfig, buildContainerVmRunConfig, buildLabRunnerRunConfig } from "../../docker.js";
import type { labRunnerSnapshot, formatLabRunnerStatus, formatLabRunnerSmoke, labsCli } from "../../lab-runner-admin.js";

type Assert<T extends true> = T;
type NativeFits = Assert<LabRunnerRunConfig extends LabRunnerConfigObservation ? true : false>;
const fits: NativeFits = true; void fits;
function contracts(ports: Parameters<typeof createLabRunnerDiagnostics>[0], native: typeof buildContainerVmRunConfig, lab: typeof buildLabRunnerRunConfig, snapshot: typeof labRunnerSnapshot, status: typeof formatLabRunnerStatus, smoke: typeof formatLabRunnerSmoke, cli: typeof labsCli) {
    const nativePort: typeof ports.containerVmConfig = native;
    const labPort: typeof ports.labRunnerVmConfig = lab;
    const observed: LabRunnerConfigObservation = nativePort("container");
    const app = createLabRunnerDiagnostics(ports);
    const a: LabRunnerSnapshot = snapshot(), b: string = status(undefined), c: string = smoke(), d: number = cli([]);
    const e: ContainerVmContractSnapshot = app.snapshot("cwd").defaultContainer;
    const published: undefined = ports.publishOutput("text");
    void [labPort, observed, a, b, c, d, e, published];
    // @ts-expect-error Application cwd is an explicit observation.
    app.snapshot();
    // @ts-expect-error Snapshot is synchronous.
    const promise: Promise<LabRunnerSnapshot> = app.snapshot("cwd"); void promise;
    // @ts-expect-error Publishers cannot be asynchronous.
    createLabRunnerDiagnostics({ ...ports, publishOutput: async () => undefined });
    // @ts-expect-error Usage cannot return void.
    createLabRunnerDiagnostics({ ...ports, publishUsage: (): void => {} });
    // @ts-expect-error Native observations cannot return false in production types.
    createLabRunnerDiagnostics({ ...ports, labRunnerVmConfig: () => false });
    // @ts-expect-error Native group id is a number.
    createLabRunnerDiagnostics({ ...ports, containerVmConfig: () => ({ ...observed, kvmGroupId: "0" }) });
    // @ts-expect-error Path observations cannot be Promise values.
    createLabRunnerDiagnostics({ ...ports, resolveProjectPath: async () => "cwd" });
}
void contracts;

describe("lab diagnostic current declarations", () => {
    it("keeps inward modules free of native and ambient dependencies", () => {
        for (const layer of ["domain", "ports", "application"]) {
            const source = readFileSync(resolve(import.meta.dirname, `../../${layer}/lab-runner-diagnostics.ts`), "utf8");
            expect(source).not.toMatch(/(?:from\s+["'][^"']*(?:docker|utils|container-runtime)|\bprocess\.|\bconsole\.|node:)/);
        }
    });
    it("strictly consumes freshly emitted declarations, with no missing or stale fallback", () => {
        const root = resolve(import.meta.dirname, "../../..");
        const configPath = resolve(root, "tsconfig.json");
        const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, root);
        const outputs = new Map<string, string>();
        const emit = ts.createProgram(parsed.fileNames, { ...parsed.options, emitDeclarationOnly: true, noEmitOnError: true });
        const result = emit.emit(undefined, (path, text) => outputs.set(resolve(path), text));
        expect(result.emitSkipped).toBe(false);
        const names = ["lab-runner-admin", "domain/lab-runner-diagnostics", "ports/lab-runner-diagnostics", "application/lab-runner-diagnostics"];
        for (const name of names) {
            const path = resolve(root, `dist/${name}.d.ts`);
            expect(outputs.has(path), `fresh declaration ${name}`).toBe(true);
            expect(existsSync(path), `root must build current declaration ${name}`).toBe(true);
            expect(readFileSync(path, "utf8")).toBe(outputs.get(path));
        }
        const consumer = resolve(root, "__lab_diagnostics_declaration_consumer.ts");
        const text = `import { labRunnerSnapshot, formatLabRunnerStatus, formatLabRunnerSmoke, labsCli } from './dist/lab-runner-admin.js';\nimport { createLabRunnerDiagnostics } from './dist/application/lab-runner-diagnostics.js';\nimport type { LabRunnerSnapshot } from './dist/domain/lab-runner-diagnostics.js';\ndeclare const ports: Parameters<typeof createLabRunnerDiagnostics>[0];\nconst a: LabRunnerSnapshot=labRunnerSnapshot(); const b:string=formatLabRunnerStatus(); const c:string=formatLabRunnerSmoke(undefined); const d:number=labsCli([]); const e:undefined=ports.publishUsage('usage'); void [a,b,c,d,e];\n// @ts-expect-error Synchronous snapshot\nconst p:Promise<LabRunnerSnapshot>=createLabRunnerDiagnostics(ports).snapshot('cwd'); void p;\n// @ts-expect-error Synchronous publisher\ncreateLabRunnerDiagnostics({...ports,publishOutput:async()=>undefined});\n`;
        const host = ts.createCompilerHost(parsed.options), originalRead = host.readFile.bind(host), originalExists = host.fileExists.bind(host);
        host.readFile = path => resolve(path) === consumer ? text : originalRead(path);
        host.fileExists = path => resolve(path) === consumer || originalExists(path);
        const program = ts.createProgram([consumer], { ...parsed.options, rootDir: root, noEmit: true }, host);
        expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
    });
});
