// Opt-in: CCC_TEST_IDENTITY_IMAGE=sha256:<immutable CCC base> node scripts/real-tests/ccc-identity-integration.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.env.CCC_TEST_IDENTITY_IMAGE;
if (!base) { console.log('SKIP: set CCC_TEST_IDENTITY_IMAGE to an immutable CCC image ID'); process.exit(0); }
assert.match(base, /^sha256:[a-f0-9]{64}$/);
assert.equal(process.platform, 'linux', 'numeric bind ownership requires Linux');
const runId = `ccc-identity-test-${randomUUID()}`;
const home = mkdtempSync(join(tmpdir(), `${runId}-`));
const resources = { tags: [], volumes: [], containers: [], projects: [] };
const record = () => writeFileSync(join(home, 'owned-resources.json'), JSON.stringify(resources, null, 2));
function docker(args, options = {}) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024, ...options });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `docker ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
}
function absentTag(tag) {
    assert.notEqual(spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status, 0, `refuse existing tag ${tag}`);
    resources.tags.push(tag); record();
}
function run(image, args, command, user) {
    const name = `${runId}-${resources.containers.length}`;
    resources.containers.push(name); record();
    return docker(['run', '--rm', '--name', name, '--network', 'none', ...(user ? ['--user', user] : []), ...args, '--entrypoint', '/bin/sh', image, '-c', command]);
}
let fixtureBase;
let passed = false;
try {
    const before = docker(['image', 'inspect', base, '--format', '{{.Id}}']);
    const sourceTag = `${runId}:source`;
    absentTag(sourceTag); docker(['tag', base, sourceTag]);
    const fixtureTag = `${runId}:base`;
    absentTag(fixtureTag);
    docker(['build', '--pull=false', '-t', fixtureTag, '-'], { input: `FROM ${sourceTag}\nLABEL ccc.identity.test="${runId}"\n` });
    fixtureBase = docker(['image', 'inspect', fixtureTag, '--format', '{{.Id}}']);
    absentTag(`ccc-identity-base:${fixtureBase.slice(7)}`);
    const sentinel = join(home, 'readonly'); mkdirSync(sentinel);
    writeFileSync(join(sentinel, 'keep'), 'unchanged', { mode: 0o444 });
    const sentinelBefore = statSync(join(sentinel, 'keep'));
    const moduleUrl = new URL('../../dist/container-identity.js', import.meta.url).href;
    for (const [uid, gid] of [[1000, 1000], [12345, 23456]]) {
        const identity = { uid, gid, mapping: 'host', contractVersion: '1' };
        const labels = { 'ccc.identity.version': '1', 'ccc.identity.uid': String(uid), 'ccc.identity.gid': String(gid), 'ccc.identity.mapping': 'host', 'ccc.identity.base': fixtureBase };
        const key = createHash('sha256').update(JSON.stringify(labels)).digest('hex');
        absentTag(`ccc-identity:${key}`);
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
            const { ensureIdentityImage } = await import(process.argv[1]);
            const identity = JSON.parse(process.argv[3]);
            const first = ensureIdentityImage(process.argv[2], identity);
            const second = ensureIdentityImage(process.argv[2], identity);
            if (first !== second) throw new Error('derived image cache was not reused');
            console.log(JSON.stringify({ image: first, reused: true }));
        `, moduleUrl, fixtureBase, JSON.stringify(identity)], {
            encoding: 'utf8', timeout: 1200000, maxBuffer: 32 * 1024 * 1024,
            env: { ...process.env, HOME: home, CCC_RUNTIME: 'docker', container: '' },
        });
        assert.equal(child.error, undefined, child.error?.message);
        assert.equal(child.status, 0, child.stderr);
        const { image, reused } = JSON.parse(child.stdout.trim()); assert.equal(reused, true);
        const project = join(home, `project-${uid}`); mkdirSync(project); resources.projects.push(project); record();
        run(image, ['--mount', `type=bind,src=${project},dst=/project`], `chown ${uid}:${gid} /project`, 'root');
        const mounts = ['--mount', `type=bind,src=${project},dst=/project`, '--mount', `type=bind,src=${sentinel},dst=/sentinel,readonly`];
        for (const [kind, target] of [['mise', '/home/ccc/.local/share/mise'], ['packages', '/home/ccc/.codex/packages']]) {
            const volume = `${runId}-${uid}-${kind}`;
            assert.notEqual(spawnSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' }).status, 0);
            resources.volumes.push(volume); record(); docker(['volume', 'create', '--label', `ccc.identity.test=${runId}`, volume]);
            mounts.push('--mount', `type=volume,src=${volume},dst=${target}`);
        }
        const observed = run(image, mounts, `set -eu
            test "$(id -un)" = ccc; test "$HOME" = /home/ccc; sudo -n true
            test "$(id -u):$(id -g)" = ${uid}:${gid}
            printf project > /project/created
            printf cache > /home/ccc/.local/share/mise/ccc-identity-test
            printf cache > /home/ccc/.codex/packages/ccc-identity-test
            test "$(cat /sentinel/keep)" = unchanged
            if (printf changed > /sentinel/keep) 2>/dev/null; then exit 90; fi
            stat -c '%u:%g' /project/created /home/ccc/.local/share/mise/ccc-identity-test /home/ccc/.codex/packages/ccc-identity-test`);
        assert.deepEqual(observed.split('\n'), Array(3).fill(`${uid}:${gid}`));
        assert.equal(statSync(join(project, 'created')).uid, uid);
        assert.equal(statSync(join(project, 'created')).gid, gid);
        assert.equal(readFileSync(join(sentinel, 'keep'), 'utf8'), 'unchanged');
        const after = statSync(join(sentinel, 'keep'));
        assert.deepEqual([after.uid, after.gid, after.mode, after.mtimeMs], [sentinelBefore.uid, sentinelBefore.gid, sentinelBefore.mode, sentinelBefore.mtimeMs]);
        console.log(`PASS ${uid}:${gid}: image reuse, ccc/HOME/sudo, project and two cache owners, readonly sentinel`);
    }
    assert.equal(docker(['image', 'inspect', base, '--format', '{{.Id}}']), before);
    passed = true;
} finally {
    const failures = [];
    for (const name of resources.containers) {
        if (spawnSync('docker', ['container', 'inspect', name], { stdio: 'ignore' }).status === 0) {
            try { docker(['rm', '-f', name]); } catch (error) { failures.push(String(error)); }
        }
    }
    for (const project of resources.projects) {
        try { run(fixtureBase, ['--mount', `type=bind,src=${project},dst=/fixture`], `chown -hR ${process.getuid()}:${process.getgid()} /fixture`, 'root'); }
        catch (error) { failures.push(String(error)); }
    }
    for (const volume of resources.volumes.reverse()) {
        try { docker(['volume', 'rm', volume]); } catch (error) { failures.push(String(error)); }
    }
    for (const tag of resources.tags.reverse()) {
        if (spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0) {
            try { docker(['image', 'rm', tag]); } catch (error) { failures.push(String(error)); }
        }
    }
    if (failures.length) { console.error(`Cleanup incomplete; resource record: ${home}/owned-resources.json`); throw new AggregateError(failures); }
    rmSync(home, { recursive: true, force: true });
}
if (passed) console.log('PASS: all identity fixtures cleaned; source image preserved');
