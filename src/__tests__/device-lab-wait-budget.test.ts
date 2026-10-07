import { afterEach, describe, expect, it, vi } from "vitest";
import { createWaitBudget } from "@ccc/device-lab/providers/wait-budget.mjs";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("shared monotonic observation budget", () => {
    it.each([[undefined, 10000], [0, 1], [-2, 1], [NaN, 10000], [Infinity, 10000], ["10", 10000], [900000, 600000], [2.9, 2]])("normalizes timeout %s to %s", (input, expected) => {
        vi.spyOn(performance, "now").mockReturnValue(100);
        const budget = createWaitBudget(input, 10);
        expect(budget.timeoutMs).toBe(expected);
        expect(budget.remaining()).toBe(expected);
    });
    it("shrinks across requests, rounds fractional allowances up, and never restarts after expiry", () => {
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const budget = createWaitBudget(200000, 500);
        expect(budget.requestTimeout()).toBe(120000);
        clock = 199950.5;
        expect(budget.requestTimeout()).toBe(50);
        expect(budget.requestTimeout(20)).toBe(20);
        clock = 200001;
        expect(budget.remaining()).toBe(0);
        expect(budget.requestTimeout()).toBe(0);
    });
    it("finishes a fractional final pause without starting a tiny extra observation", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const schedule = globalThis.setTimeout;
        vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) =>
            schedule(() => {
                // Model Node's integer-millisecond timer scheduling explicitly.
                clock += Math.max(1, Math.trunc(delay));
                callback();
            }, delay)) as typeof setTimeout);
        const budget = createWaitBudget(100, 500);
        clock = 90.5;
        let observations = 1;
        const pending = budget.pause().then(() => {
            if (budget.remaining() > 0) observations++;
        });
        await vi.runAllTimersAsync();
        await pending;
        expect(observations).toBe(1);
        expect(budget.requestTimeout()).toBe(0);
    });
    it.each([[0, 1], [-2, 1], [NaN, 500], [Infinity, 500], ["10", 500], [90000, 60000]])("normalizes interval %s and caps the final sleep", async (input, expected) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const schedule = globalThis.setTimeout;
        const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) =>
            schedule(() => { clock += delay; callback(); }, delay)) as typeof setTimeout);
        const budget = createWaitBudget(100000, input);
        const initial = budget.pause();
        expect(timer.mock.calls[0][1]).toBe(expected);
        await vi.runAllTimersAsync();
        await initial;
        clock = 99999.5;
        const final = budget.pause();
        expect(timer.mock.calls[1][1]).toBe(1);
        await vi.runAllTimersAsync();
        await final;
        clock = 100000;
        await budget.pause();
        expect(timer).toHaveBeenCalledTimes(2);
    });
    it.each([0, 90.5])("rechecks repeated early callbacks against one target from %s", async start => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const budget = createWaitBudget(100, 10);
        clock = start;
        const target = Math.min(100, start + 10);
        const callbacks = [target - 1, target - 0.5, target + 0.25];
        const schedule = globalThis.setTimeout;
        const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) =>
            schedule(() => { clock = callbacks.shift()!; callback(); }, delay)) as typeof setTimeout);
        let finished = false;
        const pending = budget.pause().then(() => { finished = true; });
        await vi.advanceTimersByTimeAsync(10);
        expect(finished).toBe(false);
        expect(timer.mock.calls.map(call => call[1])).toEqual([10, 1]);
        await vi.advanceTimersByTimeAsync(1);
        expect(finished).toBe(false);
        expect(timer.mock.calls.map(call => call[1])).toEqual([10, 1, 1]);
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(finished).toBe(true);
        expect(clock).toBe(target + 0.25);
        expect(budget.remaining()).toBe(Math.max(0, 100 - clock));
        expect(timer).toHaveBeenCalledTimes(3);
    });
    it.each([10, 12])("uses one callback when the monotonic clock reaches %s", async wake => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let clock = 0;
        vi.spyOn(performance, "now").mockImplementation(() => clock);
        const schedule = globalThis.setTimeout;
        const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) =>
            schedule(() => { clock = wake; callback(); }, delay)) as typeof setTimeout);
        const budget = createWaitBudget(100, 10);
        const pending = budget.pause();
        await vi.runAllTimersAsync();
        await pending;
        expect(timer).toHaveBeenCalledTimes(1);
        expect(budget.remaining()).toBe(100 - wake);
        clock = 100;
        await budget.pause();
        expect(timer).toHaveBeenCalledTimes(1);
        expect(budget.requestTimeout()).toBe(0);
    });
});
