// src/__tests__/registry.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { fork } from "child_process";

// Helper to set CCC_REGISTRY_PATH per test
let tmpDir: string;

beforeEach(() => {
    const rand = Math.random().toString(36).slice(2, 8);
    tmpDir = path.join(os.tmpdir(), `ccc-registry-${rand}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.CCC_REGISTRY_PATH = path.join(tmpDir, "registry.json");
    // Reset module-level parse failure warning flag between tests
    vi.resetModules();
});

afterEach(() => {
    delete process.env.CCC_REGISTRY_PATH;
    delete process.env.CCC_REGISTRY_LOCK_TIMEOUT_MS;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Dynamically import after setting env so module picks up correct path
async function getRegistry() {
    const mod = await import("../registry.js");
    return mod;
}

// ============================================================
// Test 1 — loadRegistry returns empty when file is missing
// ============================================================
it("loadRegistry returns empty when file is missing", async () => {
    const { loadRegistry } = await getRegistry();
    const reg = loadRegistry();
    expect(reg.schema_version).toBe(1);
    expect(reg.projects).toEqual({});
});

// ============================================================
// Test 2 — loadRegistry tolerates malformed JSON and logs
// ============================================================
it("loadRegistry returns empty when file is malformed JSON and logs", async () => {
    const regPath = process.env.CCC_REGISTRY_PATH!;
    fs.writeFileSync(regPath, "{ not valid json !!!");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadRegistry } = await getRegistry();
    const reg = loadRegistry();

    expect(reg.projects).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
});

// ============================================================
// Test 3 — upsertProject creates source entry with first_seen == last_seen
// ============================================================
it("upsertProject creates source entry with first_seen === last_seen on first write", async () => {
    const { upsertProject, loadRegistry } = await getRegistry();
    await upsertProject({ id: "my-proj-abc123456789", host_path: "/tmp/myproj", kind: "source" });
    const reg = loadRegistry();
    const entry = reg.projects["my-proj-abc123456789"];
    expect(entry).toBeDefined();
    expect(entry.kind).toBe("source");
    expect(entry.host_path).toBe("/tmp/myproj");
    expect(entry.first_seen).toBe(entry.last_seen);
});

// ============================================================
// Test 4 — upsertProject worktree also upserts source stub
// ============================================================
it("upsertProject worktree also upserts source stub with worktrees array containing the worktree id", async () => {
    const { upsertProject, loadRegistry } = await getRegistry();
    const sourceId = "source-proj-aabbcc001122";
    const worktreeId = "worktree-proj-ddeeff334455";

    await upsertProject({
        id: worktreeId,
        host_path: "/tmp/myproj--feature-x",
        kind: "worktree",
        source: sourceId,
        branch: "feature-x",
    });

    const reg = loadRegistry();
    const worktreeEntry = reg.projects[worktreeId];
    const sourceEntry = reg.projects[sourceId];

    expect(worktreeEntry).toBeDefined();
    expect(worktreeEntry.kind).toBe("worktree");
    expect(worktreeEntry.source).toBe(sourceId);
    expect(worktreeEntry.branch).toBe("feature-x");

    expect(sourceEntry).toBeDefined();
    expect(sourceEntry.kind).toBe("source");
    expect(sourceEntry.worktrees).toContain(worktreeId);
});

// ============================================================
// Test 5 — Idempotency
// ============================================================
it("upsertProject is idempotent: first_seen preserved, last_seen advances, no duplicate worktree ids", async () => {
    const { upsertProject, loadRegistry } = await getRegistry();
    const sourceId = "source-idem-aabbcc001122";
    const worktreeId = "wt-idem-ddeeff334455";

    // First write
    await upsertProject({
        id: worktreeId,
        host_path: "/tmp/idem--feat",
        kind: "worktree",
        source: sourceId,
        branch: "feat",
    });

    const reg1 = loadRegistry();
    const firstSeen1 = reg1.projects[worktreeId].first_seen;
    const lastSeen1 = reg1.projects[worktreeId].last_seen;

    // Small delay to ensure timestamp can advance
    await new Promise((r) => setTimeout(r, 10));

    // Second write (idempotent)
    await upsertProject({
        id: worktreeId,
        host_path: "/tmp/idem--feat",
        kind: "worktree",
        source: sourceId,
        branch: "feat",
    });

    const reg2 = loadRegistry();
    const entry2 = reg2.projects[worktreeId];
    const source2 = reg2.projects[sourceId];

    // first_seen preserved
    expect(entry2.first_seen).toBe(firstSeen1);
    // last_seen advanced or equal (can be equal if sub-ms)
    expect(entry2.last_seen >= lastSeen1).toBe(true);
    // No duplicate worktrees in source
    const wt = source2.worktrees.filter((w) => w === worktreeId);
    expect(wt.length).toBe(1);
});

// ============================================================
// Test 6 — Stale lock reclaim
// ============================================================
it("upsertProject tolerates a pre-existing stale lock file and reclaims it", async () => {
    const { upsertProject, loadRegistry, getRegistryLockPath } = await getRegistry();
    const lockPath = getRegistryLockPath();

    // Create a stale lock: old mtime + dead pid (use pid=1 and old ts)
    const staleContent = JSON.stringify({ pid: 99999999, ts: Date.now() - 60_000 });
    fs.writeFileSync(lockPath, staleContent);

    // Touch mtime to be old (> 30s ago) — write with old-looking ts should suffice
    // since our logic checks the ts field, not file mtime. Alternatively set mtime:
    const thirtySecondsAgo = new Date(Date.now() - 35_000);
    fs.utimesSync(lockPath, thirtySecondsAgo, thirtySecondsAgo);

    await upsertProject({ id: "stale-test-aabbcc001122", host_path: "/tmp/stale", kind: "source" });
    const reg = loadRegistry();
    expect(reg.projects["stale-test-aabbcc001122"]).toBeDefined();
});

// ============================================================
// Test 7 — Concurrent 5x50 child_process.fork upserts
// ============================================================
// Worker script uses the SAME atomic lock pattern as src/registry.ts:
// writeFile→link for lock creation (atomic: file is either absent
// or fully written), plus conservative reclaim (never unlink on
// parse failure). Inlined here because child_process.fork with plain
// node cannot import .ts files and the production registry.ts uses
// TS syntax. This test is the guard that the *algorithm* works; a
// separate test (index-registry-call.test.ts) proves the production
// module calls this algorithm.
it("atomic replace survives concurrent upserts (5x50 workers, all 250 ids present)", async () => {
    const workerPath = path.join(tmpDir, "worker.mjs");
    const workerScript = `
import * as fs from "fs";

const registryPath = process.env.CCC_REGISTRY_PATH;
const lockPath = registryPath + ".lock";
const workerIdx = parseInt(process.argv[2], 10);
const COUNT = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Atomic lock acquire via writeFile + link.
// Returns true on success, false on EEXIST.
async function tryAcquireLock() {
    const content = JSON.stringify({ pid: process.pid, ts: Date.now() });
    const tmp = lockPath + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 10);
    try {
        await fs.promises.writeFile(tmp, content, { flag: "w" });
        try {
            await fs.promises.link(tmp, lockPath);
            return true;
        } catch (err) {
            if (err.code === "EEXIST") return false;
            throw err;
        }
    } finally {
        await fs.promises.unlink(tmp).catch(() => {});
    }
}

// Conservative reclaim: only unlink on POSITIVE evidence of staleness
// (age > 30s OR dead pid). Empty/unparseable/missing → not stale.
async function reclaimStaleLock() {
    let raw;
    try {
        raw = await fs.promises.readFile(lockPath, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") return true;
        return false;
    }
    let data;
    try { data = JSON.parse(raw); } catch { return false; }
    const now = Date.now();
    const ts = typeof data.ts === "number" ? data.ts : 0;
    const pid = typeof data.pid === "number" ? data.pid : 0;
    const staleByAge = ts > 0 && (now - ts) > 30_000;
    let staleByPid = false;
    if (!staleByAge && pid > 0) {
        try { process.kill(pid, 0); } catch(e) { if (e.code === "ESRCH") staleByPid = true; }
    }
    if (staleByAge || staleByPid) {
        try { await fs.promises.unlink(lockPath); } catch {}
        return true;
    }
    return false;
}

async function upsertOne(id) {
    const timeoutMs = 15_000;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let acquired = false;

    while (!acquired) {
        let gotIt = false;
        try {
            gotIt = await tryAcquireLock();
        } catch(err) {
            return;
        }
        if (gotIt) { acquired = true; break; }
        try { const r = await reclaimStaleLock(); if (r) continue; } catch {}
        if (Date.now() >= deadline) return;
        const backoff = Math.min(10 * Math.pow(2, attempt), 200);
        const jitter = Math.random() * 30;
        await sleep(backoff + jitter);
        attempt++;
    }

    try {
        let reg = { schema_version: 1, updated_at: new Date().toISOString(), projects: {} };
        try {
            const raw = fs.readFileSync(registryPath, "utf8").trim();
            if (raw) { const p = JSON.parse(raw); if (p && p.projects) reg = p; }
        } catch {}

        const now = new Date().toISOString();
        const existing = reg.projects[id];
        reg.projects[id] = {
            id,
            host_path: "/tmp/" + id,
            kind: "source",
            source: null,
            branch: null,
            worktrees: existing?.worktrees ?? [],
            first_seen: existing?.first_seen ?? now,
            last_seen: now,
        };
        reg.updated_at = now;

        const rand = Math.random().toString(36).slice(2, 10);
        const tmpPath = registryPath + ".tmp." + process.pid + "." + rand;
        const content = JSON.stringify(reg, null, 2);
        const tmpHandle = await fs.promises.open(tmpPath, "w");
        try {
            await tmpHandle.write(content);
            await tmpHandle.datasync();
        } finally {
            await tmpHandle.close();
        }
        await fs.promises.rename(tmpPath, registryPath);
    } catch(err) {
        console.error("write err", err.message);
    } finally {
        try { await fs.promises.unlink(lockPath); } catch {}
    }
}

async function main() {
    for (let i = 0; i < COUNT; i++) {
        const id = "w" + workerIdx + "-proj-" + String(i).padStart(3, "0") + "-aabbcc001122";
        await upsertOne(id);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
`;
    fs.writeFileSync(workerPath, workerScript, "utf8");

    const registryPath = process.env.CCC_REGISTRY_PATH!;
    const NUM_WORKERS = 5;
    const ITEMS_PER_WORKER = 50;

    await new Promise<void>((resolve, reject) => {
        let done = 0;
        let failed = false;
        for (let w = 0; w < NUM_WORKERS; w++) {
            const child = fork(workerPath, [String(w)], {
                execArgv: [],
                env: { ...process.env, CCC_REGISTRY_PATH: registryPath },
            });
            child.on("exit", (code) => {
                if (code !== 0 && !failed) {
                    failed = true;
                    reject(new Error(`Worker ${w} exited with code ${code}`));
                }
                done++;
                if (done === NUM_WORKERS && !failed) resolve();
            });
            child.on("error", (err) => {
                if (!failed) { failed = true; reject(err); }
            });
        }
    });

    // Verify all 250 entries are present
    const raw = fs.readFileSync(registryPath, "utf8");
    const reg = JSON.parse(raw);
    expect(reg).toHaveProperty("projects");
    const ids = Object.keys(reg.projects);
    expect(ids.length).toBe(NUM_WORKERS * ITEMS_PER_WORKER);
    for (let w = 0; w < NUM_WORKERS; w++) {
        for (let i = 0; i < ITEMS_PER_WORKER; i++) {
            const id = `w${w}-proj-${String(i).padStart(3, "0")}-aabbcc001122`;
            expect(reg.projects[id]).toBeDefined();
        }
    }
}, 60_000);

// ============================================================
// Test 8 — Lock timeout does not throw
// ============================================================
it("lock timeout path does not throw and logs a warning", async () => {
    process.env.CCC_REGISTRY_LOCK_TIMEOUT_MS = "200";

    const { upsertProject, getRegistryLockPath } = await getRegistry();
    const lockPath = getRegistryLockPath();

    // Create a fresh lock file with OUR OWN pid so it looks like a live holder
    const freshContent = JSON.stringify({ pid: process.pid, ts: Date.now() });
    fs.writeFileSync(lockPath, freshContent);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Should resolve without throwing
    await expect(
        upsertProject({ id: "timeout-test-aabbcc001122", host_path: "/tmp/to", kind: "source" })
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    warnSpy.mockRestore();

    // Clean up lock
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
});
