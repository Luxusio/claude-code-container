// Compatibility import path for existing native and administrative callers.
// The pure image readiness policy has one inward implementation.
export {
    hyperVLinuxImageBlockers,
    hyperVLinuxImageSkipReason,
    hyperVLinuxSmokeImageResult,
    type HyperVLinuxImageReadiness,
} from "./domain/broker-observation.js";
