export function textResult(ok, text) {
    return { content: [{ type: "text", text }], isError: !ok };
}

export function jsonResult(value) {
    return textResult(value?.ok !== false, JSON.stringify(value, null, 2));
}
