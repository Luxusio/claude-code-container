// Checked by the normal strict architecture compiler; never invoked.
import * as net from 'node:net';
import { PROXY_PORT, tryConnect, proxyConnection, startProxy, stopProxy } from '../../localhost-proxy.js';
import { setupLocalhostProxy } from '../../localhost-proxy-setup.js';
import { createLocalhostProxy } from '../../application/localhost-proxy.js';
import { createLocalhostProxyVerifier } from '../../application/localhost-proxy-setup.js';
import type { ForwardingStream } from '../../ports/localhost-proxy.js';
import type { LocalhostProxyVerifierPorts } from '../../ports/localhost-proxy-setup.js';

function contracts(socket: net.Socket, server: net.Server, original: ForwardingStream<Buffer, net.Socket>) {
     
    const literalPort: 19999 = PROXY_PORT;
    const facet: ForwardingStream<Buffer, net.Socket> = socket;
    const dial: Promise<net.Socket> = tryConnect('127.0.0.1', 123);
    const forward: Promise<void> = proxyConnection(socket, 123);
    const defaults: Promise<void> = proxyConnection(socket, 0, undefined, undefined, 0);
    const listener: Promise<net.Server> = startProxy();
    const stopped: void = stopProxy(server);
    const configured: void = setupLocalhostProxy('owned');
    void configured;
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

    const wrote: boolean = original.write(Buffer.from('x'));
    const piped: net.Socket = original.pipe(socket);
    const destroyed: net.Socket = original.destroy();
    // @ts-expect-error write return carrier is synchronous boolean
    const asyncWrite: ForwardingStream<Buffer, net.Socket>['write'] = async () => true;
    // @ts-expect-error pipe returns the owned native stream
    const asyncPipe: ForwardingStream<Buffer, net.Socket>['pipe'] = async () => socket;
    // @ts-expect-error destroy returns the native owned stream synchronously
    const asyncDestroy: ForwardingStream<Buffer, net.Socket>['destroy'] = async () => socket;
    // @ts-expect-error listener presence remains a synchronous semantic boolean
    const asyncPresence: LocalhostProxyVerifierPorts['proxyListenerPresent'] = async () => true;
    // @ts-expect-error native process result carriers do not cross the setup port
    const nativeObservation: LocalhostProxyVerifierPorts['proxyListenerPresent'] = () => ({status:0});
    // @ts-expect-error unavailable notification cannot silently become asynchronous
    const asyncUnavailable: LocalhostProxyVerifierPorts['reportUnavailable'] = async () => {};
    // @ts-expect-error direct-reach notification cannot silently become asynchronous
    const asyncReachable: LocalhostProxyVerifierPorts['reportDirectReachable'] = async () => {};
    // @ts-expect-error direct-reach notification carries latency, not terminal prose
    const stringLatency: LocalhostProxyVerifierPorts['reportDirectReachable'] = (_message: string) => undefined;
    // @ts-expect-error direct reach retains the exact 1500ms caller budget
    const wrongReach: LocalhostProxyVerifierPorts['directReach'] = (_container: string, _timeout: 5000) => ({reachable:false,latencyMs:0});
    const verifier = createLocalhostProxyVerifier({
    platform: () => 'linux', containerHostRemote: () => false,
    directReach: (_container: string, _timeout: number) => ({reachable: false, latencyMs: 7}),
    proxyListenerPresent: (_container: string) => true,
    debugFlag: () => undefined, reportDirectReachable: (_latencyMs: number) => undefined, reportUnavailable: (_container: string) => undefined,
    });
    const verified: void = verifier.setup('owned');
    // @ts-expect-error verifier remains synchronous
    const asyncVerified: Promise<void> = verifier.setup('owned');

    void [literalPort, facet, dial, forward, defaults, listener, stopped, app, application, synchronous, wrongDial, asyncStop, wrote, piped, destroyed, asyncWrite, asyncPipe, asyncDestroy, asyncPresence, nativeObservation, asyncUnavailable, asyncReachable, stringLatency, wrongReach, verifier, verified, asyncVerified];
}
void contracts;
