import { createHash } from "crypto";
import { copyFileSync, createReadStream, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

import {
    HYPER_V_UBUNTU_IMAGE_SHA256,
    HYPER_V_UBUNTU_IMAGE_URL,
} from "../src/host-control/hyper-v/ubuntu-image.js";

const EFI_SYSTEM_PARTITION_GUID = Buffer.from("28732ac11ff8d211ba4b00a0c93ec93b", "hex");
const REQUIRED_EFI_FILES = ["EFI/BOOT/BOOTX64.EFI", "EFI/ubuntu/shimx64.efi"] as const;
const MAX_GPT_ENTRIES_BYTES = 1024 * 1024;
const MAX_DIRECTORY_CLUSTERS = 4096;

type Partition = { firstLba: number; lastLba: number };
type FatEntry = { attributes: number; cluster: number; size: number };
type FatVolume = {
    fatOffset: number;
    dataOffset: number;
    clusterBytes: number;
    rootCluster: number;
    partitionEnd: number;
};

function parseOptions(args: string[]): { source: string; qemuImg: string } {
    let source = "";
    let qemuImg = process.env.CCC_QEMU_IMG || "qemu-img";
    for (let index = 0; index < args.length; index++) {
        if (args[index] === "--source" && args[index + 1]) source = args[++index];
        else if (args[index] === "--qemu-img" && args[index + 1]) qemuImg = args[++index];
        else throw new Error(`unknown argument: ${args[index]}`);
    }
    if (!source) {
        throw new Error(`missing --source <vmdk>; download the pinned image first: ${HYPER_V_UBUNTU_IMAGE_URL}`);
    }
    return { source: resolve(source), qemuImg };
}

function readExact(fd: number, offset: number, length: number): Buffer {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
        throw new Error("hyper-v-image-verifier-read-range-invalid");
    }
    const buffer = Buffer.alloc(length);
    let consumed = 0;
    while (consumed < length) {
        const count = readSync(fd, buffer, consumed, length - consumed, offset + consumed);
        if (count <= 0) throw new Error("hyper-v-image-verifier-read-incomplete");
        consumed += count;
    }
    return buffer;
}

async function sha256(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
}

function parseEfiPartition(fd: number, imageSize: number): Partition {
    const sectorSize = 512;
    const header = readExact(fd, sectorSize, sectorSize);
    if (header.toString("ascii", 0, 8) !== "EFI PART") throw new Error("hyper-v-image-verifier-gpt-missing");
    const entriesLba = Number(header.readBigUInt64LE(72));
    const entryCount = header.readUInt32LE(80);
    const entrySize = header.readUInt32LE(84);
    const entriesBytes = entryCount * entrySize;
    if (!Number.isSafeInteger(entriesLba) || entriesLba < 2 || entryCount < 1 || entrySize < 128
        || !Number.isSafeInteger(entriesBytes) || entriesBytes > MAX_GPT_ENTRIES_BYTES) {
        throw new Error("hyper-v-image-verifier-gpt-invalid");
    }
    const entries = readExact(fd, entriesLba * sectorSize, entriesBytes);
    const matches: Partition[] = [];
    for (let index = 0; index < entryCount; index++) {
        const entry = entries.subarray(index * entrySize, (index + 1) * entrySize);
        if (!entry.subarray(0, 16).equals(EFI_SYSTEM_PARTITION_GUID)) continue;
        const firstLba = Number(entry.readBigUInt64LE(32));
        const lastLba = Number(entry.readBigUInt64LE(40));
        if (!Number.isSafeInteger(firstLba) || !Number.isSafeInteger(lastLba) || firstLba < 1
            || lastLba < firstLba || (lastLba + 1) * sectorSize > imageSize) {
            throw new Error("hyper-v-image-verifier-efi-partition-invalid");
        }
        matches.push({ firstLba, lastLba });
    }
    if (matches.length !== 1) throw new Error("hyper-v-image-verifier-efi-partition-count-invalid");
    return matches[0];
}

function longNamePart(entry: Buffer): string {
    const chars: string[] = [];
    for (const [offset, length] of [[1, 10], [14, 12], [28, 4]] as const) {
        for (let cursor = offset; cursor < offset + length; cursor += 2) {
            const value = entry.readUInt16LE(cursor);
            if (value !== 0 && value !== 0xffff) chars.push(String.fromCharCode(value));
        }
    }
    return chars.join("");
}

function shortName(entry: Buffer): string {
    const base = entry.toString("ascii", 0, 8).trim();
    const extension = entry.toString("ascii", 8, 11).trim();
    return extension ? `${base}.${extension}` : base;
}

function parseFatVolume(fd: number, partition: Partition): FatVolume {
    const partitionOffset = partition.firstLba * 512;
    const boot = readExact(fd, partitionOffset, 512);
    const bytesPerSector = boot.readUInt16LE(11);
    const sectorsPerCluster = boot.readUInt8(13);
    const reservedSectors = boot.readUInt16LE(14);
    const fatCount = boot.readUInt8(16);
    const fatSectors = boot.readUInt32LE(36);
    const rootCluster = boot.readUInt32LE(44);
    if (bytesPerSector !== 512 || sectorsPerCluster < 1 || reservedSectors < 1 || fatCount < 1
        || fatSectors < 1 || rootCluster < 2 || boot.toString("ascii", 82, 87) !== "FAT32") {
        throw new Error("hyper-v-image-verifier-fat32-invalid");
    }
    const fatOffset = partitionOffset + reservedSectors * bytesPerSector;
    const dataOffset = partitionOffset + (reservedSectors + fatCount * fatSectors) * bytesPerSector;
    const clusterBytes = bytesPerSector * sectorsPerCluster;
    const partitionEnd = (partition.lastLba + 1) * 512;
    if (!Number.isSafeInteger(dataOffset) || !Number.isSafeInteger(clusterBytes)
        || dataOffset >= partitionEnd || clusterBytes > partitionEnd - dataOffset) {
        throw new Error("hyper-v-image-verifier-fat32-range-invalid");
    }
    return { fatOffset, dataOffset, clusterBytes, rootCluster, partitionEnd };
}

function findFatEntry(fd: number, volume: FatVolume, path: string): FatEntry {
    const { fatOffset, dataOffset, clusterBytes, rootCluster, partitionEnd } = volume;
    const nextCluster = (cluster: number): number => readExact(fd, fatOffset + cluster * 4, 4).readUInt32LE(0) & 0x0fffffff;
    const directoryEntry = (cluster: number, wanted: string): FatEntry => {
        const seen = new Set<number>();
        const longParts: string[] = [];
        for (let traversed = 0; traversed < MAX_DIRECTORY_CLUSTERS; traversed++) {
            if (cluster < 2 || cluster >= 0x0ffffff8 || seen.has(cluster)) break;
            seen.add(cluster);
            const offset = dataOffset + (cluster - 2) * clusterBytes;
            if (offset < dataOffset || offset + clusterBytes > partitionEnd) throw new Error("hyper-v-image-verifier-fat-cluster-invalid");
            const directory = readExact(fd, offset, clusterBytes);
            for (let cursor = 0; cursor < directory.length; cursor += 32) {
                const entry = directory.subarray(cursor, cursor + 32);
                if (entry[0] === 0) throw new Error(`hyper-v-image-verifier-path-missing:${path}`);
                if (entry[0] === 0xe5) { longParts.length = 0; continue; }
                if (entry[11] === 0x0f) { longParts.unshift(longNamePart(entry)); continue; }
                const name = longParts.length ? longParts.join("") : shortName(entry);
                longParts.length = 0;
                if (name.toLowerCase() !== wanted.toLowerCase()) continue;
                return {
                    attributes: entry[11],
                    cluster: (entry.readUInt16LE(20) << 16) | entry.readUInt16LE(26),
                    size: entry.readUInt32LE(28),
                };
            }
            cluster = nextCluster(cluster);
        }
        throw new Error(`hyper-v-image-verifier-path-missing:${path}`);
    };

    let current = { attributes: 0x10, cluster: rootCluster, size: 0 };
    const components = path.split("/").filter(Boolean);
    for (let index = 0; index < components.length; index++) {
        if ((current.attributes & 0x10) === 0) throw new Error(`hyper-v-image-verifier-parent-not-directory:${path}`);
        current = directoryEntry(current.cluster, components[index]);
        if (index < components.length - 1 && (current.attributes & 0x10) === 0) {
            throw new Error(`hyper-v-image-verifier-parent-not-directory:${path}`);
        }
    }
    return current;
}

function validateFatFile(fd: number, volume: FatVolume, entry: FatEntry, path: string): void {
    if ((entry.attributes & 0x10) !== 0 || entry.size <= 0 || entry.cluster < 2) {
        throw new Error(`hyper-v-image-verifier-loader-invalid:${path}`);
    }
    const availableClusters = Math.floor((volume.partitionEnd - volume.dataOffset) / volume.clusterBytes);
    const requiredClusters = Math.ceil(entry.size / volume.clusterBytes);
    if (requiredClusters < 1 || requiredClusters > availableClusters) {
        throw new Error(`hyper-v-image-verifier-loader-range-invalid:${path}`);
    }
    const seen = new Set<number>();
    let cluster = entry.cluster;
    let remaining = entry.size;
    for (let index = 0; index < requiredClusters; index++) {
        if (cluster < 2 || cluster >= 0x0ffffff8 || seen.has(cluster)) {
            throw new Error(`hyper-v-image-verifier-loader-chain-invalid:${path}`);
        }
        seen.add(cluster);
        const offset = volume.dataOffset + (cluster - 2) * volume.clusterBytes;
        const bytes = Math.min(remaining, volume.clusterBytes);
        if (!Number.isSafeInteger(offset) || offset < volume.dataOffset || offset + bytes > volume.partitionEnd) {
            throw new Error(`hyper-v-image-verifier-loader-range-invalid:${path}`);
        }
        readExact(fd, offset, bytes);
        remaining -= bytes;
        if (remaining > 0) {
            cluster = readExact(fd, volume.fatOffset + cluster * 4, 4).readUInt32LE(0) & 0x0fffffff;
        }
    }
    if (remaining !== 0) throw new Error(`hyper-v-image-verifier-loader-chain-invalid:${path}`);
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    const source = lstatSync(options.source);
    if (!source.isFile() || source.isSymbolicLink()) throw new Error("hyper-v-image-verifier-source-invalid");
    const sourceSha256 = await sha256(options.source);
    if (sourceSha256 !== HYPER_V_UBUNTU_IMAGE_SHA256) throw new Error("hyper-v-image-verifier-source-hash-mismatch");

    const work = mkdtempSync(join(tmpdir(), "ccc-hyper-v-ubuntu-verify-"));
    const verifiedSourcePath = join(work, "source.vmdk");
    const rawPath = join(work, "ubuntu.raw");
    try {
        copyFileSync(options.source, verifiedSourcePath);
        const verifiedSourceSha256 = await sha256(verifiedSourcePath);
        if (verifiedSourceSha256 !== HYPER_V_UBUNTU_IMAGE_SHA256) {
            throw new Error("hyper-v-image-verifier-source-copy-hash-mismatch");
        }
        const conversion = spawnSync(options.qemuImg, ["convert", "-f", "vmdk", "-O", "raw", verifiedSourcePath, rawPath], {
            encoding: "utf8",
            timeout: 10 * 60 * 1000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        if (conversion.status !== 0 || conversion.error) {
            throw new Error(`hyper-v-image-verifier-convert-failed:${conversion.error?.message || conversion.stderr.trim()}`);
        }
        const fd = openSync(rawPath, "r");
        try {
            const imageSize = fstatSync(fd).size;
            const efiPartition = parseEfiPartition(fd, imageSize);
            const volume = parseFatVolume(fd, efiPartition);
            for (const path of REQUIRED_EFI_FILES) {
                validateFatFile(fd, volume, findFatEntry(fd, volume, path), path);
            }
        } finally {
            closeSync(fd);
        }
        process.stdout.write(`${JSON.stringify({ ok: true, source: options.source, sourceSha256, requiredEfiFiles: REQUIRED_EFI_FILES })}\n`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
