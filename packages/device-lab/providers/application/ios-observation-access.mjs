import { iosResponseValue, iosSourceValue, iosScreenshotData, iosSessionId, iosActiveAppMatches, iosCleanAppObservation, iosAccessErrorMessage, iosAccessErrorCode, iosAccessUnsupported } from "../domain/ios-observation-access.mjs";

/** @template {import('../ports/ios-observation-access.mjs').IosAccessDevice} Device
 * @template Result
 * @param {import('../ports/ios-observation-access.mjs').IosObservationAccessPorts<Device,Result>} ports */
export function createIosObservationAccess(ports) {
    const physical = ports.kind === "physical";
    const label = physical ? "iOS physical" : "iOS Simulator";
    /** @typedef {import('../ports/ios-observation-access.mjs').IosAccessAppium} Appium */
    /** @typedef {import('../ports/ios-observation-access.mjs').IosAccessRuntime} Runtime */
    /** @typedef {import('../ports/ios-observation-access.mjs').IosAccessSession<Device>} Session */
    /** @typedef {import('../ports/ios-observation-access.mjs').IosAccessCommand} Command */
    /** @param {Appium|null|undefined} appium */
    async function serverReady(appium) {
        if (!appium?.serverUrl) return false;
        try { await ports.requestHttp(`${appium.serverUrl}/status`, { method: "GET" }); return true; }
        catch { return false; }
    }
    /** @param {Appium|null|undefined} appium @param {boolean} ready */
    async function sessionReady(appium, ready) {
        if (!appium?.sessionId || !ready) return false;
        try { await ports.requestHttp(`${appium.serverUrl}/session/${appium.sessionId}`, { method: "GET" }); return true; }
        catch { return false; }
    }
    /** @param {string} url */
    async function waitForServer(url) {
        for (let attempt = 0; attempt < 40; attempt += 1) {
            try { await ports.requestHttp(`${url}/status`, { method: "GET", timeoutMs: 1000 }); return true; }
            catch { await ports.pause(250); }
        }
        return false;
    }
    /** @param {Appium|null|undefined} appium */
    async function deleteSession(appium) {
        if (!appium?.serverUrl || !appium?.sessionId) return;
        try { await ports.requestHttp(`${appium.serverUrl}/session/${appium.sessionId}`, { method: "DELETE" }); }
        catch { /* best effort cleanup */ }
    }
    /** @param {Appium|null|undefined} appium @param {string} operationLabel
     * @returns {Promise<import('../ports/ios-observation-access.mjs').IosAccessTermination>} */
    async function stopOwnedAppium(appium, operationLabel) {
        const ownsProcess = Boolean(appium?.runtimeId && appium.processOwner === "device-lab-mcp"
            && appium.startedBy === "direct-provider" && appium.serverPid && appium.processIdentity);
        if (!ownsProcess) {
            await deleteSession(appium);
            return { exited: true, signaled: false, reason: "appium-process-identity-missing" };
        }
        const runtime = { ...appium, pid: appium?.serverPid };
        const observation = ports.inspectRuntime(runtime);
        if (observation.status === "exited") return { exited: true, signaled: false, reason: "runtime-process-exited" };
        if (observation.status !== "match") {
            const reason = observation.status === "mismatch" ? "runtime-process-identity-mismatch" : "runtime-process-identity-unavailable";
            return { exited: false, signaled: false, reason, error: `${operationLabel} process identity could not be verified: ${reason}` };
        }
        await deleteSession(appium);
        return ports.terminateRuntime(runtime, operationLabel);
    }
    /** @param {string|undefined} deviceId
     * @returns {Promise<import('../ports/ios-observation-access.mjs').IosAccessSessionOutcome<Device>>} */
    async function ensureSession(deviceId) {
        let device = ports.findDevice(deviceId);
        if (!device) return { unknown: true };
        if (ports.kind === "physical") {
            const lease = ports.refreshLease(device);
            if (!lease.ok) return { error: lease.error };
        }
        const discovery = ports.appiumDiscovery();
        if (!discovery.available) return { error: `${physical ? "iOS real-device" : "iOS"} Appium/XCUITest layer missing prerequisites: ${discovery.missing.join(", ")}` };
        let target = device.udid;
        if (ports.kind === "simulator") {
            const owned = ports.verifyTarget(discovery.xcrun, device);
            if (owned.error !== undefined) return { error: owned.error };
            target = owned.target;
        }
        const port = device.appiumPort || ports.portForDevice(device.id);
        const serverUrl = `http://127.0.0.1:${port}`;
        const ready = await serverReady(device.appium);
        if (await sessionReady(device.appium, ready) && device.appium?.serverUrl && device.appium.sessionId) {
            return { device, serverUrl: device.appium.serverUrl, sessionId: device.appium.sessionId };
        }
        const previous = device.appium ?? null;
        const ownsServer = Boolean(previous?.runtimeId && previous.processOwner === "device-lab-mcp"
            && previous.startedBy === "direct-provider" && previous.serverPid && previous.processIdentity);
        const reusable = ready && !ownsServer;
        if (ownsServer) {
            const stopped = await stopOwnedAppium(previous, `${label} stale Appium`);
            if (!stopped.exited) return { error: stopped.error };
        }
        const stale = ports.publishAppium(deviceId, previous, null, ports.timestamp());
        if (!stale.committed && stale.device?.appium != null) return { error: `${label} Appium state changed while reconciling a stale session` };
        device = stale.device;
        if (!device) return { unknown: true };
        const runtimeId = ports.runtimeId();
        const child = reusable ? null : ports.spawnServer(discovery.appium, port);
        const identity = child?.pid ? await ports.waitIdentity(child.pid, 1000) : null;
        if (child?.pid && !identity) {
            try { child.abortStartup(); } catch { /* startup child already exited */ }
            return { error: `${label} Appium process identity could not be established on ${serverUrl}` };
        }
        /** @type {Runtime|null} */
        let startup = child?.pid ? { runtimeId, serverPid: child.pid, pid: child.pid, processIdentity: identity } : null;
        /** @type {Appium|null} */
        let appium = null;
        if (child) {
            child.onExit(() => { if (appium) ports.publishAppium(deviceId, appium, null, ports.timestamp()); return undefined; });
            child.unref();
        }
        const usable = (reusable && previous?.serverUrl === serverUrl) || await waitForServer(serverUrl);
        if (startup) startup = ports.refreshRuntime(startup);
        if (!usable) {
            if (child?.pid) {
                const stopped = await ports.terminateRuntime(startup, `${label} Appium startup`);
                if (!physical && !stopped.exited) return { error: `${stopped.error}. Appium server did not become ready on ${serverUrl}` };
            }
            return { error: `Appium server did not become ready on ${serverUrl}` };
        }
        let response;
        try {
            response = await ports.requestHttp(`${serverUrl}/session`, { method: "POST", body: JSON.stringify({ capabilities: { alwaysMatch: {
                platformName: "iOS", "appium:automationName": "XCUITest", "appium:deviceName": physical ? device.name || device.id : device.simulatorName || device.name || device.id,
                "appium:udid": target, ...(physical ? { "appium:realDevice": true } : {}),
            } } }) });
        } catch (error) {
            if (child?.pid) await ports.terminateRuntime(startup, `${label} Appium startup`);
            return { error: `Appium session creation failed: ${iosAccessErrorMessage(error)}` };
        }
        const sessionId = iosSessionId(response);
        if (!sessionId) {
            if (child?.pid) await ports.terminateRuntime(startup, `${label} Appium startup`);
            return { error: "Appium did not return a session id" };
        }
        appium = { runtimeId, authority: "direct-provider", processOwner: child ? "device-lab-mcp" : "external",
            startedBy: child ? "direct-provider" : "existing-server", serverUrl, serverPid: child?.pid ?? null,
            processIdentity: startup?.processIdentity ?? null, sessionId, automationName: "XCUITest",
            ...(physical ? { physical: true } : {}), updatedAt: ports.timestamp() };
        const committed = ports.publishAppium(deviceId, null, appium, ports.timestamp());
        if (!committed.committed) {
            await deleteSession(appium);
            if (child?.pid) await ports.terminateRuntime(startup, `${label} Appium superseded startup`);
            return { error: `${label} Appium state changed before the new session was committed` };
        }
        const updated = ports.updateAppiumPort(deviceId, runtimeId, port, ports.timestamp());
        if (child?.pid && !ports.isAlive(child.pid)) {
            ports.publishAppium(deviceId, appium, null, ports.timestamp());
            return { error: `${label} Appium exited before the new session became usable` };
        }
        return { device: updated, serverUrl, sessionId };
    }
    /** @param {string|undefined} id
     * @returns {Promise<{kind:"unknown"}|{kind:"result",result:Result}|{kind:"ready",session:Session}>} */
    async function sessionForRequest(id) {
        let outcome;
        try { outcome = await ports.withDeviceOperation(id, () => ensureSession(id)); }
        catch (error) {
            if (iosAccessErrorCode(error) !== "shared-mutation-lock-timeout") throw error;
            return { kind: "result", result: ports.textResult(false, `${label} Appium operation lock failed: ${iosAccessErrorMessage(error)}`) };
        }
        if (outcome.unknown) return { kind: "unknown" };
        if (outcome.error !== undefined) return { kind: "result", result: ports.textResult(false, outcome.error) };
        return { kind: "ready", session: outcome };
    }
    /** @param {string|null} xcrun @param {string} target @param {string} bundleId @param {number} [timeoutMs] @param {number} [intervalMs] */
    async function waitForApp(xcrun, target, bundleId, timeoutMs = 10000, intervalMs = 500) {
        if (ports.kind !== "simulator") throw new Error("Simulator app observation is unavailable for physical iOS");
        const budget = ports.waitBudget(timeoutMs, intervalMs);
        /** @type {Command|null} */ let last = null;
        /** @type {Command|null} */ let observation = null;
        const hint = String(bundleId).split(".").filter(Boolean).at(-1) || String(bundleId);
        while (budget.remaining() > 0) {
            observation = null;
            for (const args of [["simctl", "spawn", target, "pgrep", "-f", bundleId], ["simctl", "spawn", target, "pgrep", "-i", "-f", hint]]) {
                const allowance = budget.requestTimeout();
                if (!allowance) break;
                const command = ports.execute(xcrun, args, allowance);
                last = command;
                const clean = iosCleanAppObservation(command);
                if (clean) observation = command;
                if (clean && command.status === 0 && command.stdout.trim()) return { running: true, pid: command.stdout.trim(), stdout: command.stdout, stderr: command.stderr, status: command.status };
            }
            for (const domain of ["user/501", "gui/501", "system"]) {
                const allowance = budget.requestTimeout();
                if (!allowance) break;
                const command = ports.execute(xcrun, ["simctl", "spawn", target, "launchctl", "print", domain], allowance);
                last = command;
                const clean = !command.error && !command.signal && command.status === 0;
                if (clean) observation = command;
                if (clean && String(command.stdout || "").toLowerCase().includes(String(bundleId).toLowerCase())) return {
                    running: true, pid: null, stdout: "", stderr: command.stderr, status: command.status, observedBy: `launchctl-${domain}`,
                };
            }
            await budget.pause();
        }
        if (!observation) {
            const cause = last ? [last.error?.code, last.error?.message, last.signal ? `signal ${last.signal}` : "", last.status != null ? `exit ${last.status}` : "", last.stderr || last.stdout].filter(Boolean).join(": ") : "No simulator app observation completed";
            return { error: { stderr: ports.diagnostic(`Unable to observe iOS Simulator app: ${cause || "command failed"}`, 4096), status: last?.status ?? null } };
        }
        return { running: false, timeoutMs: budget.timeoutMs, stdout: String(observation.stdout || "").slice(-512), stderr: String(observation.stderr || "").slice(-512), status: 0, nativeStatus: observation.status, observedBy: "pgrep-and-launchctl" };
    }
    /** @param {Device} device @param {import('../ports/ios-observation-access.mjs').IosAccessDiscovery} [discovery] */
    function automationStatus(device, discovery) {
        return { deviceId: device.id, appium: ports.appiumDiscovery(discovery), session: device.appium || null,
            automationName: "XCUITest", lazy: true, ...(physical ? { physical: true } : {}) };
    }
    /** @param {string} name @param {import('../ports/ios-observation-access.mjs').IosAccessArgs} args
     * @returns {Promise<Result|undefined>} */
    async function request(name, args) {
        if (!["device_status", "device_exec", "device_screenshot", "mobile_screenshot", "device_list_files", "device_reset",
            "mobile_session_status", "mobile_dump_ui", "mobile_wait_for_app", "mobile_wait_for_text",
            "mobile_back", "mobile_forward", "mobile_recents", "mobile_power"].includes(name)) return undefined;
        if (ports.kind === "physical" && (name === "device_list_files" || name === "device_reset")) return undefined;
        if (name === "device_reset" && !args.eraseSimulator) return undefined;
        if (name === "mobile_screenshot" && ports.kind === "simulator") return request("device_screenshot", { deviceId: args.deviceId });
        const device = ports.findDevice(args.deviceId);
        if (!device) return undefined;
        if (["mobile_back", "mobile_forward", "mobile_recents", "mobile_power"].includes(name)) return ports.textResult(false, iosAccessUnsupported(physical ? "physical" : "simulator", name));
        if (name === "device_status") {
            const discovery = ports.discovery();
            if (ports.kind === "physical") return ports.jsonResult({ device: ports.targetStatus(device), backend: ports.backend(discovery),
                hostDevice: discovery.xcrun ? ports.hostDevices(discovery).find(item => item.udid === device.udid) || null : null,
                appium: automationStatus(device, discovery) });
            return ports.jsonResult({ device: ports.targetStatus(ports.reconcileDevice(device, discovery)), backend: ports.backend(discovery), automation: automationStatus(device) });
        }
        if (name === "mobile_session_status") return ports.jsonResult({ deviceId: args.deviceId, ...automationStatus(device) });
        if (name === "device_exec") {
            if (ports.kind === "physical") return ports.textResult(false, iosAccessUnsupported("physical", name));
            const discovery = ports.discovery();
            if (!discovery.available) return ports.missingPrerequisites(discovery);
            const target = ports.verifyTarget(discovery.xcrun, device);
            if (target.error !== undefined) return ports.textResult(false, target.error);
            const command = ports.execute(discovery.xcrun, ["simctl", "spawn", target.target, "/bin/sh", "-lc", args.command]);
            return command.status === 0 ? ports.jsonResult({ stdout: command.stdout, stderr: command.stderr, status: command.status }) : ports.commandFailure(command);
        }
        if (name === "device_screenshot" && ports.kind === "simulator") {
            const discovery = ports.discovery();
            if (!discovery.available) return ports.missingPrerequisites(discovery);
            const target = ports.verifyTarget(discovery.xcrun, device);
            if (target.error !== undefined) return ports.textResult(false, target.error);
            const stage = ports.stageScreenshot();
            try {
                const command = ports.execute(discovery.xcrun, ["simctl", "io", target.target, "screenshot", stage.path], 30000);
                return command.status !== 0 ? ports.commandFailure(command) : ports.readScreenshot(stage.path);
            } finally { stage.dispose(); }
        }
        if (name === "device_list_files" && ports.kind === "simulator") {
            const error = ports.listArgumentError(args);
            if (error) return ports.jsonResult({ ok: false, error });
            if (!args.bundleId) return ports.jsonResult({ ok: false, error: "list-files-bundle-id-required", detail: "iOS Simulator listing requires bundleId to select an app container." });
            const discovery = ports.discovery();
            if (!discovery.available) return ports.missingPrerequisites(discovery);
            const target = ports.verifyTarget(discovery.xcrun, device);
            if (target.error !== undefined) return ports.textResult(false, target.error);
            const command = ports.appContainer(discovery.xcrun, target.target, args.bundleId, args.containerType || "data");
            if (command.status !== 0) return ports.commandFailure(command);
            const root = command.stdout.trim();
            if (!root) return ports.commandFailure({ ...command, status: 1, stderr: "simctl get_app_container returned an empty path" });
            const requested = (args.path || "").replace(/^[/\\]+/, "") || ".";
            if (requested.split(/[/\\]/).includes("..")) return ports.jsonResult({ ok: false, error: "list-files-container-escape" });
            const path = requested === "." ? { path: root } : ports.pathInContainer(root, requested);
            if (path.error !== undefined) return ports.textResult(false, path.error);
            const contained = ports.guardRead(root, path.path);
            if (contained.error) return ports.textResult(false, contained.error);
            try { return ports.jsonResult(ports.listDirectory(root, requested, args.limit ?? 100)); }
            catch (cause) { return ports.jsonResult({ ok: false, error: "list-files-container-read-failed", detail: iosAccessErrorCode(cause) || iosAccessErrorMessage(cause) }); }
        }
        if (name === "device_reset" && ports.kind === "simulator") {
            const discovery = ports.discovery();
            if (!discovery.available) return ports.missingPrerequisites(discovery);
            if (device.recording) return ports.textResult(false, `Refusing to erase ${args.deviceId} while a recording is active or pending finalization; stop the recording first`);
            const target = ports.verifyTarget(discovery.xcrun, device);
            if (target.error !== undefined) return ports.textResult(false, target.error);
            const command = ports.execute(discovery.xcrun, ["simctl", "erase", target.target]);
            if (command.status !== 0) return ports.commandFailure(command);
            const updated = ports.publishErased(args.deviceId, {
                status: "stopped", bootReady: false,
                lastReset: { eraseSimulator: true, resetAt: ports.timestamp(), stdout: command.stdout, stderr: command.stderr },
                updatedAt: ports.timestamp(),
            });
            return ports.jsonResult({ reset: { eraseSimulator: true }, device: updated, stdout: command.stdout, stderr: command.stderr, provider: "simctl" });
        }
        if (name === "mobile_wait_for_app" && ports.kind === "simulator") {
            if (!args.bundleId) return ports.textResult(false, "iOS Simulator wait-for-app requires bundleId");
            const discovery = ports.discovery();
            if (!discovery.available) return ports.missingPrerequisites(discovery);
            const target = ports.verifyTarget(discovery.xcrun, device);
            if (target.error !== undefined) return ports.textResult(false, target.error);
            const outcome = await waitForApp(discovery.xcrun, target.target, args.bundleId, args.timeoutMs, args.intervalMs);
            return outcome.error ? ports.commandFailure(outcome.error) : ports.jsonResult({ ...outcome, bundleId: args.bundleId, provider: "simctl" });
        }
        if ((name === "device_screenshot" || name === "mobile_screenshot" || name === "mobile_dump_ui") && ports.kind === "physical") {
            const session = await ensureSession(args.deviceId);
            if (session.unknown) return undefined;
            if (session.error !== undefined) return ports.textResult(false, session.error);
            const screenshot = name !== "mobile_dump_ui";
            let response;
            try { response = await ports.requestHttp(`${session.serverUrl}/session/${session.sessionId}/${screenshot ? "screenshot" : "source"}`, { method: "GET" }); }
            catch (error) { return ports.textResult(false, `Appium ${screenshot ? "screenshot" : "source"} request failed: ${iosAccessErrorMessage(error)}`); }
            if (screenshot) {
                const data = iosScreenshotData(response);
                return data ? ports.imageResult(data) : ports.textResult(false, "Appium did not return screenshot data");
            }
            return ports.jsonResult({ provider: "appium-xcuitest", physical: true, source: iosSourceValue(response), sessionId: session.sessionId, serverUrl: session.serverUrl });
        }
        if (name === "mobile_dump_ui") {
            const resolved = await sessionForRequest(args.deviceId);
            if (resolved.kind === "unknown") return undefined;
            if (resolved.kind === "result") return resolved.result;
            const session = resolved.session;
            let response;
            try { response = await ports.requestHttp(`${session.serverUrl}/session/${session.sessionId}/source`, { method: "GET" }); }
            catch (error) { return ports.textResult(false, `iOS Simulator Appium source request failed: ${iosAccessErrorMessage(error)}`); }
            return ports.jsonResult({ provider: "appium-xcuitest", source: iosSourceValue(response), sessionId: session.sessionId, serverUrl: session.serverUrl });
        }
        if (name === "mobile_wait_for_text" || name === "mobile_wait_for_app") {
            const textWait = name === "mobile_wait_for_text";
            if (textWait && !args.text) return ports.textResult(false, `${physical ? "iOS real-device" : "iOS Simulator"} wait-for-text requires text`);
            if (!textWait && !args.bundleId) return ports.textResult(false, "iOS real-device wait-for-app requires bundleId");
            const resolved = await sessionForRequest(args.deviceId);
            if (resolved.kind === "unknown") return undefined;
            if (resolved.kind === "result") return resolved.result;
            const session = resolved.session;
            const budget = ports.waitBudget(args.timeoutMs, args.intervalMs);
            let lastSource = "";
            /** @type {unknown} */ let lastApp = null;
            let observed = false;
            while (budget.remaining() > 0) {
                try {
                    ports.guardObservation(args.deviceId, device, session, budget);
                    const allowance = budget.requestTimeout(5000);
                    if (!allowance) throw new Error(physical ? "Appium observation budget exhausted before request" : "Appium observation budget exhausted before source request");
                    const response = await ports.requestHttp(`${session.serverUrl}/session/${session.sessionId}/${textWait ? "source" : "execute/sync"}`, {
                        method: textWait ? "GET" : "POST", timeoutMs: allowance,
                        ...(!textWait ? { body: JSON.stringify({ script: "mobile: activeAppInfo", args: [] }) } : {}),
                    });
                    ports.checkObservation(args.deviceId, device, session);
                    if (budget.remaining() <= 0) throw new Error(physical ? "Appium observation timed out" : "Appium source observation timed out");
                    observed = true;
                    if (textWait) {
                        lastSource = String(iosSourceValue(response) || "");
                        if (args.text && lastSource.includes(args.text)) return ports.jsonResult({ found: true, text: args.text, source: lastSource, provider: "appium-xcuitest", ...(physical ? { physical: true } : {}) });
                    } else {
                        lastApp = iosResponseValue(response);
                        if (args.bundleId && iosActiveAppMatches(lastApp, args.bundleId)) return ports.jsonResult({ found: true, bundleId: args.bundleId, activeApp: lastApp, provider: "appium-xcuitest", physical: true });
                    }
                } catch (error) {
                    return ports.textResult(false, `${textWait ? (physical ? "Appium source" : "iOS Simulator Appium source") : "iOS real-device Appium active app"} request failed: ${iosAccessErrorMessage(error)}`);
                }
                await budget.pause();
            }
            if (!observed) return ports.textResult(false, physical ? "Appium observation budget exhausted before request" : "Appium observation budget exhausted before source request");
            return ports.jsonResult(textWait
                ? { found: false, text: args.text, source: lastSource, timeoutMs: budget.timeoutMs, provider: "appium-xcuitest", ...(physical ? { physical: true } : {}) }
                : { found: false, bundleId: args.bundleId, activeApp: lastApp, timeoutMs: budget.timeoutMs, provider: "appium-xcuitest", physical: true });
        }
        return undefined;
    }
    return { request, ensureSession, stopOwnedAppium, deleteSession, waitForApp };
}
