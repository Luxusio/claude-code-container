import { describe, it, expect, vi, beforeEach } from "vitest";

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
    return { ...actual, existsSync: vi.fn(), readdirSync: vi.fn(), readFileSync: vi.fn(), unlinkSync: vi.fn() };
});

const { existsSync, readdirSync, readFileSync } = await import("fs");
const { getActiveSessionsForContainer } = await import("../session.js");

describe("the lock filter's use of a batched observation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        observeCalls.length = 0;
        livenessCalls.length = 0;
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readdirSync).mockReturnValue([
            "proj-abc--one.lock",
            "proj-abc--two.lock",
            "proj-abc--three.lock",
        ] as never);
        let call = 0;
        vi.mocked(readFileSync).mockImplementation((() => {
            call += 1;
            return JSON.stringify({ version: 2, pid: 4240 + call, startToken: `windows:${call}` });
        }) as never);
    });

    it("gathers every owner once, then asks each question with what it gathered", () => {
        expect(getActiveSessionsForContainer("proj-abc")).toHaveLength(3);

        expect(observeCalls, "one gathering for the whole directory, not one per lock")
            .toHaveLength(1);
        expect(observeCalls[0], "and it carries every owner it found").toEqual([4241, 4242, 4243]);
        expect(livenessCalls, "every lock is still judged").toHaveLength(3);
        expect(
            livenessCalls.every(({ hadMap }) => hadMap),
            "each judgement receives the observations — without this the saving is inert",
        ).toBe(true);
    });

    it("reads each lock once, not once to collect owners and again to judge them", () => {
        getActiveSessionsForContainer("proj-abc");

        // Three locks, three reads. The first version of this batching read them twice, which
        // broke two existing tests whose readFileSync is mocked per call.
        expect(vi.mocked(readFileSync).mock.calls).toHaveLength(3);
    });
});
