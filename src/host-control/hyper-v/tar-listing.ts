export function tarVerboseEntrySize(line: string, entry: string): number | null {
    if (!line.startsWith("-") || !line.endsWith(entry)) return null;
    const prefix = line.slice(0, -entry.length).trim();
    const numericFields = prefix.split(/\s+/u).slice(1).filter((field) => /^\d+$/u.test(field)).map(Number);
    const size = numericFields.length > 0 ? Math.max(...numericFields) : Number.NaN;
    return Number.isSafeInteger(size) && size >= 0 ? size : null;
}
