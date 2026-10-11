// Checked by the normal strict architecture compiler; never invoked.
type Claude = { readonly claude: unique symbol };
type Codex = { readonly codex: unique symbol };

import { buildMcpConfig, readHostMcpServers, rewriteLocalhostUrl, processServerForContainer } from '../../mcp-forward.js';
import { createMcpConfigRegenerator } from '../../application/mcp-forward.js';
import type { McpConfigRegenerationPorts } from '../../ports/mcp-forward.js';
import type { McpServerConfig } from '../../domain/mcp-forward.js';

function contracts(c: Claude, d: Codex) {
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

    const ports: McpConfigRegenerationPorts<Claude, Codex> = {
    resolveClaudeProfile: () => c,
    readClaudeProfileDocument: binding => { const typed: Claude = binding; void typed; return undefined; },
    readHostMcpDocument: () => undefined,
    withCodexProfileLock: <T>(_profile: string | undefined, operation: () => T): T => operation(),
    prepareCodexProfile: () => ({binding:d, existingText:''}),
    publishCodexProfile: (binding, _text) => { const typed: Codex = binding; void typed; return undefined; },
    publishClaudeProfile: (binding, _text) => { const typed: Claude = binding; void typed; return undefined; },
    };
    const generated: string[] = createMcpConfigRegenerator(ports).build('work', () => {});
    const generic: number = ports.withCodexProfileLock(undefined, () => 1);
    // @ts-expect-error publication cannot become asynchronous
    const badPublication: McpConfigRegenerationPorts<Claude, Codex>['publishCodexProfile'] = async () => {};
    // @ts-expect-error Claude publication cannot become asynchronous
    const badClaudePublication: McpConfigRegenerationPorts<Claude, Codex>['publishClaudeProfile'] = async () => {};
    // @ts-expect-error native document reads cannot become asynchronous
    const badRead: McpConfigRegenerationPorts<Claude, Codex>['readHostMcpDocument'] = async () => '';
    // @ts-expect-error the native read capability itself cannot become asynchronous
    const badCapability: McpConfigRegenerationPorts<Claude, Codex>['readHostMcpDocument'] = () => async () => '';
    // @ts-expect-error prepare must carry binding and existing text
    const badPrepare: McpConfigRegenerationPorts<Claude, Codex>['prepareCodexProfile'] = () => d;
    // @ts-expect-error opaque consumer bindings are distinct
    ports.publishClaudeProfile(d, '');
    // @ts-expect-error synchronous build cannot become Promise
    const badBuild: Promise<string[]> = createMcpConfigRegenerator(ports).build();

    void [bare, profiled, explicit, host, url, server, promise, ports, generated, generic, badPublication, badClaudePublication, badRead, badCapability, badPrepare, badBuild];
}
void contracts;
