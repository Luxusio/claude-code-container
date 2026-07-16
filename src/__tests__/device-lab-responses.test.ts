import { describe, expect, it } from "vitest";
import {
    MCP_ERROR_TEXT_LIMIT_BYTES,
    fail,
    jsonResult,
    textResult,
    truncateDiagnosticText,
} from "../../device-lab-mcp/src/responses.mjs";

function resultText(result: { content: Array<{ text?: string }> }): string {
    return result.content[0]?.text || "";
}

describe("device-lab MCP diagnostic response bounds", () => {
    it("bounds multibyte text errors by encoded byte size", () => {
        const result = textResult(false, "한".repeat(MCP_ERROR_TEXT_LIMIT_BYTES));
        const text = resultText(result);

        expect(result.isError).toBe(true);
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_ERROR_TEXT_LIMIT_BYTES);
        expect(text).toContain("diagnostic truncated");
    });

    it("keeps successful text and normal errors unchanged", () => {
        const successful = "x".repeat(MCP_ERROR_TEXT_LIMIT_BYTES + 1);
        expect(resultText(textResult(true, successful))).toBe(successful);
        expect(resultText(textResult(false, "short failure"))).toBe("short failure");
    });

    it("returns valid bounded JSON summaries for oversized semantic failures", () => {
        const result = jsonResult({
            ok: false,
            error: "provider-command-failed",
            ownerId: "owner-a",
            method: "broker.device.tool.invoke",
            detail: "x".repeat(MCP_ERROR_TEXT_LIMIT_BYTES * 2),
        });
        const text = resultText(result);
        const parsed = JSON.parse(text) as Record<string, unknown>;

        expect(result.isError).toBe(false);
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_ERROR_TEXT_LIMIT_BYTES);
        expect(parsed).toEqual(expect.objectContaining({
            ok: false,
            error: "provider-command-failed",
            ownerId: "owner-a",
            method: "broker.device.tool.invoke",
            diagnosticTruncated: true,
            maxBytes: MCP_ERROR_TEXT_LIMIT_BYTES,
        }));
        expect(parsed.originalBytes).toEqual(expect.any(Number));
        expect(parsed).not.toHaveProperty("detail");
    });

    it("bounds command failures and tiny explicit truncation budgets", () => {
        const failed = fail({ stderr: "e".repeat(MCP_ERROR_TEXT_LIMIT_BYTES * 2), status: 1 });
        expect(Buffer.byteLength(resultText(failed), "utf8")).toBeLessThanOrEqual(MCP_ERROR_TEXT_LIMIT_BYTES);
        expect(Buffer.byteLength(truncateDiagnosticText("oversized", 3), "utf8")).toBeLessThanOrEqual(3);
        expect(truncateDiagnosticText("oversized", 0)).toBe("");
    });
});
