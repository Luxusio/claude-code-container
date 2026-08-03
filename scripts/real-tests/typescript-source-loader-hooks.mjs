export async function resolve(specifier, context, nextResolve) {
    try {
        return await nextResolve(specifier, context);
    } catch (error) {
        if (
            error?.code !== "ERR_MODULE_NOT_FOUND"
            || !context.parentURL
            || !specifier.startsWith(".")
            || !specifier.endsWith(".js")
        ) {
            throw error;
        }

        const sourceUrl = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
        if (sourceUrl.protocol !== "file:") throw error;
        try {
            return await nextResolve(sourceUrl.href, context);
        } catch {
            throw error;
        }
    }
}
