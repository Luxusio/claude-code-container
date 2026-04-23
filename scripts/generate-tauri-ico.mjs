#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, "..", "ui", "src-tauri", "icons");
const pngPath = join(iconsDir, "icon.png");
const icoPath = join(iconsDir, "icon.ico");

const png = readFileSync(pngPath);
if (png.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`${pngPath} is not a valid PNG`);
}

// ICONDIR (6 bytes)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(1, 4); // count = 1

// ICONDIRENTRY (16 bytes)
const entry = Buffer.alloc(16);
entry.writeUInt8(32, 0);            // width = 32
entry.writeUInt8(32, 1);            // height = 32
entry.writeUInt8(0, 2);             // colorcount
entry.writeUInt8(0, 3);             // reserved
entry.writeUInt16LE(1, 4);          // planes
entry.writeUInt16LE(32, 6);         // bitcount
entry.writeUInt32LE(png.length, 8); // bytes in res
entry.writeUInt32LE(22, 12);        // offset (6+16)

writeFileSync(icoPath, Buffer.concat([header, entry, png]));
console.log(`Wrote ${icoPath} (${6 + 16 + png.length} bytes)`);
