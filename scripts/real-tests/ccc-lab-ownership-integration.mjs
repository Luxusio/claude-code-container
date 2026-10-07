// Opt-in: CCC_TEST_IDENTITY_IMAGE=sha256:<immutable CCC base> node scripts/real-tests/ccc-lab-ownership-integration.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.CCC_TEST_IDENTITY_IMAGE;
if (!base) { console.log('SKIP: set CCC_TEST_IDENTITY_IMAGE to an immutable CCC image ID'); process.exit(0); }
assert.match(base, /^sha256:[a-f0-9]{64}$/);
const runId = `ccc-lab-test-${randomUUID()}`;
const home = mkdtempSync(join(tmpdir(), `${runId}-`));
const volumes = [], containers = [];
function record() { writeFileSync(join(home, 'owned-resources.json'), JSON.stringify({ volumes, containers }, null, 2)); }
function docker(args) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 300000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
function run(command, args = []) {
    const name = `${runId}-${containers.length}`; containers.push(name); record();
    return docker(['run', '--rm', '--name', name, '--label', `ccc.lab.test=${runId}`, '--network', 'none', '--user', 'root', ...args, '--entrypoint', '/bin/sh', base, '-c', command]);
}
function volume(suffix) {
    const name = `${runId}-${suffix}`;
    assert.notEqual(spawnSync('docker', ['volume', 'inspect', name], { stdio: 'ignore' }).status, 0);
    volumes.push(name); record();
    docker(['volume', 'create', '--label', `ccc.lab.test=${runId}`, name]);
    return name;
}
const mount = name => ['--mount', `type=volume,src=${name},dst=/state`];
function prepare(name, identity, previous = base) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { prepareLabStateOwnership } = await import(process.argv[1]);
        prepareLabStateOwnership(process.argv[2], process.argv[3], JSON.parse(process.argv[4]), process.argv[5] || undefined);
    `, new URL('../../dist/lab-state-ownership.js', import.meta.url).href, name, base, JSON.stringify(identity), previous || ''], {
        encoding: 'utf8', timeout: 900000, env: { ...process.env, HOME: home, CCC_RUNTIME: 'docker', container: '' },
    });
    assert.equal(child.error, undefined, child.error?.message);
    return child;
}
try {
    const originalId = docker(['image', 'inspect', base, '--format', '{{.Id}}']);
    const [oldUid, oldGid] = run('printf "%s:%s" "$(id -u ccc)" "$(id -g ccc)"').split(':').map(Number);
    assert(oldUid > 0 && oldGid > 0);
    const identity = { uid: oldUid === 12345 ? 12346 : 12345, gid: oldGid === 23456 ? 23457 : 23456, mapping: 'host', contractVersion: '1' };
    const retained = volume('retained');
    run(`set -eu; mkdir /state/nested; printf preserved > /state/nested/owned; printf foreign > /state/foreign; chmod 640 /state/nested/owned; ln -s /state/foreign /state/link; chown -hR ${oldUid}:${oldGid} /state; chown 34567:45678 /state/foreign`, mount(retained));
    const inspect = 'stat -c "%u:%g:%a" /state /state/nested/owned /state/foreign /state/link; cat /state/nested/owned /state/foreign';
    const before = run(inspect, mount(retained));
    // Missing provenance must never guess the previous owner from retained data.
    assert.notEqual(prepare(retained, identity, null).status, 0);
    assert.equal(run(inspect, mount(retained)), before);
    const migrated = prepare(retained, identity);
    assert.equal(migrated.status, 0, migrated.stderr);
    const after = run(inspect, mount(retained));
    assert.match(after, new RegExp(`^${identity.uid}:${identity.gid}:755\\n${identity.uid}:${identity.gid}:640\\n34567:45678:644\\n${identity.uid}:${identity.gid}:777\\npreservedforeign`));
    const reused = prepare(retained, identity, null);
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(run(inspect, mount(retained)), after);
    console.log('PASS: old owners migrated, foreign owners/content/modes preserved, symlink target unchanged, absent provenance refused, compatible state reused');
    const busy = `${runId}-busy`; containers.push(busy); record();
    docker(['run', '-d', '--name', busy, '--label', `ccc.lab.test=${runId}`, '--network', 'none', ...mount(retained), '--entrypoint', '/bin/sh', base, '-c', 'sleep 300']);
    const refused = prepare(retained, identity);
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /may be in use/);
    assert.equal(run(inspect, mount(retained)), after);
    docker(['rm', '-f', busy]);
    const missing = `${runId}-missing`;
    const absent = prepare(missing, identity);
    assert.equal(absent.status, 0, absent.stderr);
    assert.notEqual(spawnSync('docker', ['volume', 'inspect', missing], { stdio: 'ignore' }).status, 0);
    assert.equal(docker(['image', 'inspect', base, '--format', '{{.Id}}']), originalId);
    console.log('PASS: active volume refused without writes; missing volume not created; immutable base preserved');
} finally {
    const failures = [];
    for (const name of containers) {
        if (spawnSync('docker', ['container', 'inspect', name], { stdio: 'ignore' }).status === 0) {
            try { docker(['rm', '-f', name]); } catch (error) { failures.push(String(error)); }
        }
    }
    for (const name of volumes) { try { docker(['volume', 'rm', name]); } catch (error) { failures.push(String(error)); } }
    if (failures.length) { console.error(`Cleanup incomplete; resource record: ${home}/owned-resources.json`); throw new AggregateError(failures); }
    rmSync(home, { recursive: true, force: true });
}
console.log('PASS: all exact-owned lab fixtures cleaned');
