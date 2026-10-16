export type CodexConfigPreparationObservation =
    | { readonly kind: "ready" }
    | { readonly kind: "repair-required" }
    | { readonly kind: "timed-out"; readonly failure?: Error }
    | { readonly kind: "failed"; readonly failure?: Error };

export type CodexConfigPreparationResult = Exclude<CodexConfigPreparationObservation, { readonly kind: "repair-required" }>;

export interface CodexConfigPreparationPorts {
    probe(target: string): CodexConfigPreparationObservation;
    repair(target: string): CodexConfigPreparationResult;
    finalize(target: string): CodexConfigPreparationResult;
}
