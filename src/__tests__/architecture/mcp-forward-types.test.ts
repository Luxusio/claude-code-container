import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function checkConsumer(tree: "src" | "dist") {
    const entry = join(root, `mcp-forward-${tree}-type-consumer.ts`);
    const prefix = `./${tree}`;
    const text = `
import { buildMcpConfig, readHostMcpServers, rewriteLocalhostUrl, processServerForContainer } from '${prefix}/mcp-forward.js';
import { createMcpConfigRegenerator } from '${prefix}/application/mcp-forward.js';
import type { McpConfigRegenerationPorts } from '${prefix}/ports/mcp-forward.js';
import type { McpServerConfig } from '${prefix}/domain/mcp-forward.js';
const bare: string[] = buildMcpConfig();
const profiled: string[] = buildMcpConfig('work', () => {});
const explicit: string[] = buildMcpConfig(undefined, undefined);
const host: Record<string, McpServerConfig> = readHostMcpServers();
const url: string = rewriteLocalhostUrl('http://localhost');
const server: McpServerConfig = processServerForContainer('x', {command:'node'});
// @ts-expect-error public generator is synchronous
const promise: Promise<string[]> = buildMcpConfig();
// @ts-expect-error optional profile still requires a string
buildMcpConfig(1);
// @ts-expect-error URL remains a string
rewriteLocalhostUrl(1);
type Claude = { readonly claude: unique symbol };
type Codex = { readonly codex: unique symbol };
declare const c: Claude;
declare const d: Codex;
const ports: McpConfigRegenerationPorts<Claude, Codex> = {
 resolveClaudeProfile: () => c,
 readClaudeProfileDocument: binding => { const typed: Claude = binding; return undefined; },
 readHostMcpDocument: () => undefined,
 withCodexProfileLock: <T>(profile: string | undefined, operation: () => T): T => operation(),
 prepareCodexProfile: () => ({binding:d, existingText:''}),
 publishCodexProfile: (binding, text) => { const typed: Codex = binding; return undefined; },
 publishClaudeProfile: (binding, text) => { const typed: Claude = binding; return undefined; },
};
const generated: string[] = createMcpConfigRegenerator(ports).build('work', () => {});
const generic: number = ports.withCodexProfileLock(undefined, () => 1);
// @ts-expect-error publication cannot become asynchronous
const badPublication: McpConfigRegenerationPorts<Claude, Codex>['publishCodexProfile'] = async () => {};
// @ts-expect-error Claude publication cannot become asynchronous
const badClaudePublication: McpConfigRegenerationPorts<Claude, Codex>['publishClaudeProfile'] = async () => {};
// @ts-expect-error native document reads cannot become asynchronous
const badRead: McpConfigRegenerationPorts<Claude, Codex>['readHostMcpDocument'] = async () => '';
// @ts-expect-error prepare must carry binding and existing text
const badPrepare: McpConfigRegenerationPorts<Claude, Codex>['prepareCodexProfile'] = () => d;
// @ts-expect-error opaque consumer bindings are distinct
ports.publishClaudeProfile(d, '');
// @ts-expect-error synchronous build cannot become Promise
const badBuild: Promise<string[]> = createMcpConfigRegenerator(ports).build();
`;
    const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, rootDir: root, noUnusedLocals: false, noUnusedParameters: false };
    const host = ts.createCompilerHost(options);
    const originalRead = host.readFile.bind(host); const originalExists = host.fileExists.bind(host); const originalSource = host.getSourceFile.bind(host);
    host.readFile = file => resolve(file) === entry ? text : originalRead(file);
    host.fileExists = file => resolve(file) === entry || originalExists(file);
    host.getSourceFile = (file, language, onError, fresh) => resolve(file) === entry ? ts.createSourceFile(file, text, language, true) : originalSource(file, language, onError, fresh);
    const program = ts.createProgram([entry], options, host);
    return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

it("strict current source consumers preserve four exports and all synchronous semantic ports", () => {
    expect(checkConsumer("src")).toEqual([]);
});
it("strict current emitted declarations preserve the same consumer contract", () => {
    // Root must build the candidate before this suite; an absent declaration is a failure.
    for (const file of ["mcp-forward", "application/mcp-forward", "ports/mcp-forward", "domain/mcp-forward", "domain/mcp-managed-toml"]) expect(existsSync(join(root, "dist", `${file}.d.ts`))).toBe(true);
    expect(readFileSync(join(root, "dist/ports/mcp-forward.d.ts"), "utf8")).toContain("McpConfigRegenerationPorts");
    expect(checkConsumer("dist")).toEqual([]);
});
it("inward modules have only domain and port dependencies and no ambient authorities", () => {
    for (const file of ["domain/mcp-forward.ts", "domain/mcp-managed-toml.ts", "ports/mcp-forward.ts", "application/mcp-forward.ts"]) {
        const text = readFileSync(join(root, "src", file), "utf8");
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
        const imports = source.statements.filter(ts.isImportDeclaration).map(statement => (statement.moduleSpecifier as ts.StringLiteral).text);
        expect(imports.every(name => /^\.\.\/(domain|ports)\//.test(name) || /^\.\//.test(name))).toBe(true);
        expect(text).not.toMatch(/\b(?:process|globalThis|require)\b|node:|from ["'](?:fs|os|path|crypto|child_process)["']/);
    }
});
