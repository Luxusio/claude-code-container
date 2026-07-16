import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export const ANDROID_APP_FIXTURE_PACKAGE = "dev.ccc.fixture";
export const ANDROID_APP_FIXTURE_PERMISSION = "android.permission.CAMERA";
export const ANDROID_APP_FIXTURE_SHA256 = "04b8909e02669359a2a3babe0751f9c272e2ed5a2aeeb56c461a8208b32bd4c2";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "android-app");

export function materializeAndroidAppFixture(outputDir) {
    const encoded = readFileSync(join(fixtureRoot, "ccc-device-lab-fixture.apk.b64"), "utf-8");
    const apk = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
    const digest = createHash("sha256").update(apk).digest("hex");
    if (digest !== ANDROID_APP_FIXTURE_SHA256) {
        throw new Error(`Android app fixture checksum mismatch: ${digest}`);
    }
    const path = join(outputDir, "ccc-device-lab-fixture.apk");
    writeFileSync(path, apk);
    return {
        path,
        packageName: ANDROID_APP_FIXTURE_PACKAGE,
        permission: ANDROID_APP_FIXTURE_PERMISSION,
        sha256: digest,
    };
}
