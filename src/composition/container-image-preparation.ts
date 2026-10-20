import { fileURLToPath } from "node:url";
import type { RuntimeName } from "../domain/container-runtime.js";
import { createContainerImagePreparation } from "../application/container-image-preparation.js";
import type { ImageTagOutcome } from "../ports/container-image-preparation.js";
import { runtimeCli } from "../container-runtime.js";
import { CLI_VERSION, IMAGE_NAME } from "../utils.js";

/** Copyable POSIX-shell or Windows PowerShell command; execution uses argv. */
export function distributionImageBuildCommand(
    runtime: RuntimeName,
    commandPath = fileURLToPath(new URL("../../scripts/build-distribution-image.mjs", import.meta.url)),
    platform: string = process.platform,
): string {
    const quotedPath = platform === "win32"
        ? "'" + commandPath.replace(/'/g, "''") + "'"
        : "'" + commandPath.replace(/'/g, "'\\''") + "'";
    return `node ${quotedPath} --runtime ${runtime}`;
}

export function distributionImageBuildHint(
    runtime: RuntimeName,
    commandPath = fileURLToPath(new URL("../../scripts/build-distribution-image.mjs", import.meta.url)),
    platform: string = process.platform,
): string {
    const shell = platform === "win32" ? " (PowerShell)" : "";
    return `You can build locally instead${shell}: ${distributionImageBuildCommand(runtime, commandPath, platform)}`;
}

export interface NativeContainerImagePreparationHelpers {
    readonly registryImage: string;
    isImageExists(): boolean;
    getImageLabel(imageName: string, key: string): string | null;
    qualifyImageRefForRuntime(ref: string): string;
    pullImage(ref: string): boolean;
    tagImage(source: string, target: string): ImageTagOutcome;
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
        tag: (source, target) => helpers.tagImage(source, target),
        reportStale: (label, version) => {
            console.log(`Image version mismatch (have v${label}, need v${version}). Pulling update...`);
        },
        reportPull: version => { console.log(`Pulling ccc image v${version} from registry...`); },
        reportFallback: ref => { console.warn(`Warning: Failed to pull ${ref}. Using existing image.`); },
    });
    const request = {
        get imageName() { return IMAGE_NAME; },
        get version() { return CLI_VERSION; },
        get registryImage() { return helpers.registryImage; },
    };
    return {
        run: (): undefined => {
            const outcome = preparation.run(request);
            if (outcome.kind === "completed") return;
            if (outcome.reason === "image-pull-failed") {
                console.error(`Error: Failed to pull ${outcome.reference}.`);
                console.error(distributionImageBuildHint(runtimeCli()));
                throw new Error("Failed to pull CCC image; container startup was aborted.");
            }
            if (outcome.reason === "image-tag-failed") {
                console.error("Error: Failed to tag CCC image.");
                throw new Error("Failed to tag CCC image; container startup was aborted.");
            }
            console.error("Error: CCC image tag could not be confirmed.");
            throw new Error("CCC image tag could not be confirmed; container startup was aborted.");
        },
    };
}
