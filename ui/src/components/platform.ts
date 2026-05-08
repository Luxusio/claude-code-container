// Webview/platform detection.
//
// Tauri uses different webviews per OS:
//   - macOS:    WKWebView (Apple WebKit) — fires `input` events with
//               `inputType: insertReplacementText` for CJK IME but does
//               NOT fire `compositionstart`/`compositionend`. Needs our
//               manual IME bridge in Terminal.tsx.
//   - Linux:    WebKit2GTK — uses GTK IM modules (ibus/fcitx) and emits
//               standard `compositionstart`/`update`/`end`. xterm.js's
//               built-in CompositionHelper handles this correctly.
//   - Windows:  WebView2 (Chromium-based) — same as Chromium, standard
//               composition events. xterm handles natively.
//
// Anything that isn't macOS WKWebView gets the default xterm path. We avoid
// touching the input pipeline on those platforms because our intercept
// (capture-phase + stopPropagation) actively breaks the standard flow.

export function needsWKWebViewImeBridge(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // macOS check — covers MacIntel and Apple Silicon ("Mac OS" / "Macintosh"
  // appear in WKWebView UA).
  const isMac = /Macintosh|Mac OS X/.test(ua);
  if (!isMac) return false;
  // Distinguish WKWebView from Chrome/Chromium running on macOS. Chromium
  // strings include "Chrome/" (and often "Chromium/"), WKWebView doesn't.
  const isChromium = /Chrome\//.test(ua) || /Chromium\//.test(ua) || /Edg\//.test(ua);
  return !isChromium;
}
