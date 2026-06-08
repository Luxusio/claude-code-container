export function textResult(ok, text) {
    return { content: [{ type: "text", text }], isError: !ok };
}

export function jsonResult(value) {
    return textResult(true, JSON.stringify(value, null, 2));
}

export function fail(result) {
    return textResult(false, `Error: ${result.stderr || result.stdout || `exit ${result.status}`}`);
}
