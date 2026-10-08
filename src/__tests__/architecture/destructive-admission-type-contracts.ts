import { evaluateDestructivePolicy } from "@ccc/device-lab/providers/domain/destructive-admission.mjs";

// Compiler-only consumers: these functions are never called by a runtime test.
function narrowedResultContracts(name: unknown, args: unknown) {
    const result = evaluateDestructivePolicy(name, args);
    const actions: string[] = result.actions;
    void actions;

    if (result.ok) {
        const ok: true = result.ok;
        // @ts-expect-error Successful admission has no denial error.
        result.error;
        // @ts-expect-error Successful admission has no confirmation field.
        result.confirmationField;
        // @ts-expect-error Successful admission has no denial message.
        result.message;
        if (result.destructive) {
            const destructive: true = result.destructive;
            void destructive;
        } else {
            const destructive: false = result.destructive;
            void destructive;
        }
        void ok;
    } else {
        const ok: false = result.ok;
        const destructive: true = result.destructive;
        const error: "destructive-action-confirmation-required" = result.error;
        const confirmationField: "confirmDestructive" = result.confirmationField;
        const message: string = result.message;
        // @ts-expect-error A denial cannot describe a non-destructive operation.
        const nonDestructive: false = result.destructive;
        // @ts-expect-error The denial error is the exact existing wire literal.
        const otherError: "permission-denied" = result.error;
        // @ts-expect-error Confirmation uses the exact existing field name.
        const otherField: "force" = result.confirmationField;
        void [ok, destructive, error, confirmationField, message, nonDestructive, otherError, otherField];
    }

    if (!result.destructive) {
        const ok: true = result.ok;
        // @ts-expect-error Non-destructive admission cannot be a denial.
        result.error;
        void ok;
    }
    // @ts-expect-error Policy decisions are synchronous values, not native execution promises.
    const asynchronous: Promise<unknown> = result;
    // @ts-expect-error Reasons remain strings rather than untyped values.
    const numericActions: number[] = result.actions;
    void [asynchronous, numericActions];
}

function looseInputContracts(rawName: unknown, rawArgs: unknown) {
    evaluateDestructivePolicy(rawName);
    evaluateDestructivePolicy(rawName, rawArgs);
    evaluateDestructivePolicy("device_delete");
    evaluateDestructivePolicy("device_delete", undefined);
    evaluateDestructivePolicy("device_delete", null);
    evaluateDestructivePolicy(null, false);
    evaluateDestructivePolicy(42, "raw primitive");
    evaluateDestructivePolicy(Symbol("unknown-operation"), 0);
    evaluateDestructivePolicy({}, []);
    evaluateDestructivePolicy("device_delete", { confirmDestructive: new Boolean(true) });
    evaluateDestructivePolicy("device_delete", Object.create({ confirmDestructive: true }));
    // @ts-expect-error The exported evaluator still requires its operation argument.
    evaluateDestructivePolicy();
}

void narrowedResultContracts;
void looseInputContracts;
