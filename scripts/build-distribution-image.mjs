#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DISTRIBUTION_IMAGE_BUILD_TIMEOUT_MS = 20 * 60 * 1000;
const modulePath = fileURLToPath(import.meta.url);
const payloadRoot = dirname(dirname(modulePath));
const recipePath = join(payloadRoot, "Dockerfile.distribution");
const diagnosticLimit = 2048;

function reportFailure(detail) {
    console.error(`CCC distribution image build failed: ${String(detail).slice(0, diagnosticLimit)}`);
}

/** Explicit synchronous command. Importing this module performs no image build. */
export function buildDistributionImage(args) {
    const runtime = args[1];
    if (args.length !== 2 || args[0] !== "--runtime" || (runtime !== "docker" && runtime !== "podman")) {
        reportFailure("Usage: node <payload>/scripts/build-distribution-image.mjs --runtime docker|podman");
        return 1;
    }
    let result;
    try {
        result = spawnSync(runtime, ["build", "-t", "ccc", "-f", recipePath, payloadRoot], {
            cwd: payloadRoot, stdio: "inherit", shell: false,
            timeout: DISTRIBUTION_IMAGE_BUILD_TIMEOUT_MS,
        });
    } catch (error) {
        reportFailure(`${runtime} could not start: ${error?.message ?? error}`);
        return 1;
    }
    const error = result.error;
    if (error) {
        reportFailure(error.code === "ETIMEDOUT"
            ? `${runtime} build timed out after 20 minutes.`
            : `${runtime} could not complete: ${error.message ?? error}`);
        return 1;
    }
    const signal = result.signal;
    if (signal) {
        reportFailure(`${runtime} build terminated by ${signal}.`);
        return 1;
    }
    const status = result.status;
    if (status === 0) {
        console.log("CCC distribution image built (tag: ccc).");
        return 0;
    }
    if (Number.isInteger(status) && status > 0) {
        reportFailure(`${runtime} build exited with code ${status}.`);
        return status;
    }
    reportFailure(status == null
        ? `${runtime} build ended without an exit code.`
        : `${runtime} build returned invalid exit code ${status}.`);
    return 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && (process.platform === "win32"
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath)) {
    process.exitCode = buildDistributionImage(process.argv.slice(2));
}
