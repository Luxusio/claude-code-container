import { spawnSync } from "child_process";
import { readFileSync, readdirSync } from "fs";

function linuxProcessSnapshot(procRoot = "/proc") {
    const entries = [];
    for (const name of readdirSync(procRoot).filter((entry) => /^\d+$/.test(entry))) {
        try {
            const stat = readFileSync(`${procRoot}/${name}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
            const pid = Number(name);
            const ppid = Number(fields[1]);
            const startTicks = fields[19];
            const state = fields[0];
            if (Number.isInteger(pid) && Number.isInteger(ppid) && /^\d+$/.test(startTicks || "")) {
                entries.push({ pid, ppid, token: `linux:${startTicks}`, state });
            }
        } catch {
            // Processes may exit while /proc is sampled.
        }
    }
    return entries;
}

function windowsProcessSnapshot(spawnSyncImpl = spawnSync) {
    const command = [
        "$ErrorActionPreference='Stop'",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress",
    ].join("; ");
    const result = spawnSyncImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`could not inspect Windows process identities: ${result.error?.message || result.stderr || result.stdout || result.status}`);
    let parsed;
    try {
        parsed = JSON.parse(result.stdout || "[]");
    } catch (error) {
        throw new Error(`Windows process identity output was malformed: ${error.message}`);
    }
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
        pid: Number(entry.ProcessId),
        ppid: Number(entry.ParentProcessId),
        token: entry.CreationDate ? `windows:${entry.CreationDate}` : "",
        state: "",
    })).filter((entry) => Number.isInteger(entry.pid) && Number.isInteger(entry.ppid) && entry.token);
}

export function processIdentitySnapshot(options = {}) {
    const platform = options.platform || process.platform;
    if (platform === "linux") return linuxProcessSnapshot(options.procRoot);
    if (platform === "win32") return windowsProcessSnapshot(options.spawnSyncImpl);
    throw new Error(`strong process identity is unavailable on ${platform}; refusing PID-based durability cleanup`);
}

export function processIdentityKey(identity) {
    return `${identity.pid}:${identity.token}`;
}

export function sameProcessIdentity(left, right) {
    return Boolean(left && right && left.pid === right.pid && left.token === right.token);
}

export function identityForPid(pid, snapshot = processIdentitySnapshot()) {
    return snapshot.find((entry) => entry.pid === pid) || null;
}

export function identityIsAlive(identity, snapshot = processIdentitySnapshot()) {
    const current = identityForPid(identity.pid, snapshot);
    return sameProcessIdentity(identity, current) && current.state !== "Z";
}

export function sampleOwnedProcessIdentities(rootIdentity, registry, snapshot = processIdentitySnapshot()) {
    const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]));
    const currentRoot = byPid.get(rootIdentity.pid);
    if (currentRoot && !sameProcessIdentity(rootIdentity, currentRoot)) {
        throw new Error(`process identity changed for root PID ${rootIdentity.pid}; refusing uncertain ownership`);
    }
    if (currentRoot && currentRoot.state !== "Z") registry.set(processIdentityKey(currentRoot), currentRoot);

    const activeOwnedPids = new Set();
    for (const identity of registry.values()) {
        const current = byPid.get(identity.pid);
        if (sameProcessIdentity(identity, current) && current.state !== "Z") activeOwnedPids.add(identity.pid);
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const entry of snapshot) {
            if (entry.state === "Z" || activeOwnedPids.has(entry.pid) || !activeOwnedPids.has(entry.ppid)) continue;
            registry.set(processIdentityKey(entry), entry);
            activeOwnedPids.add(entry.pid);
            changed = true;
        }
    }
    return registry;
}

export function liveOwnedProcessIdentities(registry, snapshot = processIdentitySnapshot()) {
    const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]));
    return [...registry.values()].filter((identity) => {
        const current = byPid.get(identity.pid);
        return sameProcessIdentity(identity, current) && current.state !== "Z";
    });
}

export function describeProcessIdentities(identities) {
    return identities.map((identity) => `${identity.pid}@${identity.token}`).join(",");
}
