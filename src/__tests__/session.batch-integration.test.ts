import { basename } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The call site, not the helper. Everything else about this batching is pinned by tests that
// call `sessionLockLiveness` directly — but deleting the map from `filterLiveSessionLocks`
// passed all 114 tests in session.test.ts, because off Windows `observeProcessStarts` returns
// an empty map and the two code paths are indistinguishable by result. So the whole saving
// could be reverted in silence. This asserts the wiring instead of the outcome: every liveness
// question is asked WITH the observations, and the observations were gathered once.
const observeCalls: number[][] = [];
const livenessCalls: Array<{ content: string; hadMap: boolean }> = [];

vi.mock("../session-lock-liveness.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../session-lock-liveness.js")>();
    return {
        ...actual,
        observeProcessStarts: vi.fn((pids: readonly number[]) => {
            observeCalls.push([...pids]);
            return new Map();
        }),
        sessionLockLiveness: vi.fn((content: string, observed?: ReadonlyMap<number, unknown>) => {
            livenessCalls.push({ content, hadMap: observed !== undefined });
            return "active" as const;
        }),
    };
});

vi.mock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    return { ...actual, existsSync: vi.fn(), readdirSync: vi.fn(), readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
            // Package metadata is real; each test still controls its simulated filesystem.
            const [file] = args;
            return file instanceof URL && file.href === new URL('../../packages/device-lab/package.json', import.meta.url).href
                ? actual.readFileSync(...args) : undefined;
        }), unlinkSync: vi.fn() };
});

vi.mock("../adapters/session-ownership.js", async importOriginal => {
    const actual = await importOriginal<typeof import("../adapters/session-ownership.js")>();
    return { ...actual, captureNativeSessionOwnership: vi.fn(), removeCapturedNativeSessionOwnership: vi.fn() };
});

const { existsSync, readdirSync, unlinkSync } = await import("fs");
const { captureNativeSessionOwnership, removeCapturedNativeSessionOwnership } = await import("../adapters/session-ownership.js");
const { getActiveSessionsForContainer } = await import("../session.js");
const claimNames = ["proj-abc--one.lock", "proj-abc--two.lock", "proj-abc--three.lock"];

describe("the lock filter's use of a batched observation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        observeCalls.length = 0;
        livenessCalls.length = 0;
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readdirSync).mockReturnValue(claimNames as never);
        vi.mocked(captureNativeSessionOwnership).mockImplementation(path => {
            const index = claimNames.indexOf(basename(path));
            if (index < 0) throw new Error("Unexpected claim capture in batch fixture.");
            const ownerPid = 4241 + index;
            const content = JSON.stringify({ version: 2, pid: ownerPid, startToken: `windows:${index + 1}` });
            return { path, bytes: Buffer.from(content).toString("base64"), ownerPid,
                device: "1", inode: String(index + 1), birthtime: String(index + 1) };
        });
    });
    afterEach(() => {
        expect(removeCapturedNativeSessionOwnership).not.toHaveBeenCalled();
        expect(unlinkSync).not.toHaveBeenCalled();
    });

    it("gathers every owner once, then asks each question with what it gathered", () => {
        expect(getActiveSessionsForContainer("proj-abc")).toHaveLength(3);

        expect(observeCalls, "one gathering for the whole directory, not one per lock")
            .toHaveLength(1);
        expect(observeCalls[0], "and it carries every owner it found").toEqual([4241, 4242, 4243]);
        expect(livenessCalls, "every lock is still judged").toHaveLength(3);
        expect(livenessCalls.map(({ content }) => JSON.parse(content).pid)).toEqual([4241, 4242, 4243]);
        expect(
            livenessCalls.every(({ hadMap }) => hadMap),
            "each judgement receives the observations — without this the saving is inert",
        ).toBe(true);
    });

    it("reads each lock once, not once to collect owners and again to judge them", () => {
        getActiveSessionsForContainer("proj-abc");

        // The native store captures each receipt and its content together. Owner gathering
        // and classification must share that capture rather than reopen each file.
        expect(captureNativeSessionOwnership).toHaveBeenCalledTimes(3);
        expect(vi.mocked(captureNativeSessionOwnership).mock.calls.map(([path]) => basename(path))).toEqual(claimNames);
    });
});
