import { afterEach, describe, expect, it, vi } from "vitest";

import {
    assertHyperVOperationDeadline,
    HyperVOperationDeadlineError,
    hyperVOperationDeadlineExpired,
    hyperVRemainingTimeout,
} from "@ccc/device-lab/device-lab/broker/hyper-v/deadline.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("Device Lab Hyper-V operation deadlines", () => {
    it("keeps the supplied clock authoritative across forward and backward wall jumps", () => {
        const wall = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
        let elapsed = 100.25;
        const now = () => elapsed;
        const deadlineAt = 1100.25;

        expect(hyperVRemainingTimeout(deadlineAt, 5000, now)).toBe(1000);
        expect(hyperVOperationDeadlineExpired(deadlineAt, now)).toBe(false);
        expect(() => assertHyperVOperationDeadline(deadlineAt, now)).not.toThrow();

        wall.mockReturnValue(1_700_086_400_000);
        elapsed = 350.25;
        expect(hyperVRemainingTimeout(deadlineAt, 5000, now)).toBe(750);
        expect(hyperVOperationDeadlineExpired(deadlineAt, now)).toBe(false);
        expect(() => assertHyperVOperationDeadline(deadlineAt, now)).not.toThrow();

        wall.mockReturnValue(1_699_913_600_000);
        elapsed = 600.25;
        expect(hyperVRemainingTimeout(deadlineAt, 5000, now)).toBe(500);
        expect(hyperVOperationDeadlineExpired(deadlineAt, now)).toBe(false);
        expect(() => assertHyperVOperationDeadline(deadlineAt, now)).not.toThrow();
    });

    it("expires at the supplied deadline even while the wall clock stays earlier", () => {
        vi.spyOn(Date, "now").mockReturnValue(0);
        let elapsed = 1000;
        const now = () => elapsed;

        expect(hyperVRemainingTimeout(1100, 5000, now)).toBe(100);
        elapsed = 1100;
        expect(hyperVOperationDeadlineExpired(1100, now)).toBe(true);
        expect(() => hyperVRemainingTimeout(1100, 5000, now)).toThrowError(HyperVOperationDeadlineError);
        expect(() => assertHyperVOperationDeadline(1100, now)).toThrowError(HyperVOperationDeadlineError);
        expect(() => assertHyperVOperationDeadline(1100, now)).toThrowError(expect.objectContaining({
            code: "hyper-v-operation-deadline-exceeded",
            message: "hyper-v-operation-deadline-exceeded",
        }));
    });

    it("preserves timeout caps, millisecond rounding and unlimited deadlines", () => {
        vi.spyOn(Date, "now").mockReturnValue(100.25);

        expect(hyperVRemainingTimeout(200.75, 25)).toBe(25);
        expect(hyperVRemainingTimeout(102.9, 25)).toBe(2);
        expect(hyperVRemainingTimeout(Infinity, 25)).toBe(25);
        expect(hyperVOperationDeadlineExpired(Infinity)).toBe(false);
        expect(() => assertHyperVOperationDeadline(Infinity)).not.toThrow();

        expect(hyperVOperationDeadlineExpired(100.75)).toBe(false);
        expect(() => assertHyperVOperationDeadline(100.75)).not.toThrow();
        expect(() => hyperVRemainingTimeout(100.75, 25)).toThrowError(HyperVOperationDeadlineError);
    });

    it("continues to interpret omitted clocks as absolute Unix deadlines", () => {
        const startedAt = 1_700_000_000_000;
        const wall = vi.spyOn(Date, "now").mockReturnValue(startedAt);
        const deadlineAt = startedAt + 1000;

        expect(hyperVRemainingTimeout(deadlineAt, 5000)).toBe(1000);
        expect(hyperVOperationDeadlineExpired(deadlineAt)).toBe(false);
        expect(() => assertHyperVOperationDeadline(deadlineAt)).not.toThrow();

        wall.mockReturnValue(deadlineAt);
        expect(hyperVOperationDeadlineExpired(deadlineAt)).toBe(true);
        expect(() => hyperVRemainingTimeout(deadlineAt, 5000)).toThrowError(HyperVOperationDeadlineError);
        expect(() => assertHyperVOperationDeadline(deadlineAt)).toThrowError(HyperVOperationDeadlineError);
    });
});
