export type DestructivePolicyResult =
    | { ok: true; destructive: false; actions: string[] }
    | { ok: true; destructive: true; actions: string[] }
    | {
        ok: false;
        destructive: true;
        error: "destructive-action-confirmation-required";
        message: string;
        confirmationField: "confirmDestructive";
        actions: string[];
    };

/** Retains legacy JavaScript input behavior; no native effects or validation. */
export function evaluateDestructivePolicy(name: unknown, args?: unknown): DestructivePolicyResult;
