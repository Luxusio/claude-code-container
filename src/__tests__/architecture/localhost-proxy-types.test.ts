import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function check(tree: "src" | "dist") {
    const entry = join(root, `localhost-proxy-${tree}-consumer.ts`);
    const text = `
import * as net from 'node:net';
import { PROXY_PORT, tryConnect, proxyConnection, startProxy, stopProxy } from './${tree}/localhost-proxy.js';
import { setupLocalhostProxy } from './${tree}/localhost-proxy-setup.js';
import { createLocalhostProxy } from './${tree}/application/localhost-proxy.js';
import { createLocalhostProxyVerifier } from './${tree}/application/localhost-proxy-setup.js';
import type { ForwardingStream } from './${tree}/ports/localhost-proxy.js';
import type { LocalhostProxyVerifierPorts } from './${tree}/ports/localhost-proxy-setup.js';
declare const socket: net.Socket; declare const server: net.Server;
const literalPort: 19999 = PROXY_PORT;
const facet: ForwardingStream<Buffer, net.Socket> = socket;
const dial: Promise<net.Socket> = tryConnect('127.0.0.1', 123);
const forward: Promise<void> = proxyConnection(socket, 123);
const defaults: Promise<void> = proxyConnection(socket, 0, undefined, undefined, 0);
const listener: Promise<net.Server> = startProxy();
const stopped: void = stopProxy(server); const configured: void = setupLocalhostProxy('owned');
const app = createLocalhostProxy<Buffer, net.Socket>({connect: tryConnect});
const application: Promise<void> = app.proxyConnection(socket, 123);
// @ts-expect-error native chunks must remain Buffer compatible
socket.write({fake: true});
// @ts-expect-error routing port is asynchronous
createLocalhostProxy<Buffer, net.Socket>({connect: () => socket});
// @ts-expect-error forwarding result is Promise<void>
const synchronous: void = app.proxyConnection(socket, 123);
// @ts-expect-error connect resolves a Socket, not a server
const wrongDial: Promise<net.Server> = tryConnect('local', 1);
// @ts-expect-error stop is synchronous void
const asyncStop: Promise<void> = stopProxy(server);
declare const original: ForwardingStream<Buffer, net.Socket>;
const wrote: boolean = original.write(Buffer.from('x'));
const piped: net.Socket = original.pipe(socket);
const destroyed: net.Socket = original.destroy();
// @ts-expect-error write return carrier is synchronous boolean
const asyncWrite: ForwardingStream<Buffer, net.Socket>['write'] = async () => true;
// @ts-expect-error pipe returns the owned native stream
const asyncPipe: ForwardingStream<Buffer, net.Socket>['pipe'] = async () => socket;
// @ts-expect-error destroy returns the native owned stream synchronously
const asyncDestroy: ForwardingStream<Buffer, net.Socket>['destroy'] = async () => socket;
// @ts-expect-error observation does not erase synchronous native result semantics
const asyncObservation: LocalhostProxyVerifierPorts['proxyListenerObservation'] = async () => ({status:0});
// @ts-expect-error diagnostics cannot silently become asynchronous
const asyncWarning: LocalhostProxyVerifierPorts['reportWarning'] = async () => {};
// @ts-expect-error direct reach retains the exact 1500ms caller budget
const wrongReach: LocalhostProxyVerifierPorts['directReach'] = (_container: string, _timeout: 5000) => ({reachable:false,latencyMs:0});
const verifier = createLocalhostProxyVerifier({
platform: () => 'linux', containerHostRemote: () => false,
directReach: (_container: string, _timeout: number) => ({reachable: false, latencyMs: 7}),
proxyListenerObservation: (_container: string) => ({status: 0}),
debugFlag: () => undefined, runtimeName: () => 'docker', reportDebug: (_message: string) => undefined, reportWarning: (_message: string) => undefined,
});
const verified: void = verifier.setup('owned');
// @ts-expect-error verifier remains synchronous
const asyncVerified: Promise<void> = verifier.setup('owned');
`;
    const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const options = { ...parsed.options, noEmit: true, rootDir: root, noUnusedLocals: false, noUnusedParameters: false };
    const host = ts.createCompilerHost(options); const read = host.readFile.bind(host); const exists = host.fileExists.bind(host); const source = host.getSourceFile.bind(host);
    host.readFile = file => resolve(file) === entry ? text : read(file); host.fileExists = file => resolve(file) === entry || exists(file);
    host.getSourceFile = (file, language, onError, fresh) => resolve(file) === entry ? ts.createSourceFile(file, text, language, true) : source(file, language, onError, fresh);
    return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host)).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}
it.each(["src", "dist"] as const)("strict current %s consumer accepts native Socket/Buffer without casts", tree => {
    if (tree === "dist") for (const file of ["localhost-proxy", "localhost-proxy-setup", "ports/localhost-proxy", "ports/localhost-proxy-setup", "application/localhost-proxy", "application/localhost-proxy-setup", "domain/localhost-proxy"]) expect(existsSync(join(root, tree, `${file}.d.ts`))).toBe(true);
    expect(check(tree)).toEqual([]);
});
it("logical inward TS and Go source closure does not import ambient native authorities", () => {
    for (const file of ["domain/localhost-proxy.ts", "ports/localhost-proxy.ts", "ports/localhost-proxy-setup.ts", "application/localhost-proxy.ts", "application/localhost-proxy-setup.ts"]) {
        const text = readFileSync(join(root, "src", file), "utf8");
        expect(text).not.toMatch(/\b(?:process|globalThis|require)\b|node:|from ["'](?:net|fs|child_process)["']/);
    }
    for (const file of ["policy.go", "ports.go", "application.go"]) {
        const text = readFileSync(join(root, "scripts/localhost-proxy", file), "utf8");
        expect(text).not.toMatch(/"(?:net|os|syscall|unsafe|time|io)"/);
    }
    for (const family of ["Dockerfile", "Containerfile"]) {
        const text = readFileSync(join(root, family), "utf8");
        expect(text).toMatch(/COPY\s+scripts\/localhost-proxy\//); expect(text).toMatch(/go build[^\n]*\./);
    }
    // npm inclusion and both assembled payloads are a separate root-owned gate.
});
