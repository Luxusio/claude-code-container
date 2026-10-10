import { iosControlRequest, iosContainerRelativePathAllowed } from "../domain/ios-control-transfer.mjs";
/** @template Result @param {import("../ports/ios-control-transfer.mjs").IosControlTransferPorts<Result>} ports */
export function createIosControlTransfer(ports) {
    const physical = ports.kind === "physical";
    /** @param {string|null} xcrun @param {string} target @param {string} bundleId @param {string} type */
    function resolveContainer(xcrun, target, bundleId, type) {
        if (ports.kind !== "simulator") {
            throw new Error("Simulator transfer is unavailable for physical iOS");
        }
        const result = ports.appContainerCommand(xcrun, target, bundleId, type);
        if (result.status !== 0) {
            return {
                error: result
            };
        }
        const containerRoot = result.stdout.trim();
        if (!containerRoot) {
            return {
                error: {
                    ...result, status: 1, stderr: "simctl get_app_container returned an empty path"
                }
            };
        }
        return {
            containerRoot
        };
    }
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
    /** @param {string} name @param {import("../ports/ios-control-transfer.mjs").IosControlArgs} args */
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
                    return ports.textResult(false, `Refusing iOS Simulator upload for non-owned simulator name: ${device.simulatorName}`);
                }
                if (!bundleId) {
                    return ports.textResult(false, "iOS Simulator upload requires bundleId to resolve an app container");
                }
                if (!localPath || !remotePath) {
                    return ports.textResult(false, "iOS Simulator upload requires localPath and remotePath");
                }
                const localStage = ports.stageInput(localPath);
                if (!localStage.ok) {
                    return ports.textResult(false, localStage.message);
                }
                try {
                    const discovery = ports.discovery();
                    if (!discovery.available) {
                        return ports.missingPrerequisites(discovery);
                    }
                    const ownedTarget = ports.verifyTarget(discovery.xcrun, device);
                    if (ownedTarget.error !== undefined) {
                        return ports.textResult(false, ownedTarget.error);
                    }
                    const type = (containerType || "data");
                    const container = resolveContainer(discovery.xcrun, ownedTarget.target, bundleId, type);
                    if (container.error) {
                        return ports.fail(container.error);
                    }
                    const target = containedPath(container.containerRoot, remotePath);
                    if ("error" in target) {
                        return ports.textResult(false, target.error);
                    }
                    const containment = ports.guardWrite(container.containerRoot, target.path);
                    if (containment.error) {
                        return ports.textResult(false, containment.error);
                    }
                    const copied = ports.copyInput(localStage, target.path);
                    if (!copied.ok) {
                        return ports.textResult(false, copied.message);
                    }
                    return ports.jsonResult({
                        uploaded: {
                            localPath: localStage.path, remotePath: target.relativePath, bundleId, containerType: type
                        },
                        containerRoot: container.containerRoot,
                        provider: "simctl-app-container"
                    });
                }
                finally {
                    ports.disposeStage(localStage);
                }
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
                    return ports.textResult(false, `Refusing iOS Simulator download for non-owned simulator name: ${device.simulatorName}`);
                }
                if (!bundleId) {
                    return ports.textResult(false, "iOS Simulator download requires bundleId to resolve an app container");
                }
                if (!remotePath || !localPath) {
                    return ports.textResult(false, "iOS Simulator download requires remotePath and localPath");
                }
                const localStage = ports.stageOutput(localPath);
                if (!localStage.ok) {
                    return ports.textResult(false, localStage.message);
                }
                try {
                    const discovery = ports.discovery();
                    if (!discovery.available) {
                        return ports.missingPrerequisites(discovery);
                    }
                    const ownedTarget = ports.verifyTarget(discovery.xcrun, device);
                    if (ownedTarget.error !== undefined) {
                        return ports.textResult(false, ownedTarget.error);
                    }
                    const type = (containerType || "data");
                    const container = resolveContainer(discovery.xcrun, ownedTarget.target, bundleId, type);
                    if (container.error) {
                        return ports.fail(container.error);
                    }
                    const source = containedPath(container.containerRoot, remotePath);
                    if ("error" in source) {
                        return ports.textResult(false, source.error);
                    }
                    if (!ports.exists(source.path)) {
                        return ports.textResult(false, `iOS Simulator download remotePath does not exist in app container: ${source.relativePath}`);
                    }
                    const containment = ports.guardRead(container.containerRoot, source.path);
                    if (containment.error) {
                        return ports.textResult(false, containment.error);
                    }
                    const staged = ports.populateOutput(source.path, localStage);
                    if (!staged.ok) {
                        return ports.textResult(false, staged.message);
                    }
                    const committed = ports.commitOutput(localStage);
                    if (!committed.ok) {
                        return ports.textResult(false, committed.message);
                    }
                    return ports.jsonResult({
                        downloaded: {
                            remotePath: source.relativePath, localPath: committed.path, bundleId, containerType: type
                        },
                        containerRoot: container.containerRoot,
                        provider: "simctl-app-container"
                    });
                }
                finally {
                    ports.disposeStage(localStage);
                }
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
                    return ports.textResult(false, request.error);
                }
                if ("invalidOrientation" in request) {
                    return ports.textResult(false, `${physical ? "iOS real-device" : "iOS Simulator"} mobile_set_orientation requires portrait, landscape, reverse-portrait, or reverse-landscape`);
                }
                const resolved = await ports.resolveSession(args.deviceId);
                if (resolved.unknown === true) {
                    return undefined;
                }
                if (resolved.error !== undefined) {
                    return ports.textResult(false, resolved.error);
                }
                try {
                    await ports.requestSession(resolved, request.path, request.body);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return ports.textResult(false, `${physical ? "iOS real-device" : "iOS Simulator"} Appium request failed: ${message}`);
                }
                return ports.jsonResult({
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
