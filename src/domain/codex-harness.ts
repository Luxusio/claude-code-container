export type CodexHarnessObservation =
    | { readonly kind: "completed"; readonly output: string }
    | { readonly kind: "failed"; readonly output: string; readonly failure: unknown };
