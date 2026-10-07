import { describe, expect, it } from "vitest";
import { createContainerExecReadiness } from "../../application/container-exec-readiness.js";
import { canExecContainer } from "../../docker.js";
import type { ContainerExecReadinessPorts } from "../../ports/container-exec-readiness.js";

// Compile-only checks stay uncalled so rejected capabilities never execute.
function compileContracts(ports: ContainerExecReadinessPorts) {
    const app = createContainerExecReadiness(ports);
    const result: boolean = app.run("selected-container");
    const time: number = ports.now();
    const ready: boolean = ports.canExec("selected-container", 5000);
    const slept: undefined = ports.sleep(75);
    createContainerExecReadiness({ ...ports, canExec: canExecContainer });
    void [result, time, ready, slept];

    // @ts-expect-error All readiness capabilities are required.
    createContainerExecReadiness();
    // @ts-expect-error Undefined cannot supply the required ports.
    createContainerExecReadiness(undefined);
    // @ts-expect-error The clock cannot be omitted.
    createContainerExecReadiness({ canExec: ports.canExec, sleep: ports.sleep });
    // @ts-expect-error The exec probe cannot be omitted.
    createContainerExecReadiness({ now: ports.now, sleep: ports.sleep });
    // @ts-expect-error The sleep effect cannot be omitted.
    createContainerExecReadiness({ now: ports.now, canExec: ports.canExec });
    // @ts-expect-error The clock must be callable.
    createContainerExecReadiness({ ...ports, now: 0 });
    // @ts-expect-error The exec probe must be callable.
    createContainerExecReadiness({ ...ports, canExec: true });
    // @ts-expect-error The sleep effect must be callable.
    createContainerExecReadiness({ ...ports, sleep: undefined });
    // @ts-expect-error Clock observations must be synchronous.
    createContainerExecReadiness({ ...ports, now: async () => 0 });
    // @ts-expect-error Exec observations must be synchronous.
    createContainerExecReadiness({ ...ports, canExec: async () => true });
    // @ts-expect-error Sleep must complete synchronously.
    createContainerExecReadiness({ ...ports, sleep: async () => undefined });
    // @ts-expect-error The clock must return a number.
    createContainerExecReadiness({ ...ports, now: () => "0" });
    // @ts-expect-error The exec probe must return a boolean.
    createContainerExecReadiness({ ...ports, canExec: () => 1 });
    // @ts-expect-error Permissive void does not prove synchronous sleep.
    createContainerExecReadiness({ ...ports, sleep: (): void => {} });
    // @ts-expect-error Sleep cannot return an effect result.
    createContainerExecReadiness({ ...ports, sleep: () => "timed-out" });
    // @ts-expect-error Run requires a target.
    app.run();
    // @ts-expect-error Run requires a string target.
    app.run(123);
    // @ts-expect-error The exec probe requires a string target.
    ports.canExec(123, 5000);
    // @ts-expect-error The exec timeout requires a number.
    ports.canExec("selected-container", "5000");
    // @ts-expect-error The sleep duration requires a number.
    ports.sleep("75");
    // @ts-expect-error Run returns a synchronous boolean.
    const asynchronousResult: Promise<boolean> = app.run("selected-container");
    // @ts-expect-error Run returns a boolean, not a number.
    const numericResult: number = app.run("selected-container");
    void [asynchronousResult, numericResult];
}
void compileContracts;

describe("container exec readiness compile contracts", () => {
    it("returns a boolean through the strict synchronous application API", () => {
        const app = createContainerExecReadiness({
            now: () => 0,
            canExec: () => true,
            sleep: () => undefined,
        });
        expect(app.run("selected-container")).toBe(true);
    });
});
