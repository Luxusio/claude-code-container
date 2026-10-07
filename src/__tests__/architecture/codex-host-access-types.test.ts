import { expect, it } from "vitest";
import { createCodexHostAccessRestoration } from "../../application/credentials/codex-host-access.js";
import type { CodexHostAccessPorts } from "../../ports/credentials/codex-host-access.js";

function contracts(ports: CodexHostAccessPorts) {
    const app = createCodexHostAccessRestoration(ports);
    const result: undefined = app.restore("target", "profile");
    const uid: number = ports.inspectParent("config").uid;
    void [result, uid];
    // @ts-expect-error All eight ports are required.
    createCodexHostAccessRestoration({});
    // @ts-expect-error Ports are required.
    createCodexHostAccessRestoration();
    // @ts-expect-error Target is required.
    app.restore();
    // @ts-expect-error Profile is a string.
    app.restore("target", 1);
    // @ts-expect-error Core is synchronous.
    const promise: Promise<undefined> = app.restore("target");
    void promise;
    // @ts-expect-error Capabilities are readonly.
    ports.resolveConfig = () => "config";
    // @ts-expect-error Capabilities are readonly.
    ports.accessConfig = () => undefined;
    // @ts-expect-error Capabilities are readonly.
    ports.hasHostIdentity = () => true;
    // @ts-expect-error Capabilities are readonly.
    ports.inspectParent = () => ({ uid: 1, isDirectory: () => true });
    // @ts-expect-error Capabilities are readonly.
    ports.inspectConfig = () => ({ isFile: () => true });
    // @ts-expect-error Capabilities are readonly.
    ports.currentHostUid = () => 1;
    // @ts-expect-error Capabilities are readonly.
    ports.repairConfig = () => undefined;
    // @ts-expect-error Capabilities are readonly.
    ports.warn = () => undefined;
    // @ts-expect-error Metadata UID is readonly.
    ports.inspectParent("config").uid = 2;
    // @ts-expect-error Metadata method is readonly.
    ports.inspectParent("config").isDirectory = () => false;
    // @ts-expect-error Metadata method is readonly.
    ports.inspectConfig("config").isFile = () => false;
    // @ts-expect-error Ports expose no Node metadata.
    ports.inspectConfig("config").nlink;
    // @ts-expect-error Resolve is synchronous.
    createCodexHostAccessRestoration({ ...ports, resolveConfig: async () => "config" });
    // @ts-expect-error Access is synchronous undefined.
    createCodexHostAccessRestoration({ ...ports, accessConfig: async () => undefined });
    // @ts-expect-error Identity is synchronous.
    createCodexHostAccessRestoration({ ...ports, hasHostIdentity: async () => true });
    // @ts-expect-error Parent metadata is synchronous.
    createCodexHostAccessRestoration({ ...ports, inspectParent: async () => ({ uid: 1, isDirectory: () => true }) });
    // @ts-expect-error Config metadata is synchronous.
    createCodexHostAccessRestoration({ ...ports, inspectConfig: async () => ({ isFile: () => true }) });
    // @ts-expect-error UID is synchronous.
    createCodexHostAccessRestoration({ ...ports, currentHostUid: async () => 1 });
    // @ts-expect-error Repair is synchronous undefined.
    createCodexHostAccessRestoration({ ...ports, repairConfig: async () => undefined });
    // @ts-expect-error Warn is synchronous undefined.
    createCodexHostAccessRestoration({ ...ports, warn: async () => undefined });
    // @ts-expect-error Void is not undefined.
    createCodexHostAccessRestoration({ ...ports, repairConfig: (): void => {} });
    // @ts-expect-error Node metadata must retain a method, not classified boolean.
    createCodexHostAccessRestoration({ ...ports, inspectConfig: () => ({ isFile: true }) });
}
void contracts;
it("exposes a two-argument synchronous restore", () => {
    const ports: CodexHostAccessPorts = { resolveConfig: () => "config", accessConfig: () => undefined, hasHostIdentity: () => true,
        inspectParent: () => ({ uid: 1, isDirectory: () => true }), inspectConfig: () => ({ isFile: () => true }),
        currentHostUid: () => 1, repairConfig: () => undefined, warn: () => undefined };
    expect(createCodexHostAccessRestoration(ports).restore("target")).toBeUndefined();
});
