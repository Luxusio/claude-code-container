import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const ANDROID_APP_FIXTURE_PACKAGE = "dev.ccc.fixture";
export const ANDROID_APP_FIXTURE_PERMISSION = "android.permission.CAMERA";
export const ANDROID_APP_FIXTURE_SHA256 = "e99f26407a2fcde555e2ab624fc7ebebf221cddb8f9f1293da30e1578e2fcf19";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "android-app");

export function materializeAndroidAppFixture(outputDir) {
    const encoded = readFileSync(join(fixtureRoot, "ccc-device-lab-fixture.apk.b64"), "utf-8");
    const apk = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
    const digest = createHash("sha256").update(apk).digest("hex");
    if (digest !== ANDROID_APP_FIXTURE_SHA256) {
        throw new Error(`Android app fixture checksum mismatch: ${digest}`);
    }
    const signingBlock = Buffer.from("APK Sig Block 42", "ascii");
    const v2SchemeId = Buffer.from([0x1a, 0x87, 0x09, 0x71]);
    const v3SchemeId = Buffer.from([0xc0, 0x68, 0x53, 0xf0]);
    if (!apk.includes(signingBlock) || !apk.includes(v2SchemeId) || !apk.includes(v3SchemeId)) {
        throw new Error("Android app fixture must contain APK Signature Scheme v2 and v3 signatures");
    }
    const path = join(outputDir, "ccc-device-lab-fixture.apk");
    writeFileSync(path, apk);
    return {
        path,
        packageName: ANDROID_APP_FIXTURE_PACKAGE,
        permission: ANDROID_APP_FIXTURE_PERMISSION,
        sha256: digest,
        signatureSchemes: ["v1", "v2", "v3"],
    };
}
