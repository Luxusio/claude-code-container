// Single source of truth for the real-host library scenario's step contract.
//
// The steps are emitted by runHyperVWindowsLibraryScenario only after their own assertions pass, so
// this ordered list is the coverage contract, not a label. Three consumers need it and they cannot
// share a TypeScript import: hyper-v-windows-library-command.mjs runs under plain node with no
// source loader, so this file stays dependency-free .mjs that every consumer can resolve natively.
//
// Previously the count lived inline in each consumer. Adding the snapshot steps updated two of the
// three, and the launcher's stale `=== 8` rejected a scenario that had actually passed all ten.
export const HYPER_V_WINDOWS_LIBRARY_SCENARIO_STEPS = [
    "Hyper-V library preflight",
    "compiled library observed exact 0 HDD / 0 DVD",
    "compiled library observed exact 2 HDD / 2 empty DVD",
    "compiled library started VM and settled Running",
    "compiled library stopped VM and settled Off",
    "lifecycle safe / attachment-conflict / identity-conflict outcomes",
    "compiled library created and observed exactly one checkpoint",
    "compiled library restored and removed the checkpoint by id and by name",
    "compiled library removed VM and retained both VHDX files",
    "guarded fixture cleanup",
];

export const HYPER_V_WINDOWS_LIBRARY_SCENARIO_STEP_COUNT = HYPER_V_WINDOWS_LIBRARY_SCENARIO_STEPS.length;
