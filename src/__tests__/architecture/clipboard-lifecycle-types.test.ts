import { describe, expect, it } from "vitest";
import { createClipboardServerLifecycle } from "../../application/clipboard/server-lifecycle.js";
import type { ClipboardServerLifecyclePorts } from "../../ports/clipboard/server-lifecycle.js";
import type { ensureClipboardServer, stopClipboardServerIfLast, retireClipboardServerFromPortFile } from "../../clipboard-server.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type PublicEnsure = Assert<Equal<typeof ensureClipboardServer, () => Promise<number>>>;
type PublicStop = Assert<Equal<typeof stopClipboardServerIfLast, (hasOtherActiveSessions: boolean) => void>>;
type PublicRetire = Assert<Equal<typeof retireClipboardServerFromPortFile, (portFile: string) => void>>;
const publicShapes: [PublicEnsure, PublicStop, PublicRetire] = [true, true, true]; void publicShapes;
function compileContracts(ports: ClipboardServerLifecyclePorts<{ lock: true }, { child: true }>) {
    const app = createClipboardServerLifecycle(ports, "literal-version");
    const ready: Promise<number> = app.ensureClipboardServer(); const stop: void = app.stopClipboardServerIfLast(false);
    const retire: void = app.retireClipboardServerFromPortFile("raw-port"); const release: undefined = ports.releaseStartupLock({ lock: true });
    void [ready, stop, retire, release];
    // @ts-expect-error Server version is supplied at composition import time.
    createClipboardServerLifecycle(ports);
    // @ts-expect-error Release is an ignored synchronous effect, not void.
    createClipboardServerLifecycle({ ...ports, releaseStartupLock: (): void => {} }, "version");
    // @ts-expect-error Release cannot adopt a Promise.
    createClipboardServerLifecycle({ ...ports, releaseStartupLock: async () => undefined }, "version");
    // @ts-expect-error Unref cannot adopt a Promise.
    createClipboardServerLifecycle({ ...ports, unrefDaemon: async () => undefined }, "version");
    // @ts-expect-error Warning remains a synchronous ignored effect.
    createClipboardServerLifecycle({ ...ports, warnUpgradeDeferred: async () => undefined }, "version");
    // @ts-expect-error Native file observation is synchronous.
    createClipboardServerLifecycle({ ...ports, readPortFile: async () => null }, "version");
    // @ts-expect-error Lock observations are synchronous.
    createClipboardServerLifecycle({ ...ports, tryAcquireStartupLock: async () => null }, "version");
    // @ts-expect-error Health is asynchronous and authenticated.
    createClipboardServerLifecycle({ ...ports, checkHealth: () => ({ alive: true }) }, "version");
    // @ts-expect-error Health requires token and address.
    ports.checkHealth(123);
    // @ts-expect-error Daemon launch cannot hide an asynchronous whole workflow.
    createClipboardServerLifecycle({ ...ports, launchDaemon: async () => ({ child: true } as const) }, "version");
    // @ts-expect-error Stop must receive an explicit caller observation.
    app.stopClipboardServerIfLast();
    // @ts-expect-error No string truth-value coercion occurs.
    app.stopClipboardServerIfLast("false");
    // @ts-expect-error Retirement preserves a string explicit path.
    app.retireClipboardServerFromPortFile(null);
    // @ts-expect-error Retirement does not return a Promise.
    const adopted: Promise<void> = app.retireClipboardServerFromPortFile("path"); void adopted;
}
void compileContracts;
describe("Clipboard lifecycle type contract", () => {
    it("keeps the factory independent from native resources", () => { expect(createClipboardServerLifecycle.name).toBe("createClipboardServerLifecycle"); });
});
