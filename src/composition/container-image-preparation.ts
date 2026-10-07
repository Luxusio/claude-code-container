import { createContainerImagePreparation } from "../application/container-image-preparation.js";
import { runtimeCli } from "../container-runtime.js";
import { CLI_VERSION, IMAGE_NAME } from "../utils.js";

export interface NativeContainerImagePreparationHelpers {
    readonly registryImage: string;
    isImageExists(): boolean;
    getImageLabel(imageName: string, key: string): string | null;
    qualifyImageRefForRuntime(ref: string): string;
    pullImage(ref: string): boolean;
    tagImage(source: string, target: string): void;
}

export function createNativeContainerImagePreparation(helpers: NativeContainerImagePreparationHelpers) {
    for (const name of [
        "isImageExists", "getImageLabel", "qualifyImageRefForRuntime", "pullImage", "tagImage",
    ] as const) {
        if (typeof helpers?.[name] !== "function") {
            throw new TypeError(`Native container image preparation requires a callable ${name} helper.`);
        }
    }
    const preparation = createContainerImagePreparation({
        exists: () => helpers.isImageExists(),
        label: (image, key) => helpers.getImageLabel(image, key),
        qualify: ref => helpers.qualifyImageRefForRuntime(ref),
        pull: ref => helpers.pullImage(ref),
        tag: (source, target) => { helpers.tagImage(source, target); },
        reportStale: (label, version) => {
            console.log(`Image version mismatch (have v${label}, need v${version}). Pulling update...`);
        },
        reportPull: version => { console.log(`Pulling ccc image v${version} from registry...`); },
        reportFallback: ref => { console.warn(`Warning: Failed to pull ${ref}. Using existing image.`); },
        reportFailure: ref => { console.error(`Error: Failed to pull ${ref}.`); },
        reportBuildHint: () => { console.error(`You can build locally instead: ${runtimeCli()} build -t ccc .`); },
        exitFailure: () => { throw new Error("Failed to pull CCC image; container startup was aborted."); },
    });
    const request = {
        get imageName() { return IMAGE_NAME; },
        get version() { return CLI_VERSION; },
        get registryImage() { return helpers.registryImage; },
    };
    return { run: (): undefined => preparation.run(request) };
}
