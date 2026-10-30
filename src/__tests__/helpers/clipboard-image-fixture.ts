import {createHash} from "crypto";
import {PNG} from "pngjs";

export const slackClipboardImageMinimums = Object.freeze({pngBytes: 410_317, rgbaBytes: 9_490_384});

export interface ClipboardImageFixture {
    readonly png: Buffer;
    readonly width: number;
    readonly height: number;
    readonly rgbaBytes: number;
    readonly sha256: string;
}

let cached: ClipboardImageFixture | undefined;

/** Generated fixture only: comparable PNG and decoded-raster sizes to the reported Slack copy. */
export function createSlackSizedClipboardImageFixture(): ClipboardImageFixture {
    if (!cached) {
        const width = 1600, height = 1500, data = Buffer.alloc(width * height * 4, 255);
        let seed = 0x5eedc0de;
        const nextByte = () => {
            seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
            return seed & 0xff;
        };
        // A small noisy band keeps the encoded image substantial while the
        // remaining opaque raster provides a realistic multi-megabyte decode.
        for (let pixel = 0; pixel < width * 96; pixel++) {
            const offset = pixel * 4;
            data[offset] = nextByte(); data[offset + 1] = nextByte(); data[offset + 2] = nextByte();
        }
        const png = PNG.sync.write({width, height, data}, {filterType: 0, deflateLevel: 9});
        const decoded = PNG.sync.read(png);
        if (png.length < slackClipboardImageMinimums.pngBytes || decoded.data.length < slackClipboardImageMinimums.rgbaBytes) {
            throw new Error(`Generated clipboard image is too small: png=${png.length}, rgba=${decoded.data.length}`);
        }
        cached = {png, width: decoded.width, height: decoded.height, rgbaBytes: decoded.data.length,
            sha256: createHash("sha256").update(png).digest("hex")};
    }
    return {...cached, png: Buffer.from(cached.png)};
}
