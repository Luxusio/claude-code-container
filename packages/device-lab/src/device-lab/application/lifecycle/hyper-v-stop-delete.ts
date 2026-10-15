import { join } from "path";
import { hyperVField, hyperVSelectedDevice, hyperVStopReplacement, type HyperVOperationEvidence, type HyperVStopDeleteRequest, type HyperVStopDeleteOutcome, type HyperVStopDeletePreparation, type HyperVReplayResult, type HyperVPublication } from "../../domain/lifecycle/hyper-v-stop-delete.js";
import type { HyperVStopDeletePorts } from "../../ports/lifecycle/hyper-v-stop-delete.js";
export function createHyperVStopDeleteApplication<Connection,Receipt>(ports: HyperVStopDeletePorts<Connection,Receipt>) {
    async function reconcile(ownerId: string, backend: string, deviceId: string, deadlineAt = Number.POSITIVE_INFINITY, preserveNetwork = false): Promise<HyperVReplayResult> {
        let journal: HyperVOperationEvidence | null;
        try {
            journal = ports.readJournal(ownerId, backend, deviceId);
        }
        catch (error) {
            return {
                ok: false, reason:'conflict',journalDisposition:'retain',
                error: "hyper-v-operation-journal-invalid",
                detail: ports.errorCode(error, "hyper-v-operation-journal-invalid"),
            };
        }
        if (!journal)
            return { ok: true, reconciled: false };
        const currentDevice = hyperVSelectedDevice(ports.read(ownerId, backend), deviceId);
        if (currentDevice && ports.incarnation(currentDevice) !== journal.incarnationId) {
            return { ok: false, reason:'conflict',journalDisposition:'retain', error: "hyper-v-operation-incarnation-conflict" };
        }
        if (currentDevice && ((hyperVField(currentDevice, "vmId") || "").toLowerCase() !== journal.vmId.toLowerCase()
            || hyperVField(currentDevice, "vmName") !== journal.vmName
            || !ports.samePath(hyperVField(currentDevice, "diskPath") || "", journal.diskPath))) {
            return { ok: false, reason:'conflict',journalDisposition:'retain', error: "hyper-v-operation-identity-conflict" };
        }
        const expectedDevice = ports.clone(currentDevice);
        const powershell = ports.connection('powershell');
        if (!powershell)
            return { ok: false, reason:'provider-unavailable',journalDisposition:'retain', error: "missing-provider-command", detail: "powershell" };
        const deviceRoot = ports.deviceRoot(ownerId, backend, deviceId);
        const auxiliaryMediaPaths = [join(deviceRoot, "disks", backend === "linux-vm" ? "cidata.iso" : "autounattend.iso")];
        if (journal.command === "device_delete") {
            try {
                let outcome = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
                ports.assertDeadline(deadlineAt);
                if (outcome.kind === "pending" && outcome.action === "remove") {
                    if (outcome.virtualMachine.state.toLowerCase() !== "off") {
                        await ports.replayPower(powershell, ownerId, journal, "stop", true, deadlineAt);
                        ports.assertDeadline(deadlineAt);
                        outcome = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
                    }
                    if (outcome.kind !== "pending" || outcome.action !== "remove") {
                        return { ok: false, reason:'provider-failed',journalDisposition:'retain', error: "hyper-v-delete-reconciliation-invalid-result" };
                    }
                    try {
                        await ports.replayRemoveVm(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
                    }
                    catch (error) {
                        const confirmation = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
                        if (confirmation.kind !== "absent" || !confirmation.satisfiesIntent) {
                            return {
                                ok: false, reason:'provider-failed',journalDisposition:'retain',
                                error: "hyper-v-delete-reconciliation-failed",
                                detail: ports.errorCode(error, "hyper-v-delete-reconciliation-failed"),
                            };
                        }
                    }
                    ports.assertDeadline(deadlineAt);
                    outcome = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
                }
                if (outcome.kind !== "absent" || !outcome.satisfiesIntent) {
                    return { ok: false, reason:'provider-failed',journalDisposition:'retain', error: "hyper-v-delete-reconciliation-invalid-result" };
                }
                await ports.removeHostFiles(powershell, deviceRoot, [journal.diskPath], undefined, deadlineAt);
                await ports.removeHostFiles(powershell, deviceRoot, auxiliaryMediaPaths, ports.windowsDirectory(journal.diskPath), deadlineAt);
            }
            catch (error) {
                return {
                    ok: false, reason:'provider-failed',journalDisposition:'retain',
                    error: "hyper-v-delete-reconciliation-failed",
                    detail: ports.errorCode(error, "hyper-v-delete-reconciliation-failed"),
                };
            }
            const allocation = await ports.releaseNetwork(ownerId, deviceId, journal.incarnationId, deadlineAt, preserveNetwork);
            const artifacts = allocation.ok
                ? ports.cleanupArtifacts(ownerId, backend, deviceId)
                : { ok: false, removed: false, error: "network-allocation-cleanup-failed" };
            if (!artifacts.ok || !allocation.ok) {
                return {
                    ok: false, reason:'provider-failed',journalDisposition:'retain',
                    error: "hyper-v-delete-reconciliation-cleanup-failed",
                    detail: [artifacts.ok ? null : `artifacts:${artifacts.error}`, allocation.ok ? null : `allocation:${allocation.error}`].filter(Boolean).join("; "),
                };
            }
            const publication = ports.publish(ownerId, backend, deviceId, expectedDevice, () => {
                ports.assertDeadline(deadlineAt);
                return null;
            });
            if (publication.found && !publication.matched) return { ok: false, reason:'conflict',journalDisposition:'retain', error: "owner-device-state-conflict" };
            ports.clearJournal(ownerId, backend, deviceId);
            return {
                ok: true,
                reconciled: true,
                networkCleanup: allocation,
            };
        }
        let outcome;
        try {
            outcome = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
            ports.assertDeadline(deadlineAt);
            if (outcome.kind === "pending" && outcome.reason === "terminal-state-mismatch") {
                if (outcome.action === "start") {
                    await ports.replayPower(powershell, ownerId, journal, "start", false, deadlineAt);
                }
                else if (outcome.action === "stop") {
                    await ports.replayPower(powershell, ownerId, journal, "stop", false, deadlineAt);
                }
                ports.assertDeadline(deadlineAt);
                outcome = await ports.replayObservation(powershell, ownerId, journal, auxiliaryMediaPaths, deadlineAt);
            }
        }
        catch (error) {
            return {
                ok: false, reason:'provider-failed',journalDisposition:'retain',
                error: "hyper-v-state-reconciliation-failed",
                detail: ports.errorCode(error, "hyper-v-state-reconciliation-failed"),
            };
        }
        ports.assertDeadline(deadlineAt);
        if (outcome.kind === "pending" && outcome.reason === "transitioning-or-unknown") {
            return {
                ok: false, reason:'conflict',journalDisposition:'retain', error: "hyper-v-operation-still-transitioning", detail: outcome.virtualMachine.state
            };
        }
        if (outcome.kind !== "settled") {
            return { ok: false, reason:'provider-failed',journalDisposition:'retain', error: "hyper-v-state-reconciliation-invalid-result" };
        }
        const observation = outcome.virtualMachine;
        const state = observation.state.toLowerCase();
        const publication = ports.publish(ownerId, backend, deviceId, expectedDevice, current => {
            ports.assertDeadline(deadlineAt);
            return {
                ...current, status: state === "running" ? "running" : "stopped", runtimeState: observation.state, hyperVStatus: observation.status, updatedAt: ports.timestamp()
            };
        });
        if (publication.found && !publication.matched) return { ok: false, reason:'conflict',journalDisposition:'retain', error: "owner-device-state-conflict" };
        ports.clearJournal(ownerId, backend, deviceId);
        return { ok: true, reconciled: true };
    }
    async function invoke(ownerId: string, parsed: HyperVStopDeleteRequest, deadlineAt = Number.POSITIVE_INFINITY, cleanupDeadlineAt = deadlineAt): Promise<HyperVStopDeleteOutcome<Connection,Receipt>> {
        if (parsed.dryRun)
            return execute(ownerId, parsed, deadlineAt, cleanupDeadlineAt);
        ports.assertDeadline(deadlineAt);
        const { backend, stateKey, deviceId } = parsed;
        const replay = await reconcile(ownerId, backend, deviceId, deadlineAt, parsed.command === "device_delete" ? parsed.preserveNetwork === true : true);
        if (!replay.ok)
            return {
                kind:'refused',reason:replay.reason,journalDisposition:'retain',error: replay.error, ownerId, backend, deviceId, ...(replay.detail ? { detail: replay.detail } : {})};
        if (replay.reconciled && parsed.command === "device_delete" && !hyperVSelectedDevice(ports.read(ownerId, stateKey), deviceId)) {
            return {
                kind:'replayed',journalDisposition:'clear',ownerId, backend, deviceId, command: parsed.command, reconciled: true, device: null,
                        ...(replay.networkCleanup ? { networkCleanup: replay.networkCleanup } : {}), invoked: true, dryRun: false};
        }
        if (!parsed.dryRun) {
            let snapshotJournal: unknown;
            try {
                snapshotJournal = ports.readSnapshotJournal(ownerId, backend, deviceId);
            }
            catch (error) {
                return {
                    kind:'refused',reason:'conflict',journalDisposition:'clear',error: "hyper-v-snapshot-journal-invalid", ownerId, backend, deviceId, detail: ports.errorCode(error, "hyper-v-snapshot-journal-invalid")};
            }
            if (snapshotJournal) {
                const current = hyperVSelectedDevice(ports.read(ownerId, stateKey), deviceId);
                if (!current)
                    return {
                        kind:'refused',reason:'conflict',journalDisposition:'clear',error: "hyper-v-snapshot-reconciliation-metadata-invalid", ownerId, backend, deviceId};
                const connection = ports.connection('powershell');
                if (!connection)
                    return {
                        kind:'refused',reason:'invalid',journalDisposition:'clear',error: "missing-provider-command", missing: ["powershell"], backend, deviceId};
                const snapshot = await ports.repairSnapshots(ownerId, backend, deviceId, current, connection);
                if (!snapshot.ok) {
                    if (parsed.command === "device_delete" && parsed.force)
                        ports.clearSnapshotJournal(ownerId, backend, deviceId);
                    else
                        return {
                            kind:'refused',reason:snapshot.reason,journalDisposition:'retain',error: snapshot.error, ownerId, backend, deviceId, ...(snapshot.detail ? { detail: snapshot.detail } : {})};
                }
            }
        }
        const result = await execute(ownerId, parsed, deadlineAt, cleanupDeadlineAt);
        return result;
    }
    async function execute(ownerId:string,parsed:HyperVStopDeleteRequest,deadlineAt:number,cleanupDeadlineAt:number,staged=false):Promise<HyperVStopDeleteOutcome<Connection,Receipt>> {
        const {backend,stateKey,deviceId}=parsed;
        let device:Record<string,unknown>|undefined;
        try { device=hyperVSelectedDevice(ports.read(ownerId,stateKey),deviceId); }
        catch(error) { return {kind:'refused',journalDisposition:'retain',...ports.stateFailure(error,parsed)}; }
        let expected=ports.clone(device);
        const base={ownerId,backend,stateKey,command:parsed.command,deviceId};
        if(!device) {
            if(parsed.command!=='device_delete') return {kind:'refused',reason:'missing',journalDisposition:'clear',error:'owner-device-not-found',ownerId,backend,deviceId};
            return {kind:'already-missing',journalDisposition:'clear',...base,device:null,idempotent:true,alreadyMissing:true,invoked:false,dryRun:parsed.dryRun};
        }
        const incarnation=ports.incarnation(device);
        if(!ports.validIncarnation(incarnation)) return {kind:'refused',reason:'conflict',journalDisposition:'clear',error:'missing-provider-metadata',missing:['incarnationId'],ownerId,backend,deviceId};
        const preparation=ports.prepareStopDelete(ownerId,parsed,device);
        if(parsed.dryRun) return {kind:'preview',journalDisposition:'clear',...base,device,preparation,force:parsed.force,invoked:false,dryRun:true};
        if(staged) return perform(ownerId,parsed,preparation,device,expected,deadlineAt,cleanupDeadlineAt);
        const journal=ports.writeJournal(ownerId,parsed);
        if(!journal.ok) return {kind:'refused',reason:'conflict',journalDisposition:'clear',error:'hyper-v-operation-journal-write-failed',ownerId,backend,deviceId,detail:journal.error};
        const outcome=await execute(ownerId,parsed,deadlineAt,cleanupDeadlineAt,true);
        if(outcome.journalDisposition==='clear') ports.clearJournal(ownerId,backend,deviceId);
        return outcome;
    }
    async function perform(ownerId:string,parsed:HyperVStopDeleteRequest,preparation:HyperVStopDeletePreparation<Connection>,device:Record<string,unknown>,expected:unknown,deadlineAt:number,cleanupDeadlineAt:number):Promise<HyperVStopDeleteOutcome<Connection,Receipt>> {
        const {backend,stateKey,deviceId}=parsed;
        const base={ownerId,backend,stateKey,command:parsed.command,deviceId,force:parsed.force,preparation};
        if(preparation.kind==='unavailable') return {kind:'refused',reason:'invalid',journalDisposition:'clear',...base,error:preparation.error,missing:preparation.missing,device};
        const auxiliary=ports.cleanupAuxiliary(ownerId,parsed,expected);
        if(auxiliary.committed) expected=ports.clone(auxiliary.device);
        if(!auxiliary.result.ok) return {kind:'uncertain',reason:'provider-failed',journalDisposition:'retain',...base,error:'auxiliary-runtime-cleanup-failed',device:auxiliary.device,auxiliaryCleanup:auxiliary.result,invoked:false,dryRun:false,
            mutatesHost:auxiliary.result.changed || auxiliary.result.appium.cleared===true || auxiliary.result.recording.cleared===true || auxiliary.result.minimizeWatchdog.cleared===true};
        const deleting=parsed.command==='device_delete';
        const result=deleting ? await ports.executeDelete(ownerId,parsed,device,preparation.connection,deadlineAt) : await ports.executeStop(ownerId,parsed,device,preparation.connection,deadlineAt);
        const execution=result.execution;
        if(ports.deadlineExpired(deadlineAt)) return {kind:'uncertain',reason:'deadline',journalDisposition:'retain',error:'hyper-v-operation-deadline-exceeded',ownerId,backend,deviceId};
        const observation=result.ok ? result.observation : null;
        const expectedVmId=(hyperVField(device,'vmId')||'').toLowerCase();
        const success=Boolean(observation&&expectedVmId&&observation.vmId===expectedVmId&&observation.vmName===hyperVField(device,'vmName')&&(deleting ? ports.samePath(observation.diskPath||'',hyperVField(device,'diskPath')||'') : observation.state==='Off'));
        const network=success&&deleting ? await ports.releaseNetwork(ownerId,deviceId,ports.incarnation(device),cleanupDeadlineAt,parsed.preserveNetwork===true) : null;
        const artifacts=success&&deleting&&network?.ok===true ? ports.cleanupArtifacts(ownerId,backend,deviceId) : null;
        if(artifacts?.ok===false||network?.ok===false) return {kind:'uncertain',reason:'provider-failed',journalDisposition:'retain',...base,error:'hyper-v-device-cleanup-failed',device,artifactCleanup:artifacts,networkCleanup:network,invoked:true,dryRun:false,execution,mutatesHost:true};
        const publication:HyperVPublication|undefined=success ? ports.publish(ownerId,stateKey,deviceId,expected,current=>{ports.assertDeadline(deadlineAt);return deleting ? null : hyperVStopReplacement(current,observation,ports.timestamp());}) : undefined;
        const observed={...base,device:publication ? publication.device : device,auxiliaryCleanup:auxiliary.result,artifactCleanup:artifacts,networkCleanup:network,invoked:true as const,dryRun:false as const,execution,mutatesHost:success};
        if(publication&&!publication.matched) return {kind:'refused',reason:'conflict',journalDisposition:'clear',...observed,error:'owner-device-state-conflict',found:publication.found};
        if(!success) return {kind:'uncertain',reason:'provider-failed',journalDisposition:'retain',...observed,error:'provider-command-failed',detail:ports.diagnosticCode(execution,'hyper-v-provider-command-failed')||'hyper-v-provider-command-failed'};
        return {kind:deleting ? 'deleted' : 'stopped',journalDisposition:'clear',...observed};
    }
    return {invoke,reconcile};
}
