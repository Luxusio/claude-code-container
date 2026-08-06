import { homedir } from "os";
import { join, resolve } from "path";
import { readDeviceLabStateFile } from "../device-lab-state-file.js";
import { writeJsonFileAtomically } from "../device-lab-shared-state.js";
import {
    HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
    HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
    HYPER_V_WINDOWS_EVALUATION_RECEIPT_FILE,
    HYPER_V_WINDOWS_LEGACY_SOURCE_TRUST_ID,
    HYPER_V_WINDOWS_SOURCE_TRUST_ID,
    HYPER_V_WINDOWS_SOURCE_URL,
    isHyperVWindowsEvaluationReceipt,
    type HyperVWindowsEvaluationReceipt,
} from "./hyper-v-image-contracts.js";

export {
    HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
    HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
    HYPER_V_WINDOWS_EVALUATION_RECEIPT_FILE,
    HYPER_V_WINDOWS_LEGACY_SOURCE_TRUST_ID,
    HYPER_V_WINDOWS_SOURCE_TRUST_ID,
    HYPER_V_WINDOWS_SOURCE_URL,
    isHyperVWindowsEvaluationReceipt,
    type HyperVWindowsEvaluationReceipt,
} from "./hyper-v-image-contracts.js";

export const HYPER_V_IMAGE_CATALOG = {
    "windows-server": {
        catalogId: "microsoft-windows-server-2025-evaluation-vhdx",
        sourceUrl: HYPER_V_WINDOWS_SOURCE_URL,
        sourceFormat: "vhdx",
        licenseId: HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
        secureBootTemplate: "MicrosoftWindows",
        generation: 2,
    },
    "ubuntu-lts": {
        catalogId: "canonical-ubuntu-24.04-lts-hyper-v-desktop-20260731",
        sourceUrl: "https://partner-images.canonical.com/hyper-v/desktop/noble/20260731/ubuntu-noble-hyperv-amd64-ubuntu-desktop-hyperv.vhdx.zip",
        sourceFormat: "vhdx-zip",
        licenseId: null,
        secureBootTemplate: "MicrosoftUEFICertificateAuthority",
        generation: 2,
    },
} as const;

export function hyperVSetupRoot(): string {
    return join(homedir(), ".ccc/device-broker-private/setup");
}

export function hyperVWindowsEvaluationReceiptPath(setupRoot = hyperVSetupRoot()): string {
    return join(resolve(setupRoot), HYPER_V_WINDOWS_EVALUATION_RECEIPT_FILE);
}

export function readHyperVWindowsEvaluationReceipt(setupRoot = hyperVSetupRoot()): HyperVWindowsEvaluationReceipt | null {
    return readDeviceLabStateFile(hyperVWindowsEvaluationReceiptPath(setupRoot), (parsed) => {
        if (!isHyperVWindowsEvaluationReceipt(parsed)) throw new Error("hyper-v-windows-evaluation-license-invalid");
        return parsed.sourceTrustId === HYPER_V_WINDOWS_LEGACY_SOURCE_TRUST_ID
            ? { ...parsed, sourceTrustId: HYPER_V_WINDOWS_SOURCE_TRUST_ID }
            : parsed;
    }, "hyper-v-windows-evaluation-license", 4096);
}

export function acceptHyperVWindowsEvaluationLicense(setupRoot = hyperVSetupRoot()): HyperVWindowsEvaluationReceipt {
    const receipt: HyperVWindowsEvaluationReceipt = {
        version: 2,
        licenseId: HYPER_V_WINDOWS_EVALUATION_LICENSE_ID,
        licenseUrl: HYPER_V_WINDOWS_EVALUATION_LICENSE_URL,
        sourceTrustId: HYPER_V_WINDOWS_SOURCE_TRUST_ID,
        sourceUrl: HYPER_V_WINDOWS_SOURCE_URL,
        acceptedAt: new Date().toISOString(),
    };
    writeJsonFileAtomically(hyperVWindowsEvaluationReceiptPath(setupRoot), receipt);
    return receipt;
}
