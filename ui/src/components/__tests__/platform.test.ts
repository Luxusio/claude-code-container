import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { needsWKWebViewImeBridge } from "../platform";

const origDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");

function setUA(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

describe("needsWKWebViewImeBridge", () => {
  afterEach(() => {
    if (origDescriptor) {
      Object.defineProperty(window.navigator, "userAgent", origDescriptor);
    }
  });

  it("returns true for macOS WKWebView (Tauri)", () => {
    setUA(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    );
    expect(needsWKWebViewImeBridge()).toBe(true);
  });

  it("returns false for macOS Chrome", () => {
    setUA(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    expect(needsWKWebViewImeBridge()).toBe(false);
  });

  it("returns false for macOS Edge (Chromium-based)", () => {
    setUA(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    );
    expect(needsWKWebViewImeBridge()).toBe(false);
  });

  it("returns false for Linux WebKit2GTK (Tauri)", () => {
    setUA(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    );
    expect(needsWKWebViewImeBridge()).toBe(false);
  });

  it("returns false for Windows WebView2", () => {
    setUA(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    );
    expect(needsWKWebViewImeBridge()).toBe(false);
  });

  it("returns false for Linux Chrome", () => {
    setUA(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    expect(needsWKWebViewImeBridge()).toBe(false);
  });
});
