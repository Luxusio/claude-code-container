import { Buffer } from 'node:buffer';
import { type DesktopGuestIntent, type DesktopExecution, type DesktopDirectAction, type DesktopDirectObservation, type DesktopWindowFailure, type DesktopReceipt } from '../../domain/hyper-v-desktop-transfer.js';
import {linuxWindowListCommand, windowsWindowListCommand, parseGuestWindowList, parseGuestFocusWindow, linuxFocusWindowCommand, windowsFocusWindowCommand} from './window-list.js';
import {hyperVLinuxGuiTypeGuestCommand, hyperVLinuxGuiScrollGuestCommand} from '../../../host-control/hyper-v/index.js';

export function desktopGuestCommand(backend:string,intent:DesktopGuestIntent):string {
 switch(intent.kind){
 case 'exec':return intent.command;
 case 'window-list':return backend==='linux-vm'?linuxWindowListCommand():windowsWindowListCommand();
 case 'focus':return backend==='linux-vm'?linuxFocusWindowCommand(intent.handle):windowsFocusWindowCommand(intent.handle);
 case 'type':return hyperVLinuxGuiTypeGuestCommand(intent.text);
 case 'scroll':return hyperVLinuxGuiScrollGuestCommand(intent.direction,intent.amount);
 }
}
export function desktopRemoteReadOutputLimit(maxBytes: number): number {
    return Math.ceil((maxBytes + 1) / 3) * 4 + 4096;
}
export function desktopRemoteReadCommand(remotePath:string,maxBytes:number):string {
 const encodedPath=Buffer.from(remotePath,'utf8').toString('base64');
 return `set -o pipefail; p=$(printf %s ${encodedPath} | base64 -d); head -c ${maxBytes+1} -- "$p" | base64 -w0`;
}
export type DesktopDirectResult = { action: 'exec'; status: number; stdout: string; stderr: string }
 | { action: 'job'; output: string } | { action: 'mkdir' }
 | { action: 'upload' | 'download'; localPath: string; remotePath: string; bytes: number };
export interface DesktopNativeExecution {
 ok?: boolean;
 mode?: string;
 provider?: string;
 status?: number | null;
 stdout?: string;
 stderr?: string;
 error?: string;
 timedOut?: boolean;
}
export type DesktopReceiptPresentation = { kind: 'execution'; execution: DesktopNativeExecution }
 | { kind: 'direct'; result: { status?: number; stdout?: string; stderr?: string; localPath?: string; remotePath?: string; bytes?: number } };
const receipts = new WeakMap<DesktopReceipt, DesktopReceiptPresentation>();
function rememberReceipt(presentation: DesktopReceiptPresentation): DesktopReceipt {
 const receipt = Object.freeze({}) as DesktopReceipt;
 receipts.set(receipt, presentation);
 return receipt;
}
/** Only outward presentation reads native evidence. Application code carries the receipt untouched. */
export function desktopReceiptPresentation(receipt: DesktopReceipt): DesktopReceiptPresentation | undefined {
 return receipts.get(receipt);
}
function windowObservation(observation: Extract<DesktopExecution, {kind:'completed'}>, backend: string, intent: DesktopGuestIntent | undefined, stdout: string): DesktopExecution {
 if(intent?.kind!=='window-list'&&intent?.kind!=='focus')return observation;
 try {
  if(intent.kind==='window-list')observation.windows=parseGuestWindowList(backend,stdout);
  else observation.focused=parseGuestFocusWindow(stdout).ok;
 } catch(error) {
  const known: readonly DesktopWindowFailure[]=['window-focus-invalid-result','window-list-invalid-result','window-focus-denied','window-not-found','focus-window-session-changed','window-list-session-changed','window-list-query-failed'];
  const code=error instanceof Error?error.message:'';
  return {kind:'window-failed',reason:known.includes(code as DesktopWindowFailure)?code as DesktopWindowFailure:intent.kind==='focus'?'window-focus-invalid-result':'window-list-invalid-result',receipt:observation.receipt};
 }
 return observation;
}
export function observeDesktopExecution(execution:DesktopNativeExecution,action:'exec'|'upload'|'download',intent?:DesktopGuestIntent):DesktopExecution {
 const receipt=rememberReceipt({kind:'execution',execution:action==='download'&&execution.status===0&&!execution.error?{...execution,stdout:''}:execution});
 if(execution.status!==0||execution.error)return {kind:'failed',reason:'provider',category:'provider-failed',receipt};
 const observation:Extract<DesktopExecution,{kind:'completed'}>={kind:'completed',action,receipt};
 if(action==='download'){
 const encoded=String(execution.stdout||'').trim();
 if(encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))observation.artifactInvalid=true;
 else observation.artifact=Buffer.from(encoded,'base64');
 } else return windowObservation(observation,'linux-vm',intent,execution.stdout||'');
 return observation;
}
export function observeDesktopDirect(result:DesktopDirectResult,action:DesktopDirectAction,intent?:DesktopGuestIntent):DesktopDirectObservation {
 const receipt=rememberReceipt({kind:'direct',result:result.action==='exec'?{status:result.status,stdout:result.stdout,stderr:result.stderr}:result.action==='upload'||result.action==='download'?{localPath:result.localPath,remotePath:result.remotePath,bytes:result.bytes}:{}});
 if(result.action!==action.action)return {kind:'failed',reason:'invalid-result',category:'provider-failed',receipt};
 if(result.action==='exec'){
 if(result.status!==0)return {kind:'guest-failed',action:'exec',receipt};
 return windowObservation({kind:'completed',action:'exec',receipt},'windows-vm',intent,result.stdout);
 }
 if(result.action==='upload'||result.action==='download')return {kind:'completed',action:result.action,bytes:result.bytes,receipt};
 return {kind:'failed',reason:'invalid-result',category:'provider-failed',receipt};
}
export function observeDesktopDirectFailure(code: string, validation: boolean): DesktopDirectObservation {
 return {kind:'failed',reason:'provider',category:validation?'invalid':'provider-failed',receipt:rememberReceipt({kind:'execution',execution:{ok:false,mode:'exec',provider:'hyper-v',status:null,error:code}})};
}
