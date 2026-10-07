import type { CccConfigPorts } from "../../ports/home/config.js";

export function createCccConfig(ports: CccConfigPorts) {
    function read(): Record<string, unknown> {
        const file = ports.resolveConfigPath();
        if (!ports.fileExists(file)) return {};
        try {
            const parsed = JSON.parse(ports.readText(file));
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        } catch {
            return {};
        }
    }

    /**
     * Read-modify-write config.json atomically. An unparseable file is never
     * overwritten: the update throws and the file stays as it is.
     */
    function update(mutate: (config: Record<string, unknown>) => void): undefined {
        const file = ports.resolveConfigPath();
        ports.createDirectory(ports.resolveHomePath(), { recursive: true, mode: 0o700 });
        let config: Record<string, unknown> = {};
        if (ports.fileExists(file)) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(ports.readText(file));
            } catch {
                parsed = null;
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error(`${file} is not a valid JSON object; fix or remove it`);
            }
            config = parsed as Record<string, unknown>;
        }
        mutate(config);
        const temp = `${file}.${ports.processId()}.tmp`;
        ports.writeText(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
        ports.replaceFile(temp, file);
        return undefined;
    }

    return { read, update };
}
