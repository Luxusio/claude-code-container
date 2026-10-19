import { describe, expect, it } from "vitest";
import { runtimeBindAdmission } from "../../application/runtime-bind-admission.js";
import type { RuntimeBindAuthorityFacts } from "../../ports/runtime-bind-authority.js";

const complete: RuntimeBindAuthorityFacts = { coverage: "complete", pending: false, authorities: [] };

describe("global bind-user admission", () => {
    it("permits an actually complete, settled authority history only when every bind user is absent", () => {
        expect(runtimeBindAdmission(complete, "absent")).toEqual({ allowed: true, reason: "clear" });
    });

    it("retains legacy history even when the currently selected engine is empty", () => {
        expect(runtimeBindAdmission({ ...complete, coverage: "incomplete" }, "absent"))
            .toEqual({ allowed: false, reason: "coverage-incomplete" });
    });

    it("does not turn unknown history or unknown native inventory into absence", () => {
        expect(runtimeBindAdmission({ ...complete, coverage: "unknown" }, "absent"))
            .toEqual({ allowed: false, reason: "history-unknown" });
        expect(runtimeBindAdmission(complete, "unknown"))
            .toEqual({ allowed: false, reason: "bind-unknown" });
    });

    it("a pending engine-side creation blocks retirement after an empty inventory", () => {
        expect(runtimeBindAdmission({ ...complete, pending: true }, "absent"))
            .toEqual({ allowed: false, reason: "creation-pending" });
    });

    it("a retained bind user blocks mutation regardless of whether its container runs", () => {
        expect(runtimeBindAdmission(complete, "present"))
            .toEqual({ allowed: false, reason: "bind-present" });
    });
});
