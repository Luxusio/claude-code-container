import { describe, expect, it } from "vitest";
import { createLeaseDatePolicy, createLeaseDirectoryScan, createLeaseList, createPhysicalComposite } from "@ccc/device-lab/device-lab/application/broker-observation-leases.js";
import type { LeaseDatePorts, LeaseDirectoryPorts } from "@ccc/device-lab/device-lab/ports/broker-observation.js";
import type { LeaseDirectoryEntry, LeaseDirectoryInspection } from "@ccc/device-lab/device-lab/domain/broker-observation.js";

function scanFixture(names: string[], limit = 4) {
    const trace: string[] = []; let index = 0;
    type Ports = LeaseDirectoryPorts<string, string, LeaseDirectoryEntry, LeaseDirectoryInspection>;
    const ports: { -readonly [Key in keyof Ports]: Ports[Key] } = {
        root: () => { trace.push("root"); return "captured-root"; },
        inspect: () => { trace.push("inspect"); return { ok: true, exists: true }; },
        assertRoot: root => { expect(root).toBe("captured-root"); trace.push("assert"); },
        open: root => { expect(root).toBe("captured-root"); trace.push("open"); return {
            readSync() { trace.push("next"); const name = names[index++]; return name === undefined ? null : { name, isFile() { return true; } }; },
            closeSync() { trace.push("close"); },
        }; },
        entryFile: (root, entry) => { trace.push("file:" + entry.name); return root + "/" + entry.name; },
        errorCode: () => { trace.push("classify"); return null; },
    };
    return { ports, trace, scan: () => createLeaseDirectoryScan(ports, limit)("android-device") };
}

describe("broker bounded lease directory policy", () => {
    it("closes the captured directory before returning canonical entries", () => {
        const f = scanFixture(["GOOD.json", "%ZZ.json", "%47OOD.json", "other.noise"]);
        expect(f.scan()).toEqual({ kind: "entries", entries: [{ file: "captured-root/GOOD.json", hardwareId: "GOOD" }] });
        expect(f.trace).toEqual(["root", "inspect", "assert", "open", "next", "file:GOOD.json", "next", "next", "next", "next", "close"]);
    });
    it("counts irrelevant entries and lets close failure override the cap", () => {
        const f = scanFixture(["a.noise", "b.noise"], 1);
        expect(f.scan()).toEqual({ kind: "entry-cap", backend: "android-device", limit: 1 });
        f.ports.open = () => ({ readSync: () => ({ name: "noise", isFile: () => false }), closeSync: () => { throw {}; } });
        expect(f.scan()).toEqual({ kind: "directory-failed", backend: "android-device", detail: "physical-lease-directory-read-failed" });
    });
    it("keeps root and inspection exceptions outside the directory catch", () => {
        for (const stage of ["root", "inspect"] as const) {
            const f = scanFixture([]); const sentinel = {}; f.ports[stage] = () => { throw sentinel; };
            try { f.scan(); throw new Error("unexpected success"); } catch (error) { expect(error).toBe(sentinel); }
            expect(f.trace).not.toContain("classify");
        }
    });
});

describe("broker lease date and active-owner decisions", () => {
    it("looks up native date parsing before each producer and repeats valid expiry getters", () => {
        const trace: string[] = [];
        const ports: LeaseDatePorts = { epoch: () => "epoch", expiryFrom: () => "derived",
            get parse() { trace.push("parse-callee"); return (produce: () => string) => { produce(); return 100; }; },
        };
        const dates = createLeaseDatePolicy(ports, 10);
        const lease = { get expiresAt() { trace.push("expiresAt"); return "valid"; } };
        expect(dates.expired(lease, 100)).toBe(true);
        expect(trace).toEqual(["parse-callee", "expiresAt", "parse-callee", "expiresAt", "expiresAt"]);
    });
    it("uses epoch/default TTL only when the existing values cannot supply them", () => {
        const dates = createLeaseDatePolicy({ parse: () => NaN, epoch: () => "epoch", expiryFrom: (at, ttl) => at + ":" + ttl }, 10);
        expect(dates.expiresAt({ expiresAt: "invalid", updatedAt: "invalid", ttlMs: -1 })).toBe("epoch:10");
        let reads = 0; expect(dates.ttlMs({ get ttlMs() { reads++; return 5; } })).toBe(5); expect(reads).toBe(4);
    });
    it("reads each lease after scanning closes, filters owner before time and recomputes decorations", () => {
        const trace: string[] = [];
        const list = createLeaseList(() => { trace.push("scan-closed"); return { ok: true as const, entries: [{ file: "foreign", hardwareId: "f" }, { file: "owned", hardwareId: "o" }] }; }, {
            read: file => { trace.push("read:" + file); return { ownerId: file === "owned" ? "owner" : "foreign" }; },
            expired: () => { trace.push("time"); return false; },
            expiresAt: () => { trace.push("expiry"); return "valid"; }, ttlMs: () => { trace.push("ttl"); return 5; },
        });
        expect(list("owner", "android-device")).toEqual({ ok: true, leases: [{ ownerId: "owner", expiresAt: "valid", ttlMs: 5 }] });
        expect(trace).toEqual(["scan-closed", "read:foreign", "read:owned", "time", "expiry", "ttl"]);
    });
    it("does not recategorize a per-lease read failure as directory failure", () => {
        const sentinel = {}; const list = createLeaseList(() => ({ ok: true as const, entries: [{ file: "f", hardwareId: "id" }] }), {
            read: () => { throw sentinel; }, expired: () => false, expiresAt: () => "", ttlMs: () => 1,
        });
        try { list("owner", "android-device"); throw new Error("unexpected success"); } catch (error) { expect(error).toBe(sentinel); }
    });
    it.each(["android-device", "ios-device"])("observes leases, optional host query, then definitions: %s", backend => {
        const trace: string[] = []; const observe = createPhysicalComposite({
            leases: () => { trace.push("leases"); return { ok: true as const, leases: [] }; },
            androidHost: () => { trace.push("adb"); return { devices: [] }; },
            devices: () => { trace.push("devices"); return []; },
        });
        expect(observe("owner", backend, {}).kind).toBe("observed");
        expect(trace).toEqual(backend === "android-device" ? ["leases", "adb", "devices"] : ["leases", "devices"]);
    });
});
