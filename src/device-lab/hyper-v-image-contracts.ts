export const HYPER_V_WINDOWS_EVALUATION_LICENSE_ID = "windows-server-2025-evaluation";
export const HYPER_V_WINDOWS_EVALUATION_LICENSE_URL = "https://www.microsoft.com/en-us/evalcenter/download-windows-server-2025";
export const HYPER_V_WINDOWS_SOURCE_TRUST_ID = "microsoft-evaluation-https-tofu-v1";
export const HYPER_V_WINDOWS_LEGACY_SOURCE_TRUST_ID = "microsoft-evaluation-allowlisted-https-v1";
export const HYPER_V_WINDOWS_SOURCE_URL = "https://go.microsoft.com/fwlink/?clcid=0x409&country=us&culture=en-us&linkid=2345826";
export const HYPER_V_WINDOWS_EVALUATION_RECEIPT_FILE = "hyper-v-windows-evaluation-license.json";

export type HyperVWindowsEvaluationReceipt = {
    version: 2;
    licenseId: typeof HYPER_V_WINDOWS_EVALUATION_LICENSE_ID;
    licenseUrl: typeof HYPER_V_WINDOWS_EVALUATION_LICENSE_URL;
    sourceTrustId: typeof HYPER_V_WINDOWS_SOURCE_TRUST_ID | typeof HYPER_V_WINDOWS_LEGACY_SOURCE_TRUST_ID;
    sourceUrl: typeof HYPER_V_WINDOWS_SOURCE_URL;
    acceptedAt: string;
};

export function isHyperVWindowsEvaluationReceipt(value: unknown): value is HyperVWindowsEvaluationReceipt {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const receipt = value as Record<string, unknown>;
    return receipt.version === 2
        && receipt.licenseId === HYPER_V_WINDOWS_EVALUATION_LICENSE_ID
        && receipt.licenseUrl === HYPER_V_WINDOWS_EVALUATION_LICENSE_URL
        && (receipt.sourceTrustId === HYPER_V_WINDOWS_SOURCE_TRUST_ID || receipt.sourceTrustId === HYPER_V_WINDOWS_LEGACY_SOURCE_TRUST_ID)
        && receipt.sourceUrl === HYPER_V_WINDOWS_SOURCE_URL
        && typeof receipt.acceptedAt === "string"
        && !Number.isNaN(Date.parse(receipt.acceptedAt));
}
