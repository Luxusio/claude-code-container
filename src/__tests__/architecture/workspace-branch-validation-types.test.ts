import { describe, expect, it } from "vitest";
import { createWorkspaceBranchValidation } from "../../application/workspace-branch-validation.js";
import type { WorkspaceBranchValidationPorts } from "../../ports/workspace-branch-validation.js";
import { validateBranchName } from "../../worktree.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

function compileContracts(ports: WorkspaceBranchValidationPorts) {
    const validate = createWorkspaceBranchValidation(ports);
    const exact: [
        Equal<Parameters<typeof createWorkspaceBranchValidation>, [ports: WorkspaceBranchValidationPorts]>,
        Equal<Parameters<typeof validate>, [branch: string]>,
        Equal<ReturnType<typeof validate>, string>,
        Equal<Parameters<typeof ports.utf8ByteLength>, [value: string]>,
        Equal<ReturnType<typeof ports.utf8ByteLength>, number>,
        Equal<Parameters<typeof validateBranchName>, [branch: string]>,
        Equal<ReturnType<typeof validateBranchName>, string>,
    ] = [true, true, true, true, true, true, true];
    void exact;

    // @ts-expect-error Ports must be explicitly supplied.
    createWorkspaceBranchValidation();
    // @ts-expect-error Undefined cannot supply required ports.
    createWorkspaceBranchValidation(undefined);
    // @ts-expect-error Null cannot supply required ports.
    createWorkspaceBranchValidation(null);
    // @ts-expect-error The byte length capability is required.
    createWorkspaceBranchValidation({});
    // @ts-expect-error The byte length capability must be callable.
    createWorkspaceBranchValidation({ utf8ByteLength: 1 });
    // @ts-expect-error Byte observation must return a synchronous number.
    createWorkspaceBranchValidation({ utf8ByteLength: async () => 1 });
    // @ts-expect-error Byte observation cannot return a string.
    createWorkspaceBranchValidation({ utf8ByteLength: () => "1" });
    // @ts-expect-error Byte observation cannot return void.
    createWorkspaceBranchValidation({ utf8ByteLength: () => {} });
    // @ts-expect-error Byte observation must accept a string.
    createWorkspaceBranchValidation({ utf8ByteLength: (_value: number) => 1 });
    // @ts-expect-error The byte capability is readonly.
    ports.utf8ByteLength = () => 0;
    // @ts-expect-error Validation requires a branch argument.
    validate();
    // @ts-expect-error Validation accepts a string.
    validate(1);
    // @ts-expect-error Validation excludes boxed strings.
    validate(new String("feature"));
    // @ts-expect-error Byte observation requires a value.
    ports.utf8ByteLength();
    // @ts-expect-error Byte observation accepts a string.
    ports.utf8ByteLength(1);
    // @ts-expect-error The facade still requires a branch.
    validateBranchName();
    // @ts-expect-error The facade still accepts a string.
    validateBranchName(1);
    // @ts-expect-error The facade remains synchronous.
    const asynchronous: Promise<string> = validateBranchName("feature");
    void asynchronous;
}
void compileContracts;

describe("workspace branch validation compile contracts", () => {
    it("exposes a synchronous validator callable", () => {
        const validate = createWorkspaceBranchValidation({ utf8ByteLength: () => 7 });
        expect(typeof validate).toBe("function");
        expect(validate("feature")).toBe("feature");
    });
});
