#!/usr/bin/env node
// Opt-in Docker exercise of the compiled migration primitive, not the TS startup
// wrapper. No credentials, existing containers, image tags or named volumes used.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexStateMigrationScript } from "../../dist/codex-state-ownership.js";

const image = process.env.CCC_TEST_IDENTITY_IMAGE;
if (!image) {
    console.log("SKIP: set CCC_TEST_IDENTITY_IMAGE=sha256:<immutable-image-id> to run disposable Docker Codex state checks");
    process.exit(0);
}
assert.match(image, /^sha256:[a-f0-9]{64}$/);
assert.equal(process.platform, "linux", "This fixture requires native Linux/WSL ownership semantics");
const uid = process.geteuid();
const gid = process.getegid();
assert.ok(uid > 0 && gid > 0, "Run from a non-root host account");
const oldUid = uid === 41001 ? 41002 : 41001;
const oldGid = gid === 42001 ? 42002 : 42001;
const otherUid = uid === 43001 ? 43002 : 43001;
const otherGid = gid === 44001 ? 44002 : 44001;
const root = mkdtempSync(join(tmpdir(), "ccc-codex-state-fixture-"));
chmodSync(root, 0o700);
const report = [];

function helper(script, args = [], extra = [], user = "0:0") {
    const control = mkdtempSync(join(tmpdir(), "ccc-codex-helper-"));
    const cidfile = join(control, "cid");
    try {
        return spawnSync("docker", ["run", "--rm", "--cidfile", cidfile, "--network", "none", "--read-only", "--user", user,
            "--mount", `type=bind,source=${root},target=/fixture`, ...extra,
            "--entrypoint", "python3", image, "-c", script, ...args.map(String)],
        { encoding: "utf-8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    } finally {
        try {
            const cid = readFileSync(cidfile, "utf-8").trim();
            if (/^[a-f0-9]{64}$/.test(cid)) spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore", timeout: 10_000 });
        } catch { /* Creation failed or --rm already completed. */ }
        rmSync(control, { recursive: true, force: true });
    }
}
function checked(result) {
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}
const prepareScript = String.raw`
import os, sys
name, uid, gid, old_uid, old_gid, other_uid, other_gid = sys.argv[1:]
uid, gid, old_uid, old_gid, other_uid, other_gid = map(int, (uid, gid, old_uid, old_gid, other_uid, other_gid))
root = '/fixture/' + name
os.mkdir(root, 0o700)
os.chown(root, uid, gid)
for filename, owner, group in [('old',old_uid,old_gid),('owner-only',old_uid,other_gid),('group-only',other_uid,old_gid),('unrelated',other_uid,other_gid)]:
    path = root + '/' + filename
    with open(path, 'w') as f: f.write(name + ':' + filename)
    os.chmod(path, 0o640)
    os.chown(path, owner, group)
os.mkdir(root + '/nested', 0o700)
os.chown(root + '/nested', old_uid, old_gid)
with open('/fixture/outside-' + name, 'w') as f: f.write('outside-' + name)
os.chmod('/fixture/outside-' + name, 0o600)
os.chown('/fixture/outside-' + name, old_uid, old_gid)
os.symlink('../outside-' + name, root + '/link')
os.lchown(root + '/link', old_uid, old_gid)
if name == 'hardlink': os.link(root + '/old', root + '/second-link')
if name == 'unsafe-mode': os.chmod(root, 0o777)
`;
const snapshotScript = String.raw`
import hashlib, json, os, stat, sys
root = '/fixture/' + sys.argv[1]
result = {}
def visit(path, key):
    s = os.lstat(path)
    entry = {'dev':s.st_dev, 'ino':s.st_ino, 'mode':s.st_mode, 'uid':s.st_uid, 'gid':s.st_gid, 'nlink':s.st_nlink}
    if stat.S_ISREG(s.st_mode):
        with open(path, 'rb') as f: entry['sha256'] = hashlib.sha256(f.read()).hexdigest()
    if stat.S_ISLNK(s.st_mode): entry['target'] = os.readlink(path)
    result[key] = entry
    if stat.S_ISDIR(s.st_mode):
        for child in sorted(os.listdir(path)): visit(path + '/' + child, key + '/' + child)
visit(root, '.')
visit('/fixture/outside-' + sys.argv[1], 'outside')
print(json.dumps(result, sort_keys=True))
`;
function snapshot(name) { return JSON.parse(checked(helper(snapshotScript, [name]))); }

try {
    for (const name of ["valid", "hardlink", "nested-mount", "unsafe-mode", "wrong-root-identity"]) {
        checked(helper(prepareScript, [name, uid, gid, oldUid, oldGid, otherUid, otherGid]));
        const before = snapshot(name);
        const rootStat = statSync(join(root, name), { bigint: true });
        const inode = name === "wrong-root-identity" ? rootStat.ino + 1n : rootStat.ino;
        const result = helper(codexStateMigrationScript,
            [`/fixture/${name}`, oldUid, oldGid, uid, gid, rootStat.dev, inode],
            name === "nested-mount" ? ["--tmpfs", `/fixture/${name}/nested:rw,noexec,nosuid,nodev,mode=0700`] : []);
        const after = snapshot(name);
        if (name === "valid") {
            checked(result);
            const expected = structuredClone(before);
            for (const [key, entry] of Object.entries(expected)) {
                if (key === "outside" || key === ".") continue;
                if (entry.uid === oldUid) entry.uid = uid;
                if (entry.gid === oldGid) entry.gid = gid;
            }
            assert.deepEqual(after, expected, "Migration must preserve contents, inode, modes, unrelated IDs and symlink targets");
            const access = helper("p='/fixture/valid/old'; f=open(p,'r+'); v=f.read(); f.seek(0); f.write(v); f.close()", [], [], `${uid}:${gid}`);
            checked(access);
            assert.deepEqual(snapshot(name), expected);
        } else {
            assert.notEqual(result.status, 0, "Unsafe fixture unexpectedly migrated");
            assert.equal(result.error, undefined, result.error?.message);
            const message = { hardlink: "Multiply linked", "nested-mount": "Nested mount", "unsafe-mode": "not a trusted host-owned", "wrong-root-identity": "root identity changed" }[name];
            assert.ok(result.stderr.includes(message), result.stderr);
            assert.deepEqual(after, before, "Unsafe preflight must not change any fixture metadata/content");
        }
        report.push({ case: name, status: "PASS" });
    }
    console.log(JSON.stringify({ image, scriptSha256: createHash("sha256").update(codexStateMigrationScript).digest("hex"),
        scope: "compiled migration primitive + actual target-user access; startup wrapper/profile/active-user guards require separate tests", checks: report }, null, 2));
} finally {
    checked(helper("import os, shutil\nfor name in os.listdir('/fixture'):\n p='/fixture/'+name\n if os.path.isdir(p) and not os.path.islink(p): shutil.rmtree(p)\n else: os.unlink(p)"));
    rmSync(root, { recursive: true, force: true });
}
