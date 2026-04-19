import pluginN from "eslint-plugin-n";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["src/__tests__/**"] },
    {
        files: ["src/**/*.ts"],
        extends: [tseslint.configs.base],
        plugins: { n: pluginN },
        rules: {
            "n/no-unsupported-features/node-builtins": [
                "error",
                { version: ">=14.14.0" },
            ],
        },
    },
);
