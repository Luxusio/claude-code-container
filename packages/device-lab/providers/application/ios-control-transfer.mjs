import { iosControlRequest, iosContainerRelativePathAllowed } from "../domain/ios-control-transfer.mjs";
/** @typedef {import("../ports/ios-control-transfer.mjs").IosControlResult} ControlResult */
/** @typedef {ControlResult | {kind:'thrown',error:unknown}} TransferPrimary */
/** @param {import("../ports/ios-control-transfer.mjs").IosSimulatorControlPorts} ports
 * @param {import("../ports/ios-control-transfer.mjs").IosTransferStage} stage
 * @param {TransferPrimary} primary
 * @returns {import("../ports/ios-control-transfer.mjs").IosControlOutcome} */
function finalizeStage(ports, stage, primary) {
    try { ports.disposeStage(stage); }
    catch (error) { return { kind: "cleanup-failure", primary, error }; }
    if (primary.kind === "thrown") throw primary.error;
    return primary;
}
/** @param {import("../ports/ios-control-transfer.mjs").IosControlTransferPorts} ports */
export function createIosControlTransfer(ports) {
    const physical = ports.kind === "physical";
    /** @param {string} root @param {string} requestedPath */
    function containedPath(root, requestedPath) {
        if (ports.kind !== "simulator") {
            throw new Error("Simulator transfer is unavailable for physical iOS");
        }
        const facts = ports.pathFacts(root, requestedPath);
        if (!iosContainerRelativePathAllowed(facts)) {
            return {
                error: `Refusing path outside iOS app container: ${requestedPath}`
            };
        }
        return facts;
    }
    /** @param {string} name @param {import("../ports/ios-control-transfer.mjs").IosControlArgs} args
     * @returns {Promise<import("../ports/ios-control-transfer.mjs").IosControlOutcome|undefined>} */
    async function handle(name, args) {
        switch (name) {
            case "device_upload": {
                if (ports.kind !== "simulator") {
                    return undefined;
                }
                const { deviceId, localPath, remotePath, bundleId, containerType } = args;
                const device = ports.findDevice(deviceId);
                if (!device) {
                    return undefined;
                }
                if (!ports.ownedSimulatorName(device.simulatorName)) {
                    return textOutcome(`Refusing iOS Simulator upload for non-owned simulator name: ${device.simulatorName}`);
                }
                if (!bundleId) {
                    return textOutcome("iOS Simulator upload requires bundleId to resolve an app container");
                }
                if (!localPath || !remotePath) {
                    return textOutcome("iOS Simulator upload requires localPath and remotePath");
                }
                const localStage = ports.stageInput(localPath);
                if (!localStage.ok) {
                    return textOutcome(localStage.message);
                }
                /** @type {TransferPrimary} */
                let primary;
                try {
                    transfer: {
                        const discovery = ports.discovery();
                        if (!discovery.available) {
                            primary = textOutcome(`iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}`);
                            break transfer;
                        }
                        const ownedTarget = ports.verifyTarget(discovery.xcrun, device);
                        if (ownedTarget.error !== undefined) {
                            primary = textOutcome(ownedTarget.error);
                            break transfer;
                        }
                        const type = (containerType || "data");
                        const container = ports.resolveContainer(discovery.xcrun, ownedTarget.target, bundleId, type);
                        if (container.kind === "failed") {
                            primary = commandOutcome(container.receipt);
                            break transfer;
                        }
                        const target = containedPath(container.containerRoot, remotePath);
                        if ("error" in target) {
                            primary = textOutcome(target.error);
                            break transfer;
                        }
                        const containment = ports.guardWrite(container.containerRoot, target.path);
                        if (containment.error) {
                            primary = textOutcome(containment.error);
                            break transfer;
                        }
                        const copied = ports.copyInput(localStage, target.path);
                        if (!copied.ok) {
                            primary = textOutcome(copied.message);
                            break transfer;
                        }
                        primary = jsonOutcome({
                            uploaded: {
                                localPath: localStage.path, remotePath: target.relativePath, bundleId, containerType: type
                            },
                            containerRoot: container.containerRoot,
                            provider: "simctl-app-container"
                        });
                    }
                } catch (error) { primary = { kind: "thrown", error }; }
                return finalizeStage(ports, localStage, primary);
            }
            case "device_download": {
                if (ports.kind !== "simulator") {
                    return undefined;
                }
                const { deviceId, remotePath, localPath, bundleId, containerType } = args;
                const device = ports.findDevice(deviceId);
                if (!device) {
                    return undefined;
                }
                if (!ports.ownedSimulatorName(device.simulatorName)) {
                    return textOutcome(`Refusing iOS Simulator download for non-owned simulator name: ${device.simulatorName}`);
                }
                if (!bundleId) {
                    return textOutcome("iOS Simulator download requires bundleId to resolve an app container");
                }
                if (!remotePath || !localPath) {
                    return textOutcome("iOS Simulator download requires remotePath and localPath");
                }
                const localStage = ports.stageOutput(localPath);
                if (!localStage.ok) {
                    return textOutcome(localStage.message);
                }
                /** @type {TransferPrimary} */
                let primary;
                try {
                    transfer: {
                        const discovery = ports.discovery();
                        if (!discovery.available) {
                            primary = textOutcome(`iOS Simulator backend missing prerequisites: ${discovery.missing.join(", ")}`);
                            break transfer;
                        }
                        const ownedTarget = ports.verifyTarget(discovery.xcrun, device);
                        if (ownedTarget.error !== undefined) {
                            primary = textOutcome(ownedTarget.error);
                            break transfer;
                        }
                        const type = (containerType || "data");
                        const container = ports.resolveContainer(discovery.xcrun, ownedTarget.target, bundleId, type);
                        if (container.kind === "failed") {
                            primary = commandOutcome(container.receipt);
                            break transfer;
                        }
                        const source = containedPath(container.containerRoot, remotePath);
                        if ("error" in source) {
                            primary = textOutcome(source.error);
                            break transfer;
                        }
                        if (!ports.exists(source.path)) {
                            primary = textOutcome(`iOS Simulator download remotePath does not exist in app container: ${source.relativePath}`);
                            break transfer;
                        }
                        const containment = ports.guardRead(container.containerRoot, source.path);
                        if (containment.error) {
                            primary = textOutcome(containment.error);
                            break transfer;
                        }
                        const staged = ports.populateOutput(source.path, localStage);
                        if (!staged.ok) {
                            primary = textOutcome(staged.message);
                            break transfer;
                        }
                        const committed = ports.commitOutput(localStage);
                        if (!committed.ok) {
                            primary = textOutcome(committed.message);
                            break transfer;
                        }
                        primary = jsonOutcome({
                            downloaded: {
                                remotePath: source.relativePath, localPath: committed.path, bundleId, containerType: type
                            },
                            containerRoot: container.containerRoot,
                            provider: "simctl-app-container"
                        });
                    }
                } catch (error) { primary = { kind: "thrown", error }; }
                return finalizeStage(ports, localStage, primary);
            }
            default: {
                const request = iosControlRequest(name, args);
                if (!request) {
                    return undefined;
                }
                if (!ports.findDevice(args.deviceId)) {
                    return undefined;
                }
                if ("error" in request) {
                    return textOutcome(request.error);
                }
                if ("invalidOrientation" in request) {
                    return textOutcome(`${physical ? "iOS real-device" : "iOS Simulator"} mobile_set_orientation requires portrait, landscape, reverse-portrait, or reverse-landscape`);
                }
                const resolved = await ports.resolveSession(args.deviceId);
                if (resolved.unknown === true) {
                    return undefined;
                }
                if (resolved.error !== undefined) {
                    return textOutcome(resolved.error);
                }
                const observation = await ports.performControl(resolved, request);
                if (observation.kind === "failed") return textOutcome(`${physical ? "iOS real-device" : "iOS Simulator"} Appium request failed: ${observation.message}`);
                return jsonOutcome({
                    ...request.payload, provider: "appium-xcuitest", ...(physical ? {
                        physical: true
                    } : {})
                });
            }
        }
    }
    return {
        handle
    };
}

/** @param {string} message */
function textOutcome(message) { return {kind: /** @type {const} */ ("text"), message}; }
/** @param {object} payload */
function jsonOutcome(payload) { return {kind: /** @type {const} */ ("json"), payload}; }
/** @param {unknown} receipt */
function commandOutcome(receipt) { return {kind: /** @type {const} */ ("command-failure"), receipt}; }
