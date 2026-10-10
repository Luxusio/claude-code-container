import type { QemuImageImportArguments, QemuImageImportPorts, QemuImageImportResult } from "../ports/qemu-image-import.mjs";
export function createQemuImageImportApplication(ports: QemuImageImportPorts): { importImage(args?: QemuImageImportArguments): QemuImageImportResult };
