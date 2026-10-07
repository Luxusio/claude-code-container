// Opt-in: CCC_TEST_STARTUP_IMAGE=sha256:<immutable integration image> node scripts/real-tests/ccc-startup-integration.mjs
// The Docker adapter isolates resource names only. It does not replace lifecycle decisions,
// statuses, source identity evidence, or commands executed inside the real container.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.CCC_TEST_STARTUP_IMAGE;
if (!base) { console.log('SKIP: set CCC_TEST_STARTUP_IMAGE to an immutable CCC image ID'); process.exit(0); }
assert.match(base, /^sha256:[a-f0-9]{64}$/);
assert.equal(process.platform, 'linux');
const prefix = `ccc-startup-test-${randomUUID()}`;
const home = mkdtempSync(join(tmpdir(), `${prefix}-`));
const project = join(home, 'project'); mkdirSync(project);
const bin = join(home, 'bin'); mkdirSync(bin);
const resources = { tags: [], volumes: [], containers: [] };
const record = () => writeFileSync(join(home, 'owned-resources.json'), JSON.stringify(resources, null, 2));
const realDocker = spawnSync('which', ['docker'], { encoding: 'utf8' }).stdout.trim();
assert.ok(realDocker.startsWith('/'));
function docker(args, options = {}) {
    const result = spawnSync(realDocker, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024, ...options });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `docker ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
}
function reserve(kind, name) {
    assert.notEqual(spawnSync(realDocker, [kind, 'inspect', name], { stdio: 'ignore' }).status, 0, `refuse existing ${kind} ${name}`);
    resources[kind === 'image' ? 'tags' : kind === 'volume' ? 'volumes' : 'containers'].push(name); record();
}
let fixtureBase;
try {
    const source = `${prefix}:source`, fixture = `${prefix}:base`;
    reserve('image', source); docker(['tag', base, source]);
    reserve('image', fixture);
    docker(['build', '--pull=false', '-t', fixture, '-'], { input: `FROM ${source}\nLABEL ccc.startup.test="${prefix}"\n` });
    fixtureBase = docker(['image', 'inspect', fixture, '--format', '{{.Id}}']);
    reserve('image', `ccc-identity-base:${fixtureBase.slice(7)}`);
    const uid = process.getuid(), gid = process.getgid();
    const labels = { 'ccc.identity.version': '1', 'ccc.identity.uid': String(uid), 'ccc.identity.gid': String(gid), 'ccc.identity.mapping': 'host', 'ccc.identity.base': fixtureBase };
    reserve('image', `ccc-identity:${createHash('sha256').update(JSON.stringify(labels)).digest('hex')}`);
    const volumeMap = {};
    for (const [kind, logical] of [['mise', `ccc-mise-cache-v1-host-${uid}-${gid}`], ['packages', `ccc-codex-packages-v1-host-${uid}-${gid}`]]) {
        const physical = `${prefix}-${kind}`; reserve('volume', physical); volumeMap[logical] = physical;
    }
    // Pass-through stdin/stdout, except valid inspect JSON Mounts fields for our two volumes.
    // No global string substitution: host paths, labels, exec scripts, and identities remain real.
    writeFileSync(join(bin, 'docker'), `#!${process.execPath}\n` + String.raw`
const {spawnSync}=require('node:child_process');
const map=JSON.parse(process.env.CCC_FIXTURE_VOLUME_MAP);
const original=process.argv.slice(2);
const args=original.map((a,i)=>{
 const imageOperand=(original[0]==='images'&&i===original.length-1)||(original[0]==='inspect'&&i===1)||(original[0]==='image'&&original[1]==='inspect'&&i===2);
 if(a==='ccc'&&imageOperand) return process.env.CCC_FIXTURE_IMAGE;
 return map[a]||a.replace(/^(ccc-(?:mise-cache|codex-packages)-v1-host-\d+-\d+)(:.*)$/,(_,n,s)=>(map[n]||n)+s).replace(/(^|,)(?:src|source)=([^,]+)/g,(all,lead,n)=>map[n]?all.replace(n,map[n]):all);
});
if(args[0]==='pull') { console.error('fixture refuses image pulls; compile/image versions must match'); process.exit(95); }
const result=spawnSync(process.env.CCC_FIXTURE_DOCKER,args,{encoding:'utf8',stdio:['inherit','pipe','inherit'],maxBuffer:32*1024*1024});
let output=result.stdout||'';
if(args.includes('inspect')) {
 try { const value=JSON.parse(output); const rows=Array.isArray(value)?value:[value];
  for(const row of rows) for(const mount of row.Mounts||[]) for(const [logical,physical] of Object.entries(map)) {
   if(mount.Type==='volume'&&mount.Name===physical) {
    mount.Name=logical;
    if(typeof mount.Source==='string') mount.Source=mount.Source.replace('/volumes/'+physical+'/', '/volumes/'+logical+'/');
   }
  }
  output=JSON.stringify(value);
 } catch {}
}
process.stdout.write(output); if(result.error) console.error(result.error.message); process.exit(result.status??1);
`, { mode: 0o755 });
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'), CODEX_HOME: join(home, '.codex'), CCC_RUNTIME: 'docker', container: '', SSH_AUTH_SOCK: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PATH: `${bin}:${process.env.PATH}`, CCC_FIXTURE_DOCKER: realDocker, CCC_FIXTURE_IMAGE: fixture, CCC_FIXTURE_VOLUME_MAP: JSON.stringify(volumeMap) };
    const root = new URL('../../dist/', import.meta.url).href;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `const d=await import(process.argv[1]+'docker.js'); console.log(d.getContainerName(process.argv[2],'smoke'));`, root, project], { env, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr); const name = probe.stdout.trim();
    assert.match(name, /^ccc-/); reserve('container', name); reserve('volume', `${name}-lab-state`);
    const childFile = join(home, 'startup.mjs');
    writeFileSync(childFile, String.raw`
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const root=process.argv[2],project=process.argv[3],profile='smoke';
const d=await import(root+'docker.js'), u=await import(root+'utils.js'), t=await import(root+'tool-registry.js');
const setup=await import(root+'container-setup.js');
const runtime=await import(root+'container-runtime.js');
const ensureDirs=()=>{ mkdirSync(u.getClaudeDir(profile),{recursive:true,mode:0o700}); writeFileSync(u.getClaudeJsonFile(profile),'{}',{mode:0o600}); for(const mount of t.getAllCredentialMounts()) d.ensureCredentialHostDir(mount,profile); };
const exec=(args)=>{const r=spawnSync('docker',args,{encoding:'utf8',timeout:180000}); assert.equal(r.error,undefined); assert.equal(r.status,0,r.stderr); return r.stdout.trim();};
let ready;
console.log('START: real lifecycle create');
const name=d.startProjectContainer(project,ensureDirs,undefined,undefined,profile,undefined,undefined,id=>ready=id);
assert.match(ready,/^[a-f0-9]{64}$/); assert.equal(exec(['inspect','--format','{{.Id}}',name]),ready);
console.log('PASS: pinned startup ID');
const first=ready;
// Like the CLI, refuse replacement of running work. A strict daemon socket alias
// mismatch must continue through the real safe-defer daemon-ID proof, not bypass it.
const refuseRunningReplacement=()=>{
 const [observed]=JSON.parse(exec(['inspect',first]));
 const socket=(observed.Mounts||[]).find(mount=>mount.Destination==='/var/run/docker.sock');
 console.log('DIAGNOSTIC: running replacement refused '+JSON.stringify({
  socket:socket?{Source:socket.Source,Destination:socket.Destination,Type:socket.Type,RW:socket.RW}:null,
  runtime:runtime.getRuntimeInfo(),
 }));
 return false;
};
d.startProjectContainer(project,ensureDirs,undefined,undefined,profile,undefined,refuseRunningReplacement,id=>ready=id,first);
assert.equal(ready,first);
assert.equal(exec(['inspect','--format','{{.Id}}|{{.State.Running}}',name]),first+'|true');
console.log('PASS: running reuse preserves ID and running state');
console.log('START: selected Codex setup'); setup.ensureTools(ready,t.getToolByName('codex'));
assert.match(exec(['exec',ready,'codex','--version']),/codex/i);
const {withCodexConfigLock}=await import(root+'codex-config-lock.js');
withCodexConfigLock(()=>d.prepareCodexConfigForContainer(ready,profile),profile);
const {assertCodexStateAccessible}=await import(root+'codex-state-ownership.js'); assertCodexStateAccessible(ready,profile);
console.log('PASS: selected Codex installation and state access');
const {ensureCodexHarness}=await import(root+'codex-harness.js');
let warnings=[]; const oldWarn=console.warn; console.warn=(...args)=>{warnings.push(args.join(' '));oldWarn(...args);};
ensureCodexHarness(ready,profile); console.warn=oldWarn; assert.equal(warnings.length,0,warnings.join('\n'));
assert.match(readFileSync(u.getCodexConfigFile(profile),'utf8'),/harness/);
console.log('PASS: fresh Harness bootstrap');
const {prepareCodexLaunch}=await import(root+'codex-launch.js');
const command=['codex','resume','--last']; const launch=prepareCodexLaunch('docker',['exec',ready],command);
assert.equal(launch.ok,true,JSON.stringify(launch));
assert.deepEqual(launch.command.filter(x=>x!=='--no-daemon'),command);
console.log('PASS: real daemon preparation boundary '+JSON.stringify(launch));
const sentinelPath='/home/ccc/.codex/ccc-startup-fixture-sentinel';
const sentinel='retained Codex state before stopped handoff';
exec(['exec',ready,'sh','-c','printf %s "$1" > "$2"','sh',sentinel,sentinelPath]);
exec(['stop',ready]);
// As in the CLI, approve replacement only while this fixture's exact container
// is stopped. Production rechecks the identity/state under its lifecycle guard.
// Strict socket aliases may require replacement rather than same-ID restart.
const approveStoppedReplacement=(replace)=>{
 assert.equal(exec(['inspect','--format','{{.Id}}|{{.State.Running}}',name]),first+'|false');
 replace();
 return true;
};
let stoppedHandoff;
d.startProjectContainer(project,ensureDirs,undefined,undefined,profile,undefined,approveStoppedReplacement,(id,handoff)=>{ready=id;stoppedHandoff=handoff;});
assert.match(ready,/^[a-f0-9]{64}$/);
assert.equal(exec(['inspect','--format','{{.Id}}|{{.State.Running}}',name]),ready+'|true');
assert.equal(stoppedHandoff.startedByInvocation,true);
assert.equal(exec(['exec',ready,'cat',sentinelPath]),sentinel);
exec(['exec',ready,'sh','-c','printf %s "$1" >> "$2"','sh','; writable after stopped handoff',sentinelPath]);
assert.equal(exec(['exec',ready,'cat',sentinelPath]),sentinel+'; writable after stopped handoff');
assertCodexStateAccessible(ready,profile);
console.log('PASS: stopped-container handoff pins running ID and retains writable Codex state');
`);
    console.log(`START fixture ${prefix} on ${base}`);
    // Three real lifecycle transitions plus fresh tool/bootstrap downloads can
    // exceed 30 minutes on Docker Desktop; each individual operation stays bounded.
    const child = spawnSync(process.execPath, [childFile, root, project], { env, stdio: 'inherit', timeout: 2700000 });
    assert.equal(child.error, undefined, child.error?.message); assert.equal(child.status, 0, 'real startup fixture failed');
    assert.equal(docker(['image', 'inspect', base, '--format', '{{.Id}}']), base);
    console.log('PASS: disposable startup boundaries');
} finally {
    const failures=[];
    for(const name of resources.containers) if(spawnSync(realDocker,['container','inspect',name],{stdio:'ignore'}).status===0) try {docker(['rm','-f',name]);} catch(e){failures.push(e);}
    for(const volume of resources.volumes) if(spawnSync(realDocker,['volume','inspect',volume],{stdio:'ignore'}).status===0) try {docker(['volume','rm',volume]);} catch(e){failures.push(e);}
    // Only this fixture's isolated home may contain files produced by container root.
    if(fixtureBase) try { const cleaner = `${prefix}-cleanup`; reserve('container', cleaner); docker(['run','--rm','--name',cleaner,'--network','none','--user','root','--mount',`type=bind,src=${home},dst=/fixture`,'--entrypoint','/bin/sh',fixtureBase,'-c',`chown -hR ${process.getuid()}:${process.getgid()} /fixture`]);} catch(e){failures.push(e);}
    for(const tag of [...resources.tags].reverse()) if(spawnSync(realDocker,['image','inspect',tag],{stdio:'ignore'}).status===0) try{docker(['image','rm',tag]);}catch(e){failures.push(e);}
    if(failures.length){console.error(`Cleanup incomplete: ${home}/owned-resources.json`);throw new AggregateError(failures);}
    rmSync(home,{recursive:true,force:true});
}
