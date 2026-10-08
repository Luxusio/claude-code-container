import { expectTypeOf, it } from "vitest";
import { createDoctor } from "../../application/doctor.js";
import { runDoctor } from "../../doctor.js";
import type { DoctorPorts } from "../../ports/doctor.js";

it("retains required synchronous contracts", () => {
    expectTypeOf(runDoctor).toEqualTypeOf<(projectPath: string) => boolean>();
    expectTypeOf(createDoctor).returns.toEqualTypeOf<(projectPath: string) => boolean>();
    expectTypeOf<DoctorPorts["capturePublication"]>().returns.toEqualTypeOf<(text: string) => undefined>();
});

// Compiler-negative fixtures are not executed and introduce no ambient effects.
if (false) {
    // @ts-expect-error all semantic observations are required
    createDoctor({});
    const asyncPublication = () => async (_text: string) => undefined;
    // @ts-expect-error publication must reject Promise-returning effects
    const publication: DoctorPorts["capturePublication"] = asyncPublication;
    // @ts-expect-error capture itself must stay synchronous
    const capture: DoctorPorts["capturePublication"] = async () => (_text: string) => undefined;
    void publication;
    void capture;
}
