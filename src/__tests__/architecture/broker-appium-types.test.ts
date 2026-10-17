import { describe, expect, it } from "vitest";
import { createBrokerAppiumApplication } from "../../../packages/device-lab/src/device-lab/application/broker-appium.js";
import { validateAppiumRequestParams, type BrokerAppiumResponse, type BrokerAppiumExecution } from "../../../packages/device-lab/src/device-lab/domain/broker-appium.js";
import type { BrokerAppiumPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-appium.js";
import type { BrokerPortProcessResolver } from "../../../packages/device-lab/src/device-lab-broker.js";

function listenerAllowanceContracts<Runtime>(ports: BrokerAppiumPorts<Runtime>): void {
    const legacyVerification: BrokerAppiumPorts<Runtime>["verifyListener"] = _appium => ({ ok: false, error: "unavailable", receipt: null });
    const boundedVerification: BrokerAppiumPorts<Runtime>["verifyListener"] = (_appium, remainingMs) => {
        const duration: number | undefined = remainingMs?.();
        void duration;
        return { ok: false, error: "unavailable", receipt: null };
    };
    ports.verifyListener({}, () => 50);
    const legacyResolver: BrokerPortProcessResolver = (_port, _platform) => null;
    const boundedResolver: BrokerPortProcessResolver = (_port, _platform, remainingMs) => {
        const duration: number | undefined = remainingMs?.();
        void duration;
        return null;
    };
    boundedResolver(4723, "darwin", () => 50);
    // @ts-expect-error Listener handoff carries a relative callback, not an absolute deadline.
    ports.verifyListener({}, 12345);
    // @ts-expect-error Native discovery receives the same relative callback contract.
    boundedResolver(4723, "darwin", 12345);
    void [legacyVerification, boundedVerification, legacyResolver];
}
void listenerAllowanceContracts;

function appiumCapabilityContracts<Runtime>(ports: BrokerAppiumPorts<Runtime>): void {
    const app = createBrokerAppiumApplication(ports);
    const params = { backend: "android-emulator", deviceId: "pixel" };
    const responses: Promise<BrokerAppiumResponse>[] = [
        app.start("owner", params), app.stop("owner", params),
        app.ensureSession("owner", params), app.deleteSession("owner", params),
        app.request("owner", { ...params, method: "GET", path: "/source" }),
        app.record("owner", { ...params, sessionId: "session" }), app.clear("owner", params),
    ];
    const { publish: _publish, ...withoutPublication } = ports;
    // @ts-expect-error State publication must retain its expected-generation authority.
    createBrokerAppiumApplication(withoutPublication);
    const { withDeviceOperation: _deviceLock, ...withoutDeviceLock } = ports;
    // @ts-expect-error Appium mutations require the owner/device operation lock.
    createBrokerAppiumApplication(withoutDeviceLock);
    const { withInstallLock: _installLock, ...withoutInstallLock } = ports;
    // @ts-expect-error Managed runtime installation requires the shared native install lock.
    createBrokerAppiumApplication(withoutInstallLock);
    const monotonic: number = ports.monotonicNow();
    const wall: number = ports.now();
    const { monotonicNow: _monotonicNow, ...withoutElapsedClock } = ports;
    // @ts-expect-error Readiness and listener admission require the existing elapsed capability.
    createBrokerAppiumApplication(withoutElapsedClock);
    // @ts-expect-error The elapsed clock returns a numeric local observation.
    createBrokerAppiumApplication({ ...ports, monotonicNow: () => "wall timestamp" });
    // @ts-expect-error Native elapsed observations do not consume a transported Unix deadline.
    ports.monotonicNow(Date.now());
    // @ts-expect-error Native publication must return a settled generation comparison.
    createBrokerAppiumApplication({ ...ports, publish: async () => ({ found: true, matched: true, currentAppium: null, device: null }) });
    // @ts-expect-error Manifest publication must settle before npm execution or runtime reuse.
    createBrokerAppiumApplication({ ...ports, writeManifest: async () => undefined });
    // @ts-expect-error Synchronous installation commands require a concrete completed execution.
    createBrokerAppiumApplication({ ...ports, installRuntime: async () => ({ ok: true, receipt: {} }) });
    const { launchServer, ...withoutLaunch } = ports;
    // @ts-expect-error Server launch is a required finite native effect.
    createBrokerAppiumApplication(withoutLaunch);
    const { status, ...withoutStatus } = ports;
    // @ts-expect-error Listener status is a required finite effect with a readiness fact.
    createBrokerAppiumApplication(withoutStatus);
    const { inspectSession, ...withoutInspection } = ports;
    // @ts-expect-error Existing-session inspection cannot be replaced by generic HTTP.
    createBrokerAppiumApplication(withoutInspection);
    const { createSession, ...withoutCreation } = ports;
    // @ts-expect-error Session creation is required and supplies semantic ID/recovery facts.
    createBrokerAppiumApplication(withoutCreation);
    const { deleteSession, ...withoutDeletion } = ports;
    // @ts-expect-error Exact-session deletion is required for compensation and explicit deletion.
    createBrokerAppiumApplication(withoutDeletion);
    const { sessionCommand, ...withoutCommand } = ports;
    // @ts-expect-error Admitted session commands are a required finite native effect.
    createBrokerAppiumApplication(withoutCommand);
    // @ts-expect-error A generic HTTP escape hatch is not part of the semantic contract.
    ports.http("http://127.0.0.1:4723/status", {});
    // @ts-expect-error The core cannot inspect an upstream HTTP body.
    const rawBody = async () => (await ports.status("http://127.0.0.1:4723", 1000)).body;
    // @ts-expect-error The core cannot inspect an upstream HTTP status code.
    const rawStatus = async () => (await ports.createSession("http://127.0.0.1:4723", {}, 1000)).status;
    // @ts-expect-error Native receipts remain opaque to the policy layer.
    const decodedReceipt = async () => (await ports.inspectSession("http://127.0.0.1:4723", "session", 1000)).receipt.body;
    const responseBody = (outcome: BrokerAppiumResponse) => {
        if ("response" in outcome && outcome.response) {
            // @ts-expect-error Application outcomes retain opaque evidence rather than HTTP bodies.
            return outcome.response.body;
        }
    };
    // @ts-expect-error Instrumentation reset settles each effect before the next step.
    createBrokerAppiumApplication({ ...ports, resetInstrumentation: async () => ({ ok: true, receipt: {} }) });
    // @ts-expect-error The core cannot construct an arbitrary native process recipe.
    ports.execute({ executable: "appium", args: [] });
    // @ts-expect-error CCC HTTP payloads are rendered outside the application.
    const payload = (awaited: BrokerAppiumResponse) => awaited.payload;
    // @ts-expect-error Operation locks and cleanup settle before the response is available.
    const synchronous: BrokerAppiumResponse = app.stop("owner", params);
    void [responses, _publish, _deviceLock, _installLock, monotonic, wall, _monotonicNow, synchronous, launchServer, payload,
        status, inspectSession, createSession, deleteSession, sessionCommand, rawBody, rawStatus, decodedReceipt, responseBody];
}
void appiumCapabilityContracts;

function appiumEffectContracts<Runtime>(ports: BrokerAppiumPorts<Runtime>): void {
    const endpoint = "http://127.0.0.1:4723";
    const sessionId = "session";
    const timeoutMs = 1000;
    const status: Promise<{ ok: boolean; receipt: unknown; ready: boolean }> = ports.status(endpoint, timeoutMs);
    const inspection: Promise<{ ok: boolean; receipt: unknown }> = ports.inspectSession(endpoint, sessionId, timeoutMs);
    const creation: Promise<{ ok: boolean; receipt: unknown; sessionId: string | null; instrumentationInitializationFailed: boolean }> =
        ports.createSession(endpoint, { platformName: "Android" }, timeoutMs);
    const deletion: Promise<{ ok: boolean; receipt: unknown }> = ports.deleteSession(endpoint, sessionId, timeoutMs);
    const command: Promise<{ ok: boolean; receipt: unknown }> =
        ports.sessionCommand(endpoint, sessionId, { method: "GET", path: "/source", body: null }, timeoutMs);
    const postCommand: Promise<{ ok: boolean; receipt: unknown }> =
        ports.sessionCommand(endpoint, sessionId, { method: "POST", path: "/back", body: {} }, timeoutMs);

    // @ts-expect-error Status requires a string endpoint.
    ports.status(4723, timeoutMs);
    // @ts-expect-error Status consumes a numeric timeout.
    ports.status(endpoint, "1000");
    // @ts-expect-error Session inspection requires a string endpoint.
    ports.inspectSession(4723, sessionId, timeoutMs);
    // @ts-expect-error Session inspection consumes the exact string session ID.
    ports.inspectSession(endpoint, 1, timeoutMs);
    // @ts-expect-error Session inspection consumes a numeric timeout.
    ports.inspectSession(endpoint, sessionId, "1000");
    // @ts-expect-error Session creation requires a string endpoint.
    ports.createSession(4723, {}, timeoutMs);
    // @ts-expect-error Session creation consumes capabilities rather than a serialized HTTP body.
    ports.createSession(endpoint, "{}", timeoutMs);
    // @ts-expect-error Session creation consumes a numeric timeout.
    ports.createSession(endpoint, {}, "1000");
    // @ts-expect-error Session deletion requires a string endpoint.
    ports.deleteSession(4723, sessionId, timeoutMs);
    // @ts-expect-error Session deletion consumes the exact string session ID.
    ports.deleteSession(endpoint, 1, timeoutMs);
    // @ts-expect-error Session deletion consumes a numeric timeout.
    ports.deleteSession(endpoint, sessionId, "1000");
    // @ts-expect-error Session commands require a string endpoint.
    ports.sessionCommand(4723, sessionId, { method: "GET", path: "/source", body: null }, timeoutMs);
    // @ts-expect-error Session commands consume the exact string session ID.
    ports.sessionCommand(endpoint, 1, { method: "GET", path: "/source", body: null }, timeoutMs);
    // @ts-expect-error Session commands admit GET or POST; deletion is a separate effect.
    ports.sessionCommand(endpoint, sessionId, { method: "DELETE", path: "/source", body: null }, timeoutMs);
    // @ts-expect-error Session commands consume a string path.
    ports.sessionCommand(endpoint, sessionId, { method: "GET", path: 1, body: null }, timeoutMs);
    // @ts-expect-error Session commands explicitly carry their admitted body, including null for GET.
    ports.sessionCommand(endpoint, sessionId, { method: "GET", path: "/source" }, timeoutMs);
    // @ts-expect-error Session commands consume a numeric timeout.
    ports.sessionCommand(endpoint, sessionId, { method: "GET", path: "/source", body: null }, "1000");

    // @ts-expect-error Status observations must include the native readiness fact.
    createBrokerAppiumApplication({ ...ports, status: async () => ({ ok: true, receipt: {} }) });
    // @ts-expect-error Session inspection observations must include opaque native evidence.
    createBrokerAppiumApplication({ ...ports, inspectSession: async () => ({ ok: true }) });
    // @ts-expect-error Session creation observations must include a semantic session ID or null.
    createBrokerAppiumApplication({ ...ports, createSession: async () => ({ ok: true, receipt: {}, instrumentationInitializationFailed: false }) });
    // @ts-expect-error Session creation observations must include the native instrumentation recovery fact.
    createBrokerAppiumApplication({ ...ports, createSession: async () => ({ ok: true, receipt: {}, sessionId: null }) });
    // @ts-expect-error Session creation cannot expose a non-string session ID.
    createBrokerAppiumApplication({ ...ports, createSession: async () => ({ ok: true, receipt: {}, sessionId: 1, instrumentationInitializationFailed: false }) });
    // @ts-expect-error Session deletion observations must include semantic success.
    createBrokerAppiumApplication({ ...ports, deleteSession: async () => ({ receipt: {} }) });
    // @ts-expect-error Session command observations must include opaque native evidence.
    createBrokerAppiumApplication({ ...ports, sessionCommand: async () => ({ ok: true }) });
    void [status, inspection, creation, deletion, command, postCommand];
}
void appiumEffectContracts;

function appiumCommandContracts<Runtime>(ports: BrokerAppiumPorts<Runtime>, runtime: Runtime): void {
    const launch: Promise<BrokerAppiumExecution> = ports.launchServer(runtime, { backend: "android-emulator", port: 4723, timeoutMs: 1000 });
    const installation: BrokerAppiumExecution = ports.installRuntime(runtime, 300000);
    const reset: BrokerAppiumExecution = ports.resetInstrumentation("emulator-5580", "force-stop-server");
    const semantic = { ok: true, pid: 12345, processIdentity: Symbol("process identity"), receipt: Symbol("native evidence") };
    const semanticLaunch: BrokerAppiumPorts<Runtime>["launchServer"] = async () => semantic;
    const semanticInstall: BrokerAppiumPorts<Runtime>["installRuntime"] = () => semantic;
    const semanticReset: BrokerAppiumPorts<Runtime>["resetInstrumentation"] = () => ({ ok: false, receipt: Symbol("failed reset evidence") });
    const legacyRaw = { status: 0, pid: 12345, receipt: {} };
    // @ts-expect-error A predeclared native launch result lacks required semantic success.
    const legacyLaunch: BrokerAppiumPorts<Runtime>["launchServer"] = async () => legacyRaw;
    // @ts-expect-error A predeclared native install result lacks required semantic success.
    const legacyInstall: BrokerAppiumPorts<Runtime>["installRuntime"] = () => legacyRaw;
    // @ts-expect-error A predeclared native reset result lacks required semantic success.
    const legacyReset: BrokerAppiumPorts<Runtime>["resetInstrumentation"] = () => legacyRaw;
    // @ts-expect-error Application policy cannot read a native command exit status.
    const nativeStatus = installation.status;
    // @ts-expect-error Application policy cannot read a native command error.
    const nativeError = reset.error;
    // @ts-expect-error Command evidence remains opaque rather than exposing native result fields.
    const decodedReceipt = async () => (await launch).receipt.status;
    void [launch, installation, reset, semanticLaunch, semanticInstall, semanticReset,
        legacyLaunch, legacyInstall, legacyReset, nativeStatus, nativeError, decodedReceipt];
}
void appiumCommandContracts;

describe("Appium request contracts", () => {
    it("rejects upstream DELETE commands while session deletion remains a separate broker operation", () => {
        expect(validateAppiumRequestParams({ backend: "android-emulator", deviceId: "pixel", method: "DELETE", path: "/source" })).toEqual({
            ok: false, reason: "invalid", error: "invalid-appium-request-method", allowed: ["GET", "POST"],
        });
    });

    it("rejects a path escaping the broker-owned WebDriver session", () => {
        expect(validateAppiumRequestParams({ backend: "android-emulator", deviceId: "pixel", method: "GET", path: "/../source" })).toEqual({
            ok: false, reason: "invalid", error: "invalid-appium-request-path",
        });
    });
});
