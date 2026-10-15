import type { ClaimOutcome, HeartbeatOutcome, ReleaseOutcome, PruneOutcome, LeaseFailure, LeaseParamError } from '../domain/broker-physical-leases.js';
import type { CleanupLeaseResult, CleanupRollback } from '../domain/broker-owner-cleanup.js';

export interface PhysicalWireResult { status: number; payload: unknown }
export function renderLeaseFailure(failure: LeaseFailure | LeaseParamError): PhysicalWireResult {
    const { kind, ...facts } = failure;
    const status = kind === 'invalid' ? 400 : kind === 'forbidden' ? 403
        : kind === 'scan-limit' ? 507 : kind === 'conflict' || kind === 'directory-refused' ? 409 : 404;
    return { status, payload: { ...facts, ok: false } };
}
export function renderLeaseOutcome(outcome: ClaimOutcome | HeartbeatOutcome | ReleaseOutcome | PruneOutcome): PhysicalWireResult {
    switch (outcome.kind) {
        case 'claimed': return { status: 200, payload: { ok: true, result: {
            lease: outcome.lease, created: outcome.created,
            ...(outcome.reused === undefined ? {} : { reused: outcome.reused }),
            ...(outcome.heartbeat === undefined ? {} : { heartbeat: outcome.heartbeat }),
        } } };
        case 'renewed': return { status: 200, payload: { ok: true, result: { lease: outcome.lease, heartbeat: true } } };
        case 'released': return { status: 200, payload: { ok: true, result: { released: true, lease: outcome.lease } } };
        case 'pruned': return { status: 200, payload: { ok: true, result: { ownerId: outcome.ownerId, backend: outcome.backend, pruned: outcome.leases } } };
        default: return renderLeaseFailure(outcome);
    }
}
export function renderCleanupLease(outcome: CleanupLeaseResult) {
    if (outcome.kind === 'no-identity') return { attempted: false, ok: true };
    const wire = outcome.kind === 'released' ? renderLeaseOutcome({kind:'released',lease:outcome.lease}) : renderLeaseFailure(outcome.failure);
    return { attempted: outcome.attempted, ok: outcome.ok, status: wire.status, payload: wire.payload };
}
export function renderCleanupRollback(outcome: CleanupRollback) {
    switch (outcome.kind) {
        case 'not-needed': return { attempted: false, ok: true };
        case 'restored': return { attempted: true, ok: true, lease: outcome.lease, heartbeat: outcome.heartbeat };
        case 'occupied': return { attempted: true, ok: false, error: outcome.error, lease: outcome.lease };
        case 'write-failed': return { attempted: true, ok: false, error: outcome.error, detail: outcome.detail };
    }
}

import type { ProviderCommand, ProviderCommandResult } from '../../device-lab-broker.js';
import type { AttachOutcome, DetachOutcome, TrustOutcome, PhysicalStopOutcome, PhysicalContext, PhysicalExecution, AppleHostDevice, AppleInventoryObservation, AppleTrustFacts } from '../domain/broker-physical-devices.js';
import type { OwnerCleanupOutcome, CleanupDeviceReport } from '../domain/broker-owner-cleanup.js';
export interface NativePhysicalReceipt { command: ProviderCommand; execution: ProviderCommandResult }
export interface NativePhysicalObservation<Receipt> {status?:number|null;stdout?:string;stderr?:string;error?:string;timedOut?:boolean;receipt:Receipt}
export function normalizePhysicalExecution<Receipt>(observation: NativePhysicalObservation<Receipt>): PhysicalExecution<Receipt> {
    return {ok:observation.status === 0 && !observation.error,receipt:observation.receipt};
}
export function normalizeAppleInventory<Receipt>(observation: NativePhysicalObservation<Receipt>, devices: (text:string)=>AppleHostDevice[]): AppleInventoryObservation<Receipt> {
    if (observation.status !== 0 || observation.error) return {kind:'failed',reason:observation.error === 'executable-not-found' ? 'missing-executable' : 'command-failed',receipt:observation.receipt};
    return {kind:'observed',devices:devices(observation.stdout || ''),receipt:observation.receipt};
}
export function renderAppleTrustDiagnostic(facts: AppleTrustFacts) {
    return {
        ...(facts.ownerId === undefined ? {} : {ownerId:facts.ownerId}),
        backend: 'ios-device', action:facts.action, udid:facts.udid, provider:'xcrun-xctrace',
        selected:facts.selected, visible:facts.visible, networkVisible:facts.networkVisible,
        readyToAttach:facts.readyToAttach, manualRequired:facts.manualRequired, trustState:facts.trustState,
        supportedActions:['status'], unsupportedActions:['pair','connect'],
        attachFlow: facts.networkVisible
            ? 'Call device_attach with backend=ios-device, connection=wifi, and this UDID.'
            : facts.readyToAttach
                ? 'Call device_attach with backend=ios-device and this UDID for USB attach, or complete Xcode network pairing first for Wi-Fi attach.'
                : 'Complete Apple trust, Developer Mode, and Xcode pairing on the macOS host, then re-run this status check.',
        manualSteps:[
            'Connect the iPhone or iPad to the macOS host over USB, unlock it, and accept the Trust This Computer prompt.',
            'Enable Developer Mode on the device when iOS requires it.',
            'Open Xcode Devices and Simulators on the macOS host and enable network pairing if Wi-Fi attach is needed.',
            'Re-run device_wireless with backend=ios-device and action=status, then call device_attach when xctrace reports the UDID as USB or Network.',
        ],
        safety:{bypassesTrustPrompt:false,powersOffDevice:false,erasesDevice:false,disconnectsDevice:false},
        ...(facts.inventory === undefined ? {} : {inventory:facts.inventory}),
        ...(facts.alreadyNetworkVisible === undefined ? {} : {alreadyNetworkVisible:facts.alreadyNetworkVisible}),
    };
}
function physicalFailureDetail(execution: ProviderCommandResult) {
    const parts = [execution.error ? `error: ${execution.error}` : '', execution.stderr ? `stderr: ${execution.stderr}` : '', execution.stdout ? `stdout: ${execution.stdout}` : ''].filter(Boolean);
    return (parts.join('\n') || `provider exited with status ${String(execution.status)}`).slice(0, 8192);
}
function inventoryCommand(observation: {receipt:NativePhysicalReceipt}) {
    const execution = observation.receipt.execution;
    return { provider: execution.provider, executable: execution.executable, args: execution.args, status: execution.status, stderr: execution.stderr };
}
function refusalStatus(category: 'invalid'|'missing'|'conflict'|'provider-failed'|'state-write-failed') {
    return category === 'invalid' ? 400 : category === 'missing' ? 404 : category === 'conflict' ? 409 : category === 'state-write-failed' ? 500 : 502;
}
function physicalRefusalFacts(facts: PhysicalContext<NativePhysicalReceipt>) {
    return {
        error: facts.error,
        ...(facts.allowed ? {allowed:facts.allowed} : {}),
        ...(facts.ownerId === undefined ? {} : {ownerId:facts.ownerId}),
        ...(facts.backend === undefined ? {} : {backend:facts.backend}),
        ...(facts.deviceId === undefined ? {} : {deviceId:facts.deviceId}),
        ...(facts.hardwareId === undefined ? {} : {hardwareId:facts.hardwareId}),
        ...(facts.connection === undefined ? {} : {connection:facts.connection}),
        ...(facts.state === undefined ? {} : {state:facts.state}),
        ...(facts.detail === undefined ? {} : {detail:facts.detail}),
        ...(facts.selectionReason === undefined ? {} : {message:facts.selectionReason === 'no-attachable-usb' ? 'No attachable USB Android device is visible to host adb.' : 'Multiple attachable USB Android devices are visible; pass serial.'}),
        ...(facts.existing === undefined ? {} : {existing:facts.existing}),
        ...(facts.inventory === undefined ? {} : {inventory:facts.inventory}),
        ...(facts.hostDevices === undefined ? {} : {hostDevices:facts.hostDevices}),
        ...(facts.candidates === undefined ? {} : {candidates:facts.candidates}),
        ...(facts.command ? {command:facts.command.receipt.execution} : {}),
        ...(facts.diagnostic ? {diagnostic:{...renderAppleTrustDiagnostic(facts.diagnostic),inventoryCommand:facts.inventoryObservation ? inventoryCommand(facts.inventoryObservation) : facts.command ? inventoryCommand(facts.command) : null}} : {}),
    };
}
export function renderPhysicalAttachOutcome(outcome: AttachOutcome<NativePhysicalReceipt>): PhysicalWireResult {
    if (outcome.kind === 'lease-refused') return renderLeaseFailure(outcome.failure);
    if (outcome.kind === 'attached') return {status:200,payload:{ok:true,result:{device:outcome.device,lease:outcome.lease,heartbeat:outcome.heartbeat,provider:outcome.provider,
        inventory:outcome.provider === 'xcrun' ? outcome.inventory.receipt.execution : outcome.inventory}}};
    return {status:refusalStatus(outcome.category),payload:{ok:false,...physicalRefusalFacts(outcome)}};
}
export function renderAppleTrustOutcome(outcome: TrustOutcome<NativePhysicalReceipt>): PhysicalWireResult {
    if (outcome.kind === 'trust-observed') return {status:200,payload:{ok:true,result:{...renderAppleTrustDiagnostic(outcome.diagnostic),inventoryCommand:inventoryCommand(outcome.inventoryObservation)}}};
    return {status:refusalStatus(outcome.category),payload:{ok:false,error:outcome.error,...(outcome.allowed ? {allowed:outcome.allowed} : {}),
        ...(outcome.diagnostic ? {result:{...renderAppleTrustDiagnostic(outcome.diagnostic),inventoryCommand:outcome.inventoryObservation ? inventoryCommand(outcome.inventoryObservation) : null}} : {})}};
}
export function renderPhysicalDetachOutcome(outcome: DetachOutcome<NativePhysicalReceipt>, redact: (value:unknown)=>unknown): PhysicalWireResult {
    if (outcome.kind === 'scope-refused') return renderLeaseFailure(outcome.failure);
    if (outcome.kind === 'detached') return {status:200,payload:{ok:true,result:{detached:outcome.deviceId,device:redact(outcome.device),release:outcome.release ? renderCleanupLease(outcome.release).payload : null,auxiliaryCleanup:outcome.auxiliaryCleanup,physicalDevicePoweredOff:false,disconnected:false}}};
    const release = outcome.release ? renderCleanupLease(outcome.release) : null;
    if (outcome.error === 'physical-lease-release-failed') return {status:release?.status === 409 ? 409 : 502,payload:{ok:false,error:outcome.error,ownerId:outcome.ownerId,backend:outcome.backend,deviceId:outcome.deviceId,release:release?.payload}};
    if (outcome.auxiliaryCleanup) return {status:refusalStatus(outcome.category),payload:{ok:false,error:outcome.error,ownerId:outcome.ownerId,backend:outcome.backend,deviceId:outcome.deviceId,
        ...(outcome.detail === undefined ? {} : {detail:outcome.detail}),result:{device:redact(outcome.device),detached:false,auxiliaryCleanup:outcome.auxiliaryCleanup,
            ...(outcome.leaseRollback ? {release:release?.payload || null,leaseRollback:renderCleanupRollback(outcome.leaseRollback)} : {})}}};
    return {status:refusalStatus(outcome.category),payload:{ok:false,...physicalRefusalFacts(outcome)}};
}
function stopExecution(execution: PhysicalExecution<NativePhysicalReceipt>, mutatesHost:boolean) {
    return {mode:execution.receipt.execution.mode,providerExecution:'executed',mutatesHost,command:execution.receipt.execution};
}
export function renderPhysicalStopOutcome(outcome: PhysicalStopOutcome<NativePhysicalReceipt>, plan: Record<string,unknown>, redact: (value:unknown)=>unknown): PhysicalWireResult {
    if (outcome.kind === 'stop-preview') return {status:200,payload:{ok:true,result:{...plan,invoked:false,dryRun:true,execution:{mode:'dry-run',providerExecution:'available',mutatesHost:false}}}};
    if (outcome.kind === 'stop-observed') return {status:!outcome.publicationMatched ? 409 : outcome.success ? 200 : 502,payload:{
        ok:outcome.success && outcome.publicationMatched,
        ...(!outcome.publicationMatched ? {error:'owner-device-state-conflict',ownerId:plan.ownerId,backend:plan.backend,deviceId:plan.deviceId,found:outcome.found,...(!outcome.success ? {providerFailure:'provider-command-failed'} : {})} : {}),
        ...(outcome.success || !outcome.publicationMatched ? {} : {error:'provider-command-failed',detail:physicalFailureDetail(outcome.execution.receipt.execution)}),
        result:{...plan,providerCommand:outcome.execution.receipt.command,device:redact(outcome.device),auxiliaryCleanup:outcome.auxiliaryCleanup,
            ...(outcome.release ? {physicalLeaseCleanup:renderCleanupLease(outcome.release)} : {}),invoked:true,dryRun:false,execution:stopExecution(outcome.execution,outcome.mutatesHost)}}};
    if (outcome.category === 'missing') return {status:404,payload:{ok:false,...physicalRefusalFacts(outcome)}};
    const result = {...plan,
        ...(outcome.device === undefined ? {} : {device:redact(outcome.device)}),
        ...(outcome.auxiliaryCleanup ? {auxiliaryCleanup:outcome.auxiliaryCleanup} : {}),
        ...(outcome.physicalLeaseCleanup ? {physicalLeaseCleanup:renderCleanupLease(outcome.physicalLeaseCleanup)} : {}),
        ...(outcome.leaseRollback ? {leaseRollback:renderCleanupRollback(outcome.leaseRollback)} : {}),
        invoked:outcome.invoked,dryRun:outcome.dryRun,
        ...(outcome.execution ? {execution:stopExecution(outcome.execution,outcome.mutatesHost === true)} : outcome.auxiliaryCleanup ? {execution:{mode:'preflight',providerExecution:'blocked',mutatesHost:outcome.mutatesHost === true}} : {})};
    return {status:outcome.physicalLeaseCleanup?.kind === 'refused' && renderLeaseFailure(outcome.physicalLeaseCleanup.failure).status === 409 ? 409 : refusalStatus(outcome.category),payload:{ok:false,error:outcome.error,
        ...(outcome.ownerId === undefined ? {} : {ownerId:outcome.ownerId,backend:outcome.backend,deviceId:outcome.deviceId}),
        ...(outcome.detail === undefined ? {} : {detail:outcome.detail}),result}};
}
function renderCleanupDevice(device: CleanupDeviceReport<NativePhysicalReceipt>) {
    return {
        ...device,
        ...(device.stop?.attempted ? {
            stop: {
                attempted: true,
                ok: device.stop.ok,
                execution: device.stop.observation.receipt.execution,
            },
        } : {}),
        ...(device.physical ? {
            physical: { ...device.physical, lease: renderCleanupLease(device.physical.lease) },
        } : {}),
        ...(device.stateWrite ? {
            stateWrite: { ...device.stateWrite, leaseRollback: renderCleanupRollback(device.stateWrite.leaseRollback) },
        } : {}),
    };
}
export function renderOwnerCleanupOutcome(outcome: OwnerCleanupOutcome<NativePhysicalReceipt>): PhysicalWireResult {
    if (outcome.kind === 'invalid-backend') return { status: 400, payload: { ok: false, error: outcome.error, allowed: outcome.allowed } };
    const { kind, ...report } = outcome;
    void kind;
    const results = report.results.map(backend => ({
        ...backend,
        ...(backend.devices ? { devices: backend.devices.map(renderCleanupDevice) } : {}),
    }));
    return { status: 200, payload: { ok: report.failed === 0, result: { ...report, results } } };
}
