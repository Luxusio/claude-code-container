import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
    hyperVImageProfile,
    hyperVImageProfileRoot,
    hyperVImageRoot,
    hyperVOwnerImageProfileRoot,
} from "../device-lab/broker/hyper-v/image-store.js";

describe("Hyper-V image store module", () => {
    it("keeps image cache paths below the injected private root", () => {
        const privateRoot = "/private/device-broker";

        expect(hyperVImageRoot(privateRoot)).toBe("/private/device-broker/images/hyper-v");
        expect(hyperVImageProfileRoot(privateRoot, "ubuntu-lts"))
            .toBe("/private/device-broker/images/hyper-v/ubuntu-lts");
        expect(hyperVOwnerImageProfileRoot(privateRoot, "owner-a", "windows-11"))
            .toBe("/private/device-broker/owners/owner-a/images/hyper-v/windows-11");
    });

    it("accepts only supported image profiles", () => {
        expect(hyperVImageProfile("windows-11")).toBe("windows-11");
        expect(hyperVImageProfile("windows-server")).toBe("windows-server");
        expect(hyperVImageProfile("ubuntu-lts")).toBe("ubuntu-lts");
        expect(hyperVImageProfile("custom")).toBeNull();
    });

    it("does not import the broker facade", () => {
        const source = readFileSync(
            new URL("../device-lab/broker/hyper-v/image-store.ts", import.meta.url),
            "utf8",
        );

        expect(source).not.toContain("device-lab-broker");
    });
});
