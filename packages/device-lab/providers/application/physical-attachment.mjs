import { attachmentDuplicate,attachmentRecord } from '../domain/physical-attachment.mjs';
/** @typedef {import('../ports/physical-attachment.mjs').AttachmentOutcome} Outcome */
/** @param {import('../ports/physical-attachment.mjs').PhysicalAttachmentPorts} ports */
export function createPhysicalAttachmentApplication(ports) {
    /** @param {import('../ports/physical-attachment.mjs').AttachRequest} args @returns {Outcome} */
    function attach(args) {
        return ports.backend === 'android-device' ? attachAndroid(ports,args) : attachIos(ports,args);
    }
    /** @param {import('../ports/physical-attachment.mjs').AndroidAttachmentPorts} ports @param {import('../ports/physical-attachment.mjs').AttachRequest} args @returns {Outcome} */
    function attachAndroid(ports,args) {
            const { backend, name: deviceName, deviceId, serial, connection = "usb", host, port = 5555 } = args;
            if (backend !== "android-device") return { kind: "missing" };
            /** @type {string|null|undefined} */
            let resolvedSerial = serial;
            const leaseClaimNonce = ports.nonce();
            /** @type {import("../ports/physical-leases.mjs").PhysicalLeaseResult|null} */
            let lease = null;
            /** @param {string} hardwareId @param {string} id @param {unknown} primary */
            const releaseClaimedLease = (hardwareId, id, primary) => {
                try {
                    if (lease?.lease) ports.releaseLease(hardwareId, id, {
                        claimId: lease.lease.claimId,
                        claimNonce: leaseClaimNonce,
                    });
                } catch (cleanup) {
                    throw new AggregateError([primary, cleanup], "Physical attachment compensation failed", {cause: primary});
                }
            };

            const discovery = ports.discover();
            if (!discovery.adb) return { kind: "error", message: "Android real-device backend missing prerequisites: adb" };
            const devices = ports.read();
            if (connection === "wifi") {
                resolvedSerial = serial ? ports.wifiSerial(serial, port) : ports.wifiSerial(host, port);
                if (!host && !serial) return { kind: "error", message: "Android Wi-Fi attach requires host or serial in host:port form" };
                const connectTarget = resolvedSerial;
                if (!connectTarget) return { kind: "error", message: "Android Wi-Fi attach requires a valid host and port" };
                const id = deviceId || ports.deriveId(deviceName || connectTarget);
                const duplicate=attachmentDuplicate(devices,id,"serial",connectTarget);
                if (duplicate) return {kind:"error",message:duplicate};
                lease = ports.claimLease(connectTarget, id, { claimNonce: leaseClaimNonce });
                if (!lease.ok) {
                    return { kind: "error", message: `Android serial is already attached or an attach is in progress: ${connectTarget}` };
                }
                const connect = ports.connect(discovery.adb, connectTarget);
                if (!connect.ok) {
                    /** @type {Outcome} */
                    const refusal = { kind: "command-failure", command: connect.receipt };
                    releaseClaimedLease(connectTarget, id, refusal);
                    return refusal;
                }
                resolvedSerial = connectTarget;
            }
            if (!resolvedSerial) return { kind: "error", message: "Android real-device attach requires serial" };
            if (String(resolvedSerial).startsWith("emulator-")) return { kind: "error", message: `Refusing to attach emulator serial through android-device backend: ${resolvedSerial}` };
            const inventory = ports.inventory(discovery);
            const hostDevice = inventory.devices.find((device) => device.serial === resolvedSerial);
            if (!hostDevice) {
                /** @type {Outcome} */
                const refusal = { kind: "error", message: `Android device is not visible to adb: ${resolvedSerial}` };
                if (connection === "wifi") releaseClaimedLease(resolvedSerial, deviceId || ports.deriveId(deviceName || resolvedSerial), refusal);
                return refusal;
            }
            if (!hostDevice.attachable) {
                /** @type {Outcome} */
                const refusal = { kind: "error", message: `Android device ${resolvedSerial} is not attachable; adb state is ${hostDevice.state}` };
                if (connection === "wifi") releaseClaimedLease(resolvedSerial, deviceId || ports.deriveId(deviceName || resolvedSerial), refusal);
                return refusal;
            }

            const id = deviceId || ports.deriveId(deviceName || resolvedSerial);
            const duplicate=attachmentDuplicate(devices,id,"serial",resolvedSerial);
            if (duplicate) return {kind:"error",message:duplicate};
            if (connection !== "wifi") {
                lease = ports.claimLease(resolvedSerial, id, { claimNonce: leaseClaimNonce });
                if (!lease.ok) {
                    return { kind: "error", message: `Android serial is already attached or an attach is in progress: ${resolvedSerial}` };
                }
            }
            if (!lease?.ok) return { kind: "error", message: "Android serial is already attached or an attach is in progress: " + resolvedSerial };
            const resolvedConnection = hostDevice.connection || connection;

            const device = {
                ...attachmentRecord(backend,id,deviceName || resolvedSerial,{owner:ports.owner(),port:ports.appiumPort(id),claimId:lease.lease.claimId,nonce:leaseClaimNonce,attachedAt:ports.now(),updatedAt:ports.now()}),
                serial:resolvedSerial,connection:resolvedConnection,
                transport:resolvedConnection === "wifi" ? ports.wifiTransport(resolvedSerial,host,port) : {type:"usb",host:null,port:null},hostDetails:hostDevice.details,
            };
            let claim;
            try {
                claim = ports.claim(device);
            } catch (error) {
                releaseClaimedLease(resolvedSerial, id, error);
                throw error;
            }
            if (!claim.ok) {
                /** @type {Outcome} */
                const refusal = { kind: "error", message: `Device identity already exists for this owner (${claim.field}: ${claim.value})` };
                releaseClaimedLease(resolvedSerial, id, refusal);
                return refusal;
            }
            ports.startHeartbeat(resolvedSerial, id, {
                claimId: lease.lease.claimId,
                claimNonce: leaseClaimNonce,
            });
            return { kind: "attached", device };

    }
    /** @param {import('../ports/physical-attachment.mjs').IosAttachmentPorts} ports @param {import('../ports/physical-attachment.mjs').AttachRequest} args @returns {Outcome} */
    function attachIos(ports,args) {
            const { backend, name: deviceName, deviceId, udid, connection, host, port } = args;
            if (backend !== "ios-device") return { kind: "missing" };
            if (!udid) return { kind: "error", message: "iOS real-device attach requires udid" };
            const discovery = ports.discover();
            if (!discovery.xcrun) return { kind: "error", message: "iOS real-device backend missing prerequisites: xcrun" };
            const inventory = ports.inventory(discovery);
            const hostDevice = inventory.devices.find((device) => device.udid === udid);
            if (!hostDevice) return { kind: "error", message: `iOS device is not visible to xctrace: ${udid}` };
            if (connection === "wifi" && hostDevice.connection !== "wifi") {
                return { kind: "error", message: `iOS Wi-Fi attach requires the device to be paired for network use and visible to xctrace as a network device: ${udid}` };
            }
            const resolvedConnection = connection || hostDevice.connection || "usb";

            const id = deviceId || ports.deriveId(deviceName || hostDevice.name || udid);
            const devices = ports.read();
            const duplicate=attachmentDuplicate(devices,id,"udid",udid);
            if (duplicate) return {kind:"error",message:duplicate};
            const leaseClaimNonce = ports.nonce();
            const lease = ports.claimLease(udid, id, { claimNonce: leaseClaimNonce });
            if (!lease.ok) {
                return { kind: "error", message: `iOS UDID is already attached or an attach is in progress: ${udid}` };
            }

            const device = {
                ...attachmentRecord(backend,id,deviceName || hostDevice.name || udid,{owner:ports.owner(),port:ports.appiumPort(id),claimId:lease.lease.claimId,nonce:leaseClaimNonce,attachedAt:ports.now(),updatedAt:ports.now()}),
                udid,connection:resolvedConnection,transport:{type:resolvedConnection,host:resolvedConnection === "wifi" ? host || null : null,port:resolvedConnection === "wifi" ? port || null : null,visibleVia:"xctrace"},hostDetails:hostDevice,
            };
            /** @param {unknown} primary */
            const releaseClaimedLease = (primary) => {
                try {
                    ports.releaseLease(udid, id, { claimId: lease.lease.claimId, claimNonce: leaseClaimNonce });
                } catch (cleanup) {
                    throw new AggregateError([primary, cleanup], "Physical attachment compensation failed", {cause: primary});
                }
            };
            let claim;
            try {
                claim = ports.claim(device);
            } catch (error) {
                releaseClaimedLease(error);
                throw error;
            }
            if (!claim.ok) {
                /** @type {Outcome} */
                const refusal = { kind: "error", message: `Device identity already exists for this owner (${claim.field}: ${claim.value})` };
                releaseClaimedLease(refusal);
                return refusal;
            }
            ports.startHeartbeat(udid, id, { claimId: lease.lease.claimId, claimNonce: leaseClaimNonce });
            return { kind: "attached", device };

    }
    /** @param {string} id @param {string} operation @param {{found:boolean}} transition @returns {Outcome} */
    function conflict(id,operation,transition) {return {kind:'conflict',backend:ports.backend,deviceId:id,operation,found:transition.found};}
    /** @param {string} deviceId @returns {Promise<Outcome>} */
    async function detach(deviceId) {
        const device=ports.read().find(item=>item.id===deviceId);
        if (!device) return {kind:'missing'};
        const claim=ports.stop.claimLifecycle(deviceId,device,'detach');
        if (!claim.transition.matched) return conflict(deviceId,'detach-claim',claim.transition);
        const adb=ports.backend==='android-device' ? ports.discover().adb : undefined;
        const stopped=await ports.stop.cleanup(device,adb);
        if (!stopped.exited) {
            ports.stop.abortLifecycle(deviceId,claim.lifecycle,device,ports.backend==='ios-device' && stopped.recordingStopped
                ? {recording:{...device.recording,active:false,endedAt:ports.now()}} : {});
            return {kind:'error',message:stopped.error};
        }
        const current=ports.stop.currentLifecycleDevice(deviceId,claim.lifecycle);
        if (!current) return conflict(deviceId,'detach',{found:Boolean(ports.find(deviceId))});
        const label=ports.backend==='android-device'?'Android':'iOS';
        let released;
        try {
            released=ports.releaseWithMutation(ports.backend==='android-device'?device.serial:device.udid,deviceId,{claimId:device.leaseClaimId,claimNonce:device.leaseClaimNonce},()=>{
                const transition=ports.transition(deviceId,current,null);
                if (!transition.matched) return {ok:false,transition};
                return {ok:true,transition,rollback(){
                    const restored=ports.claim(current);
                    if (!restored.ok) throw new Error(`${ports.backend}-detach-state-rollback-failed:${restored.error}`);
                    return undefined;
                }};
            });
        } catch(error) {
            ports.stop.abortLifecycle(deviceId,claim.lifecycle,device);
            return {kind:'error',message:`${label} physical device detach could not commit lease release; owner state and physical lease were preserved for retry: ${error instanceof Error?error.message:String(error)}`};
        }
        if (!released.ok) {
            if (released.error==='physical-lease-release-mutation-rejected') return conflict(deviceId,'detach',released.mutation?.transition || {found:Boolean(ports.find(deviceId))});
            ports.stop.abortLifecycle(deviceId,claim.lifecycle,device);
            return {kind:'error',message:`${label} physical device detach lease release was rejected (${released.error || 'lease-conflict'}); owner state and physical lease were preserved for retry.`};
        }
        return {kind:'detached',deviceId};
    }
    return {attach,detach};
}
