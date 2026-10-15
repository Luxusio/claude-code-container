import type { GuestProbe } from '../../domain/lifecycle/hyper-v-create-start.js';
import type {WindowsReadinessPorts} from "../../ports/lifecycle/hyper-v-create-start.js";
import {waitHyperVWindowsGuestReadiness} from '../../application/lifecycle/hyper-v-create-start.js';
import type {
    WindowsReadinessOutcome,
    HyperVNativeExecution,
    HyperVGuestReadinessFailureDetail,
    HyperVWindowsReadinessObservation,
    HyperVLinuxReadinessObservation,
    HyperVGuestReadinessObservation,
    HyperVReadinessFailureSource,
} from '../../domain/lifecycle/hyper-v-create-start.js';
import {hyperVProviderDiagnosticCode} from './public-response.js';
import type {ProviderCommandResult} from '../../../device-lab-broker.js';
import {nativeHyperVExecutionReceipt} from './lifecycle-outcomes.js';
export type DeviceLabHyperVGuestReadinessOutcome = WindowsReadinessOutcome;
import {
    createHyperVGuestDirectClient,
    HyperVWindowsError,
    type HyperVGuestDirectIdentity,
} from "@ccc/hyper-v/index.js";
import {
    createDeviceLabHyperVWindowsClient,
    createDeviceLabHyperVWindowsExecutor,
    type DeviceLabHyperVWindowsClientOptions,
} from "./lifecycle-adapter.js";

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

const PROBE_SOURCE = [
    "$Winlogon = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'",
    "[ordered]@{",
    "  computerName = [Environment]::MachineName",
    "  addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object IPAddress)",
    "  firstLogonCompleted = [string](Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\ccc' -Name 'FirstLogonCompleted' -ErrorAction SilentlyContinue).FirstLogonCompleted",
    "  provisioningSecretsPresent = [bool]((Test-Path -LiteralPath 'C:\\Windows\\Panther\\unattend.xml') -or (Test-Path -LiteralPath 'C:\\Windows\\Panther\\Unattend\\unattend.xml') -or ($null -ne (Get-ItemProperty -LiteralPath $Winlogon -Name 'DefaultPassword' -ErrorAction SilentlyContinue)))",
    "} | ConvertTo-Json -Compress -Depth 4",
].join("\n");

type Options = Omit<DeviceLabHyperVWindowsClientOptions, "session" | "record"> & {
    readonly identity: HyperVGuestDirectIdentity;
    readonly provisioningMediaPath: string;
    readonly expectedNetworkAddress: string;
    readonly timeoutMilliseconds: number;
    readonly noProgressTimeoutMilliseconds?: number;
    readonly removeProvisioningMedia: () => void | Promise<void>;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
};

export function deviceLabWindowsReadinessPorts(options:Pick<Options,"executable"|"timeoutMilliseconds"|"run"|"removeProvisioningMedia"|"now"|"sleep">):WindowsReadinessPorts {
 let timeout=options.timeoutMilliseconds;
 let native: {guest:ReturnType<typeof createHyperVGuestDirectClient>;host:ReturnType<typeof createDeviceLabHyperVWindowsClient>}|undefined;
 const clients=()=>{
  if(!native){const transport={executable:options.executable,timeoutMilliseconds:()=>timeout,run:options.run}; native={guest:createHyperVGuestDirectClient(createDeviceLabHyperVWindowsExecutor(transport)),host:createDeviceLabHyperVWindowsClient(transport)};}
  return native;
 };
 return {
  probe:async(identity,budget)=>{timeout=budget;const output=await clients().guest.invoke({...identity,action:'job',command:PROBE_SOURCE},budget);if(output.action!=='job')return {kind:'unexpected'}; const probe=parseWindowsReadinessProbe(output.output); return probe?{kind:'valid',probe}:{kind:'invalid'};},
  detachMedia:async(identity,path,budget)=>{timeout=budget;await clients().host.removeVMDvdDrive({selector:identity.selector,expectedName:identity.expectedName,expectedNotes:identity.expectedNotes,path});return undefined;},
  machines:async(identity,budget)=>{timeout=budget;return clients().host.getVM(identity.selector);},
  media:async(identity,budget)=>{timeout=budget;return clients().host.getVMDvdDrives(identity.selector);},
  removeMedia:async()=>{await options.removeProvisioningMedia();return undefined;},
  errorInfo:error=>error instanceof HyperVWindowsError?{code:error.code,category:error.category}:null,
  now:options.now??Date.now,
  sleep:options.sleep??(milliseconds=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds))),
 };
}

export async function waitForDeviceLabHyperVGuestReadiness(options:Options):Promise<DeviceLabHyperVGuestReadinessOutcome>{return waitHyperVWindowsGuestReadiness(options,deviceLabWindowsReadinessPorts(options));}


export function parseHyperVLinuxEd25519HostKeyFingerprints(sshDiagnostic: string): readonly string[] {
    const observed = new Set<string>();
    const bounded = sshDiagnostic.slice(0, 64 * 1024);
    const patterns = [
        /server host key:\s+ssh-ed25519\s+(SHA256:[A-Za-z0-9+/]{43})=?/gi,
        /fingerprint for the ED25519 key sent by (?:the )?remote host is\s+(SHA256:[A-Za-z0-9+/]{43})=?/gi,
    ];
    for (const pattern of patterns) {
        for (const match of bounded.matchAll(pattern)) observed.add(match[1]);
    }
    return [...observed];
}

function readinessFailureDetail(
    backend: 'windows-vm' | 'linux-vm',
    execution: ProviderCommandResult,
    outcome: WindowsReadinessOutcome | null = null,
): HyperVGuestReadinessFailureDetail {
    const diagnosticCode = hyperVProviderDiagnosticCode(execution);
    return {evidence: {
        ...(backend === 'windows-vm' ? {structured: outcome?.ok === false} : {}),
        status: typeof execution.status === 'number' ? execution.status : null,
        timedOut: execution.timedOut === true,
        stdoutBytes: Buffer.byteLength(String(execution.stdout || ''), 'utf8'),
        stderrBytes: Buffer.byteLength(String(execution.stderr || ''), 'utf8'),
        ...(diagnosticCode ? {diagnosticCode} : {}),
    }};
}

function windowsReadinessFailureCode(execution: ProviderCommandResult, outcome: WindowsReadinessOutcome | null): string {
    if (outcome?.ok === false) return outcome.reason;
    const error = String(execution.error || '');
    if (error.length <= 128 && /^hyper-v-[a-z0-9-]+$/.test(error)) return error;
    return execution.timedOut ? 'powershell-direct-timeout' : 'powershell-direct-unavailable';
}

function linuxReadinessFailureCode(execution: ProviderCommandResult): string {
    const error = String(execution.error || '');
    if (/^hyper-v-linux-gui-(?:(?:privilege|apt-update|apt-install|configure|start|ready)-failed|timeout)$/.test(error)) return error;
    const diagnostic = `${error}\n${execution.stderr || ''}`.toLowerCase();
    if (diagnostic.includes('connection refused')) return 'ssh-connection-refused';
    if (diagnostic.includes('connection timed out') || diagnostic.includes('operation timed out') || execution.timedOut) return 'ssh-connection-timeout';
    if (diagnostic.includes('no route to host') || diagnostic.includes('host is down')) return 'ssh-host-unreachable';
    if (diagnostic.includes('host key verification failed') || diagnostic.includes('remote host identification has changed')) return 'ssh-host-key-rejected';
    if (diagnostic.includes('permission denied') || diagnostic.includes('authentication failed')) return 'ssh-authentication-failed';
    if (error.length <= 128 && /^hyper-v-[a-z0-9-]+$/.test(error)) return error;
    return 'ssh-unavailable';
}

function semanticExecution<Receipt>(receipt: ProviderCommandResult): HyperVNativeExecution<Receipt> {
    return {required: receipt.mode !== 'noop', dispatched: receipt.mode !== 'noop', ok: receipt.status === 0 && !receipt.error,
        ...(receipt.error ? {failureCode: receipt.error} : {}), receipt: receipt as unknown as Receipt};
}
export function deviceLabWindowsReadinessObservation<Receipt>(outcome: WindowsReadinessOutcome): HyperVWindowsReadinessObservation<Receipt> {
    // The historical native summary stays outward; callers keep the typed outcome for policy.
    const execution = {
        mode: 'exec', provider: 'hyper-v', status: outcome.ok ? 0 : 1,
        stdout: JSON.stringify(outcome), stderr: '',
    };
    return {
        backend: 'windows-vm', outcome, execution: semanticExecution<Receipt>(execution), ok: outcome.ok, ready: outcome.ok,
        failureCode: windowsReadinessFailureCode(execution, outcome),
        failureDetail: readinessFailureDetail('windows-vm', execution, outcome),
    };
}

export function deviceLabHyperVLinuxReadinessObservation<Receipt = ProviderCommandResult>(execution: ProviderCommandResult): HyperVLinuxReadinessObservation<Receipt> {
    const ok = execution.status === 0 && !execution.error;
    return {
        backend: 'linux-vm', execution: semanticExecution<Receipt>(execution), ok,
        ready: ok && String(execution.stdout || '').includes('ccc-hyper-v-linux-ready'),
        failureCode: linuxReadinessFailureCode(execution),
        failureDetail: readinessFailureDetail('linux-vm', execution),
        hostKeyFingerprints: parseHyperVLinuxEd25519HostKeyFingerprints(`${execution.error || ''}\n${execution.stderr || ''}`),
    };
}

export function deviceLabHyperVLinuxGuiReadinessObservation<Receipt = ProviderCommandResult>(execution: ProviderCommandResult): HyperVLinuxReadinessObservation<Receipt> {
    const ok = execution.status === 0 && !execution.error;
    const ready = ok && String(execution.stdout || '').includes('CCC_HYPER_V_GUI_READY');
    if (ready) return {...deviceLabHyperVLinuxReadinessObservation<Receipt>(execution), ready};
    const stage = /hyper-v-linux-gui-(?:privilege|apt-update|apt-install|configure|start|ready)-failed/.exec(String(execution.stderr || ''))?.[0];
    const error = stage || (execution.timedOut ? 'hyper-v-linux-gui-timeout' : 'hyper-v-linux-gui-ready-failed');
    return {...deviceLabHyperVLinuxReadinessObservation<Receipt>({...execution, error}), execution: {...semanticExecution<Receipt>(execution), failureCode: error}, ok, ready};
}

export function deviceLabHyperVReadinessFailure<Receipt>(
    backend: 'windows-vm' | 'linux-vm',
    error: string,
    source: HyperVReadinessFailureSource<Receipt> = {},
): HyperVGuestReadinessObservation<Receipt> {
    const previous = source.execution ?? source.previous?.execution;
    const previousEvidence = source.execution === undefined ? source.previous?.failureDetail.evidence : undefined;
    const execution: ProviderCommandResult = {
        ...(previous ? nativeHyperVExecutionReceipt(previous as HyperVNativeExecution<ProviderCommandResult>) : {
            mode: 'exec', provider: backend === 'linux-vm' ? 'hyper-v-ssh' : 'hyper-v', status: null,
        }),
        // A preceding readiness overlay can supersede a native timeout without changing its receipt.
        ...(previousEvidence && typeof previousEvidence === 'object' && 'timedOut' in previousEvidence
            && typeof previousEvidence.timedOut === 'boolean' ? {timedOut: previousEvidence.timedOut} : {}),
        error,
        ...(source.deadlineExpired === undefined ? {} : {timedOut: source.deadlineExpired}),
    };
    const observed = previous ? {...previous, ok: false, failureCode: error}
        : {...semanticExecution<Receipt>(execution), dispatched: false};
    if (backend === 'linux-vm') return {...deviceLabHyperVLinuxReadinessObservation<Receipt>(execution), execution: observed, ready: false};
    const outcome = source.previous?.backend === 'windows-vm' ? source.previous.outcome : null;
    return {
        backend, outcome, execution: observed, ok: false, ready: false,
        failureCode: windowsReadinessFailureCode(execution, outcome),
        failureDetail: readinessFailureDetail(backend, execution, outcome),
    };
}
