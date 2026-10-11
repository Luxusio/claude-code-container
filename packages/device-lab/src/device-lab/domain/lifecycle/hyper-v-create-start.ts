import {join} from 'path';
export interface WindowsReadinessIdentity { selector:{kind:'id';id:string}; expectedName:string; expectedNotes:string; credentialPath:string }
export interface WindowsReadinessRequest { identity:WindowsReadinessIdentity; provisioningMediaPath:string; expectedNetworkAddress:string; timeoutMilliseconds:number; noProgressTimeoutMilliseconds?:number }
export interface WindowsReadinessError { code:string; category:string }
export type GuestProbe = {
    readonly computerName: string;
    readonly addresses: readonly string[];
    readonly firstLogonCompleted: string;
    readonly provisioningSecretsPresent: boolean;
};

export type WindowsReadinessOutcome =
    | { readonly ok: true; readonly vmId: string; readonly vmName: string; readonly computerName: string; readonly attempts: number; readonly networkAddress: string }
    | { readonly ok: false; readonly error: "hyper-v-guest-ready-timeout" | "hyper-v-guest-ready-failed"; readonly reason: string; readonly attempts: number; readonly scrubConfirmed: boolean; readonly mediaDetached: boolean };


function ipv4(address:string):boolean { const parts=address.split('.'); return parts.length===4 && parts.every(part=>/^(0|[1-9][0-9]{0,2})$/.test(part)&&Number(part)<=255); }
export function parseWindowsReadinessProbe(value:string):GuestProbe|null {
 let item:unknown; try {item=JSON.parse(value);} catch{return null;}
 if(!item || typeof item!=='object' || Array.isArray(item) || Object.keys(item).sort().join('|')!==['addresses','computerName','firstLogonCompleted','provisioningSecretsPresent'].join('|'))return null;
 if(!('computerName' in item)||typeof item.computerName!=='string'||item.computerName.length<1||item.computerName.length>255
 ||!('firstLogonCompleted' in item)||typeof item.firstLogonCompleted!=='string'||item.firstLogonCompleted.length>4096
 ||!('provisioningSecretsPresent' in item)||typeof item.provisioningSecretsPresent!=='boolean'
 ||!('addresses' in item)||!Array.isArray(item.addresses)||item.addresses.length>64)return null;
 const addresses:string[]=[];
 for(const address of item.addresses){if(typeof address!=='string'||!ipv4(address))return null;addresses.push(address);}
 return {computerName:item.computerName, firstLogonCompleted:item.firstLogonCompleted,provisioningSecretsPresent:item.provisioningSecretsPresent,addresses};
}
export function windowsProbeFingerprint(probe: GuestProbe): string {
    return JSON.stringify([
        probe.firstLogonCompleted,
        probe.provisioningSecretsPresent,
        [...new Set(probe.addresses)].sort(),
    ]);
}

export function windowsReadinessReason(error:WindowsReadinessError|null): string {
    if (error) {
        const directCodes: Record<string, string> = {
            "powershell-direct-attempt-timeout": "powershell-direct-attempt-timeout",
            "powershell-direct-authentication-failed": "powershell-direct-authentication-failed",
            "powershell-direct-session-unavailable": "powershell-direct-session-unavailable",
            "powershell-direct-unavailable": "powershell-direct-unavailable",
            "guest-vm-identity-mismatch": "hyper-v-vm-ownership-mismatch",
            "dvd-vm-identity-mismatch": "hyper-v-vm-ownership-mismatch",
            "guest-requires-running-vm": "hyper-v-guest-vm-not-running",
            "guest-credential-unavailable": "hyper-v-guest-credential-unavailable",
            "guest-credential-invalid": "hyper-v-guest-credential-invalid",
            "dvd-attachment-ambiguous": "hyper-v-guest-provisioning-media-attachment-ambiguous",
            "dvd-still-attached": "hyper-v-guest-provisioning-media-detach-failed",
        };
        if (directCodes[error.code]) return directCodes[error.code];
        if (/AccessDenied|InvalidCredential|Authentication/i.test(error.code)) return "powershell-direct-authentication-failed";
        if (/PSSession|VMNotRunning|InvalidState/i.test(error.code)) return "powershell-direct-session-unavailable";
        if (error.category === "transport" && error.code === "timeout") return "powershell-direct-timeout";
    }
    return "powershell-direct-unavailable";
}


import type {HyperVCreateVirtualMachineRequest,HyperVCreateEffect,HyperVCreateStep} from '@ccc/hyper-v/lifecycle/index.js';
import type {HyperVVirtualMachineSelector,HyperVVMNetworkAdapterTarget,HyperVSecureBootSetting,HyperVBiosStartupDevice,HyperVVirtualMachine,HyperVWindowsOperation} from '@ccc/hyper-v/low-level/index.js';
export type VmSelector=HyperVVirtualMachineSelector;
export type VmAdapterTarget=HyperVVMNetworkAdapterTarget;
export type VmSecureBoot=HyperVSecureBootSetting;
export type VmBiosDevice=HyperVBiosStartupDevice;
export type VmCreationRequest=HyperVCreateVirtualMachineRequest;
export type VmCreationEffect=HyperVCreateEffect;
export type VmCreationStep=HyperVCreateStep;
export interface VmCreationObservation {vmId:string;vmName:string;state:string;generation:1|2;diskPath:string;switchName:string|null}
export type VmObservation=HyperVVirtualMachine;
export interface VmDiskObservation {vmId:string;path:string|null}
export interface VmAdapterObservation {vmId:string;name:string;macAddress:string;switchId:string|null;switchName:string|null}

export type HyperVCreateParameters={name?:unknown;profile?:unknown;sourceImage?:unknown;image?:unknown;baseImageSha256?:unknown;baseImageGeneration?:unknown;memoryMb?:unknown;cpus?:unknown;diskMaxBytes?:unknown;incarnationId?:unknown;networking?:unknown;switchName?:unknown;macAddress?:unknown;networkAddress?:unknown;networkGateway?:unknown;networkPrefix?:unknown;outboundPolicy?:unknown;nestedVirtualization?:unknown;vmId?:unknown;guestUsername?:unknown;guestProvisioned?:unknown;sshHostKeyFingerprint?:unknown;guestUnattendPath?:unknown};
export type HyperVLifecycleRequest={ok:true;backend:string;stateKey:string;command:string;deviceId:string;expectedIncarnationId?:string;force:boolean;startIfStopped?:boolean;dryRun:boolean;headless?:boolean;minimized?:boolean;waitForBoot?:boolean;bootTimeoutMs?:number;deleteAvd?:boolean;deleteSimulator?:boolean;preserveNetwork?:boolean;create?:HyperVCreateParameters};
export type HyperVNativeCommand={mode:'exec'|'detached'|'noop';provider:string;executable?:string;args?:string[];input?:string;reason?:string};
export type HyperVNativeExecution={mode:string;provider:string;executable?:string;args?:string[];input?:string;status?:number|null;signal?:string|null;stdout?:string;stderr?:string;error?:string;timedOut?:boolean;outputLimitExceeded?:boolean;typedCreateInvalidResult?:boolean;typedCreateOperation?:HyperVWindowsOperation;typedCreateNativeDiagnostics?:{nativeHResult?:number;nativeErrorCategory?:number}};
export interface HyperVLifecycleResponse {status:number;payload:unknown}
export type HyperVCreateRecovery={ok:true;recoveredVm:boolean;removedDisk:boolean;releasedAddress:boolean}|{ok:false;status:number;error:string;detail?:string;stage?:'network-release'};
export function hyperVCreateRecord(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
export function hyperVCreateField(value:unknown,key:string):string|null{if(!hyperVCreateRecord(value))return null;const field=value[key];return typeof field==='string'&&field?field:null;}
export function hyperVCreateSucceeded(value:{status?:number|null;error?:string}){return value.status===0&&!value.error;}

export type HyperVQuotaUsage={definedVms:number;configuredMemoryMb:number;configuredCpus:number;configuredDiskBytes:number;runningVms:number;runningMemoryMb:number;runningCpus:number};
export type HyperVQuota={maxDefinedVms:number;maxConfiguredMemoryMb:number;maxConfiguredCpus:number;maxConfiguredDiskBytes:number;maxRunningVms:number;maxRunningMemoryMb:number;maxRunningCpus:number};
export function hyperVQuotaResource(device:Record<string,unknown>,key:'memoryMb'|'cpus'|'diskMaxBytes'):number{const value=device[key];if(!Number.isSafeInteger(value)||Number(value)<=0)throw new Error(`hyper-v-owner-quota-${key}-invalid`);return Number(value);}
export function hyperVQuotaProjection(usage:HyperVQuotaUsage,requested:HyperVQuotaUsage):HyperVQuotaUsage{return {definedVms:usage.definedVms+requested.definedVms,configuredMemoryMb:usage.configuredMemoryMb+requested.configuredMemoryMb,configuredCpus:usage.configuredCpus+requested.configuredCpus,configuredDiskBytes:usage.configuredDiskBytes+requested.configuredDiskBytes,runningVms:usage.runningVms+requested.runningVms,runningMemoryMb:usage.runningMemoryMb+requested.runningMemoryMb,runningCpus:usage.runningCpus+requested.runningCpus};}

export type HyperVPlanResult={ownerId?:string;backend?:string;stateKey?:string;command?:string;deviceId?:string;device?:unknown;create?:unknown;idempotent?:boolean;providerCommand?:HyperVNativeCommand|{error:string;missing:string[]}|null};
export type HyperVLifecyclePlan={response:HyperVLifecycleResponse;result:HyperVPlanResult|undefined};

export const HYPER_V_GUEST_SIGNAL_TIMEOUT_MS=5*60*1000;
export type HyperVLinuxGuestReadyTrace = {
    managedSshAttempts: number;
    bootstrapProbeAttempts: number;
    bootstrapProbeSuccesses: number;
    bootstrapProbeLastStatus?: number | null;
    bootstrapProbeLastError?: string | null;
    bootstrapAddressCount: number;
    bootstrapSshAttempts: number;
    bootstrapSshLastStatus?: number | null;
    bootstrapSshLastError?: string | null;
    bootstrapHostKeyObserved?: boolean | null;
    bootstrapHostKeyMatchesExpected?: boolean | null;
    bootstrapHostKeyAdopted?: boolean;
    networkFinalizeAttempts: number;
    networkFinalizeSucceeded: boolean;
    guestSignalObserved: boolean;
    elapsedMs: number;
};

export function hyperVLinuxGuestReadyTraceFailureCode(
    trace: HyperVLinuxGuestReadyTrace | null,
    fallback: string,
): string {
    if (!trace) return fallback;
    if (!fallback.startsWith("ssh-") && fallback !== "hyper-v-guest-boot-signal-timeout") {
        return fallback;
    }
    const bootstrapDiagnosticCodes = new Set([
        "hyper-v-bootstrap-address-selection-failed",
        "hyper-v-bootstrap-host-prefix-inspection-failed",
        "hyper-v-bootstrap-management-adapter-inspection-failed",
        "hyper-v-bootstrap-neighbor-inspection-failed",
        "hyper-v-bootstrap-network-adapter-ambiguous",
        "hyper-v-bootstrap-network-adapter-identity-mismatch",
        "hyper-v-bootstrap-network-command-failed",
        "hyper-v-bootstrap-network-probe-failed",
        "hyper-v-bootstrap-network-response-invalid",
        "hyper-v-bootstrap-vm-adapter-inspection-failed",
    ]);
    // A final probe can fail near the caller's deadline after earlier probes reached the guest.
    // Keep an observed SSH failure instead of replacing it with the last probe's generic error.
    const genericFinalProbeAfterSsh = trace.bootstrapProbeLastError === "hyper-v-bootstrap-network-probe-failed"
        && trace.bootstrapProbeSuccesses > 0
        && trace.bootstrapSshAttempts > 0
        && Boolean(trace.bootstrapSshLastError);
    if (trace.bootstrapProbeLastError
        && bootstrapDiagnosticCodes.has(trace.bootstrapProbeLastError)
        && !genericFinalProbeAfterSsh) {
        return trace.bootstrapProbeLastError;
    }
    if (!trace.guestSignalObserved
        && trace.elapsedMs >= HYPER_V_GUEST_SIGNAL_TIMEOUT_MS) {
        return "hyper-v-guest-boot-signal-timeout";
    }
    if (trace.bootstrapProbeAttempts > 0 && trace.bootstrapProbeSuccesses === 0) {
        return "hyper-v-bootstrap-network-probe-failed";
    }
    if (trace.bootstrapProbeSuccesses > 0 && trace.bootstrapAddressCount === 0) {
        return "hyper-v-bootstrap-address-unavailable";
    }
    if (trace.bootstrapSshAttempts > 0 && trace.networkFinalizeAttempts === 0) {
        const bootstrapSshCodes = new Set([
            "ssh-authentication-failed",
            "ssh-host-key-client-verification-failed",
            "ssh-host-key-mismatch",
            "ssh-host-key-adoption-failed",
            "ssh-host-key-bootstrap-authentication-failed",
            "ssh-connection-refused",
            "ssh-connection-timeout",
            "ssh-host-key-rejected",
            "ssh-host-unreachable",
            "ssh-readiness-marker-missing",
            "ssh-unavailable",
        ]);
        return trace.bootstrapSshLastError && bootstrapSshCodes.has(trace.bootstrapSshLastError)
            ? trace.bootstrapSshLastError
            : "hyper-v-bootstrap-ssh-unavailable";
    }
    if (trace.networkFinalizeAttempts > 0 && !trace.networkFinalizeSucceeded) {
        return "hyper-v-bootstrap-network-finalize-failed";
    }
    return fallback;
}

export function compareHyperVLinuxEd25519HostKeyFingerprint(expectedFingerprint: string, sshDiagnostic: string): {
    observed: boolean;
    matchesExpected: boolean | null;
} {
    const expected = /^SHA256:[A-Za-z0-9+/]{43}$/.test(expectedFingerprint) ? expectedFingerprint : "";
    if (!expected) return { observed: false, matchesExpected: null };
    const observed = new Set<string>();
    const bounded = sshDiagnostic.slice(0, 64 * 1024);
    const patterns = [
        /server host key:\s+ssh-ed25519\s+(SHA256:[A-Za-z0-9+/]{43})=?/gi,
        /fingerprint for the ED25519 key sent by (?:the )?remote host is\s+(SHA256:[A-Za-z0-9+/]{43})=?/gi,
    ];
    for (const pattern of patterns) {
        for (const match of bounded.matchAll(pattern)) observed.add(match[1]);
    }
    if (observed.size === 0) return { observed: false, matchesExpected: null };
    return { observed: true, matchesExpected: observed.size === 1 && observed.has(expected) };
}

export function hyperVLinuxGuestSignalDeadlineAt(startedAt:number){return startedAt+HYPER_V_GUEST_SIGNAL_TIMEOUT_MS;}
export function hyperVLinuxGuestSignalTimedOut(startedAt:number,observedAt:number,guestSignalObserved:boolean){return !guestSignalObserved&&observedAt>=hyperVLinuxGuestSignalDeadlineAt(startedAt);}

export type HyperVGuestReadinessFailureDetail = {
    // windows-vm only: whether the readiness script's structured failure JSON parsed. There is no
    // equivalent on the linux lane, and reporting a constant `false` there would read as "the
    // readiness output failed to parse" in the one field whose job is to disambiguate.
    readonly structured?: boolean;
    readonly status: number | null;
    readonly timedOut: boolean;
    readonly stdoutBytes: number;
    readonly stderrBytes: number;
    readonly diagnosticCode?: string;
    // windows-vm only, and present only when true: the guest failed readiness for an un-scrubbed
    // reason and containment was NOT CONFIRMED. That is broader than "still running" — the stop
    // may never have been attempted (the cleanup deadline can throw before it), or it may have
    // powered the guest off but returned a confirmation that did not parse or did not match the
    // expected vmId/vmName. Every one of those is treated as unconfirmed, which is the fail-closed
    // reading; what it licenses is "go look", not "it is definitely still up". Omitted otherwise so
    // its presence always means something needs attention, rather than a `false` nobody reads.
    readonly scrubContainmentFailed?: true;
};


export type HyperVVmObservation = {
    ok: boolean;
    vmId: string;
    vmName: string;
    state: string;
    status: string;
    uptimeMs?: number;
    diskPath?: string;
    switchName?: string;
    generation?: 1 | 2;
    checkpointPolicy?: "Disabled" | "Production" | "ProductionOnly" | "Standard";
    snapshots?: HyperVSnapshotObservation[];
};

export type HyperVGuestProvisionObservation = {
    ok: boolean;
    vmId: string;
    vmName: string;
    guestUsername: string;
    credentialPath: string;
    unattendPath: string;
};

export type HyperVGuestReadyObservation = {
    ok: boolean;
    vmId: string;
    vmName: string;
    computerName: string;
    attempts: number;
    networkAddress?: string;
};

export type HyperVGuestReadyFailureObservation = {
    ok: false;
    error: "hyper-v-guest-ready-timeout" | "hyper-v-guest-ready-failed";
    reason: string;
    attempts: number;
    // True once the guest's marker and secrets checks have both passed, regardless of what failed
    // afterwards. Containment uses this instead of inferring scrub state from whether the
    // provisioning ISO is still on disk, because a failure in the media removal itself leaves that
    // ISO behind on a guest that is demonstrably clean.
    scrubConfirmed: boolean;
    // True only once the provisioning DVD is actually gone from the VM. scrubConfirmed says the
    // guest's registry and Panther are clean; it says nothing about the still-mounted ISO, which
    // carries the local Administrator password in plaintext and is readable by anything inside
    // the guest. Containment needs both before it stands down.
    mediaDetached: boolean;
};

export type HyperVBootstrapNetworkCleanupObservation = {
    ok: boolean;
    removed: boolean;
    alreadyMissing: boolean;
};

export type HyperVBootstrapNetworkObservation = {
    ok: boolean;
    addresses: string[];
    diagnosticCode?:
        | "hyper-v-bootstrap-address-selection-failed"
        | "hyper-v-bootstrap-host-prefix-inspection-failed"
        | "hyper-v-bootstrap-management-adapter-inspection-failed"
        | "hyper-v-bootstrap-neighbor-inspection-failed"
        | "hyper-v-bootstrap-network-adapter-ambiguous"
        | "hyper-v-bootstrap-network-adapter-identity-mismatch"
        | "hyper-v-bootstrap-vm-adapter-inspection-failed";
};

export type HyperVSnapshotObservation = {
    ok: boolean;
    snapshotId: string;
    snapshotName: string;
    state?: string;
    snapshotType?: string;
};

export type HyperVCommandOptions = {
    executable: string;
    ownerId: string;
    deviceId: string;
    incarnationId: string;
    vmName: string;
    vmId?: string | null;
    diskPath?: string | null;
    auxiliaryDiskPaths?: string[];
    auxiliaryMediaPaths?: string[];
};

export type HyperVGuestOptions = HyperVCommandOptions & {
    deviceRoot: string;
    privateRoot?: string;
    credentialPath: string;
};

export type HyperVGuestProvisionOptions = HyperVGuestOptions & {
    provisioningMediaPath: string;
    guestUsername: string;
    guestPassword: string;
    networkAddress?: string | null;
    networkGateway?: string | null;
    networkPrefixLength?: number | null;
};

export type HyperVLinuxSeedOptions = HyperVCommandOptions & {
    deviceRoot: string;
    privateRoot: string;
    seedDiskPath: string;
    sshPrivateKeyPath: string;
    sshPublicKeyPath: string;
    sshHostPrivateKeyPath: string;
    sshHostPublicKeyPath: string;
    knownHostsPath: string;
    guestUsername: string;
    networkAddress: string;
    networkGateway: string;
    networkPrefixLength: number;
    macAddress: string;
    dnsServers?: string[];
};

export type HyperVLinuxSshOptions = {
    executable: string;
    deviceRoot: string;
    privateRoot?: string;
    sshPrivateKeyPath: string;
    knownHostsPath: string;
    guestUsername: string;
    networkAddress: string;
    hostKeyAlias?: string;
    strictHostKeyChecking?: "yes" | "accept-new";
    verboseHostKeyDiagnostics?: boolean;
    timeoutMs?: number;
};

export type HyperVLinuxNetworkFinalizeOptions = HyperVLinuxSshOptions & {
    managedMacAddress: string;
    managedNetworkAddress: string;
    networkGateway: string;
    networkPrefixLength: number;
    dnsServers?: string[];
};

export type HyperVSeedTarget={executable:string;vmId:string;vmName:string;expectedNotes:string;generation:1|2;osDiskPath:string;mediaPath:string;managedMacAddress:string};
export type HyperVProvisionTarget={executable:string;mediaCommand:HyperVScriptCommand;vmId:string;vmName:string;expectedNotes:string;generation:1|2;osDiskPath:string;mediaPath:string;credentialPath:string;guestUsername:string;outputLimit:number};
export type HyperVPowerTarget={executable:string;ownerId:string;deviceId:string;incarnationId:string;vmId:string;vmName:string};
export type HyperVBootstrapTarget={executable:string;ownerId:string;deviceId:string;incarnationId:string;vmName:string;vmId:string|null;deadlineAt:number};
export function hyperVCreateNumber(record:unknown,key:string):number|null{if(!hyperVCreateRecord(record))return null;const value=record[key];return typeof value==='number'&&Number.isFinite(value)?value:null;}

export type HyperVScriptCommand={mode:"exec";provider:"hyper-v"|"hyper-v-ssh"|"hyper-v-scp";executable:string;args:string[];input?:string};

export function hyperVDeviceDefinition(ownerId:string,parsed:HyperVLifecycleRequest,facts:{name:string;timestamp:string;vmName:string;deviceRoot:string;privateRoot:string;validIncarnation:boolean}):Record<string,unknown>{const create=parsed.create||{};const linuxGuest=parsed.backend==='linux-vm';const {name,vmName,deviceRoot,privateRoot,validIncarnation}=facts;const now=facts.timestamp;
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        const profile = typeof create.profile === "string" ? create.profile : linuxGuest ? "ubuntu-lts" : "windows-11";
        const secureBoot=hyperVSecureBootConfiguration(parsed.backend);
        return {
            id: parsed.deviceId,
            name,
            backend: parsed.backend,
            kind: linuxGuest ? "vm" : "desktop",
            platform: linuxGuest ? "linux" : "windows",
            ownerId,
            provider: "hyper-v",
            ...(validIncarnation ? { incarnationId: create.incarnationId } : {}),
            vmName,
            ...(typeof create.vmId === "string" ? { vmId: create.vmId.toLowerCase() } : {}),
            profile,
            baseImagePath: typeof create.image === "string" ? create.image : create.sourceImage,
            baseImageSha256: typeof create.baseImageSha256 === "string" ? create.baseImageSha256 : undefined,
            ...((create.baseImageGeneration === 1 || create.baseImageGeneration === 2) ? { baseImageGeneration: create.baseImageGeneration } : {}),
            ...(typeof create.sourceImage === "string" ? { sourceImage: create.sourceImage } : {}),
            deviceRoot,
            privateRoot,
            diskPath,
            guestTransport: linuxGuest ? "ssh" : "powershell-direct",
            ...(linuxGuest ? {
                seedDiskPath: join(deviceRoot, "disks", "cidata.iso"),
                sshPrivateKeyPath: join(privateRoot, "secrets", "id_ed25519"),
                sshPublicKeyPath: join(privateRoot, "secrets", "id_ed25519.pub"),
                sshHostPrivateKeyPath: join(privateRoot, "secrets", "ssh_host_ed25519_key"),
                sshHostPublicKeyPath: join(privateRoot, "secrets", "ssh_host_ed25519_key.pub"),
                sshKnownHostsPath: join(privateRoot, "secrets", "known_hosts"),
                ...(typeof create.sshHostKeyFingerprint === "string" ? { sshHostKeyFingerprint: create.sshHostKeyFingerprint } : {}),
            } : { guestCredentialPath: join(privateRoot, "secrets", "guest.credential.xml") }),
            ...(typeof create.guestUsername === "string" ? { guestUsername: create.guestUsername } : {}),
            ...(create.guestProvisioned === true ? { guestProvisioned: true } : {}),
            ...(typeof create.guestUnattendPath === "string" ? { guestUnattendPath: create.guestUnattendPath } : {}),
            memoryMb: typeof create.memoryMb === "number" ? create.memoryMb : 4096,
            cpus: typeof create.cpus === "number" ? create.cpus : 2,
            diskMaxBytes: typeof create.diskMaxBytes === "number" ? create.diskMaxBytes : 0,
            ...(create.nestedVirtualization === true ? { nestedVirtualization: true } : {}),
            networking: create.networking !== false,
            ...(typeof create.switchName === "string" ? { switchName: create.switchName } : {}),
            ...(typeof create.networkAddress === "string" ? { networkAddress: create.networkAddress } : {}),
            ...(typeof create.macAddress === "string" ? { macAddress: create.macAddress } : {}),
            ...(typeof create.networkGateway === "string" ? { networkGateway: create.networkGateway } : {}),
            ...(typeof create.networkPrefix === "string" ? { networkPrefix: create.networkPrefix } : {}),
            ...(create.outboundPolicy === "nat" ? { outboundPolicy: "nat" } : {}),
            ...secureBoot,
            snapshots: [],
            status: "stopped",
            runtimeState: "Off",
            creatable: true,
            createdAt: now,
            updatedAt: now,
            authority: "host-broker",
        };
}

export function hyperVSecureBootConfiguration(backend:string):{secureBootEnabled:boolean;secureBootTemplate:"MicrosoftUEFICertificateAuthority"|"MicrosoftWindows"}{const linuxGuest=backend==="linux-vm";return {secureBootEnabled:!linuxGuest,secureBootTemplate:linuxGuest?"MicrosoftUEFICertificateAuthority":"MicrosoftWindows"};}

export type HyperVCreateStartRequest=HyperVLifecycleRequest&{command:"device_create"|"device_start"|"device_reboot"};

export function hyperVCreateUniqueFields():Array<string|string[]>{return ["id","vmId","vmName","diskPath"];}
