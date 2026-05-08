import { useEffect, useRef } from "react";
import type { IDisposable } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { usePty } from "../hooks/usePty";
import { getOrCreateTerm, markOpened, markPtySpawned } from "./terminalRegistry";
import { createImeGate } from "./imeGate";
import { needsWKWebViewImeBridge } from "./platform";

interface TerminalProps {
  sessionId: string;
  projectPath: string;
  continueSessionId?: string;
  isActive?: boolean;
}

const TERM_OPTIONS = {
  theme: {
    background: "#0d0d10",
    foreground: "#d4d4d4",
    cursor: "#7c6af7",
    cursorAccent: "#0d0d10",
    selectionBackground: "#7c6af740",
    black: "#1e1e2e",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#cba6f7",
    cyan: "#89dceb",
    white: "#cdd6f4",
    brightBlack: "#45475a",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#cba6f7",
    brightCyan: "#89dceb",
    brightWhite: "#cdd6f4",
  },
  fontFamily:
    '"Menlo", "Monaco", "Consolas", "Courier New", "Apple SD Gothic Neo", "Noto Sans Mono CJK KR", "D2Coding", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  cursorBlink: true,
  scrollback: 5000,
} as const;

export function Terminal({
  sessionId,
  projectPath,
  continueSessionId,
  isActive = true,
}: TerminalProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  const { createPty, createPtyWithContinue, writePty, resizePty, onPtyData, onPtyClosed } =
    usePty();

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    // Acquire (or create) the long-lived xterm instance for this session.
    const { term, fitAddon, termEl, needsOpen, needsSpawn } = getOrCreateTerm(
      sessionId,
      TERM_OPTIONS,
    );

    // Move the persistent xterm DOM into our wrapper FIRST, then open xterm
    // on it. Hyper does the same (term.tsx:187 → :222) to avoid the renderer
    // initializing against a 0×0 detached node.
    wrapper.appendChild(termEl);
    if (needsOpen) {
      term.open(termEl);
      markOpened(sessionId);
    }

    const hasLayout = () => wrapper.clientWidth > 0 && wrapper.clientHeight > 0;
    const safeFit = () => {
      if (!hasLayout()) return;
      try {
        fitAddon.fit();
      } catch {
        /* xterm throws inside fit when renderer hasn't mounted; ignore */
      }
    };

    requestAnimationFrame(safeFit);

    // Component-scoped disposables. xterm IDisposable plus a few hand-rolled.
    const disposables: IDisposable[] = [];

    // IME handling is platform-gated. Only macOS WKWebView (Tauri) needs the
    // custom bridge below — it does not fire compositionstart/end for CJK
    // IME and routes composition state through `input` events with
    // inputType="insertReplacementText". WebKit2GTK (Linux Tauri) and
    // WebView2 (Windows Tauri) emit standard composition events that
    // xterm.js's built-in CompositionHelper handles correctly; intercepting
    // there would only break a working pipeline.
    if (needsWKWebViewImeBridge()) {
      const imeGate = createImeGate();
      const textarea =
        (term as unknown as { textarea?: HTMLTextAreaElement }).textarea ?? null;

      // Dedupe ring. xterm's bubble-phase input handler is supposed to be
      // stopped by our capture-phase stopPropagation, but in practice
      // triggerDataEvent still fires from xterm's internal pipeline on
      // some webviews — so the same Korean glyph would land twice (once
      // from our writePty, once from term.onData). Every PTY write goes
      // through writePtyOnce; term.onData drops anything matching a recent
      // entry within DEDUPE_MS. Window is short so legitimate repeats from
      // the user (e.g. "ㅋㅋㅋ" after a flush) still get through.
      const DEDUPE_MS = 120;
      const recentWrites: Array<{ text: string; until: number }> = [];
      const gcRecent = (now: number) => {
        while (recentWrites.length && recentWrites[0].until < now) recentWrites.shift();
      };
      const writePtyOnce = (data: string): Promise<void> => {
        const now = performance.now();
        gcRecent(now);
        recentWrites.push({ text: data, until: now + DEDUPE_MS });
        return writePty(sessionId, data);
      };
      const consumeDup = (data: string): boolean => {
        const now = performance.now();
        gcRecent(now);
        for (let i = 0; i < recentWrites.length; i++) {
          if (recentWrites[i].text === data) {
            recentWrites.splice(i, 1);
            return true;
          }
        }
        return false;
      };

      // Composition overlay. WKWebView never fires compositionstart/end so
      // xterm's built-in composition view never shows up. We render our own
      // span overlaid on top of the xterm screen at the textarea position.
      const overlay = document.createElement("span");
      overlay.className = "ccc-ime-overlay";
      Object.assign(overlay.style, {
        position: "absolute",
        pointerEvents: "none",
        whiteSpace: "pre",
        textDecoration: "underline",
        color: TERM_OPTIONS.theme.foreground,
        background: TERM_OPTIONS.theme.background,
        fontFamily: TERM_OPTIONS.fontFamily,
        fontSize: `${TERM_OPTIONS.fontSize}px`,
        lineHeight: String(TERM_OPTIONS.lineHeight),
        zIndex: "10",
        display: "none",
      } satisfies Partial<CSSStyleDeclaration>);
      termEl.appendChild(overlay);

      const refreshOverlay = () => {
        const pending = imeGate._peekPending();
        if (!pending || !textarea) {
          overlay.style.display = "none";
          return;
        }
        overlay.textContent = pending;
        overlay.style.left = textarea.style.left || "0px";
        overlay.style.top = textarea.style.top || "0px";
        if (textarea.style.height) overlay.style.height = textarea.style.height;
        if (textarea.style.lineHeight) overlay.style.lineHeight = textarea.style.lineHeight;
        overlay.style.display = "inline-block";
      };

      const onInput = (e: Event) => {
        const ie = e as InputEvent;
        const { write } = imeGate.handleInput(ie.inputType, ie.data ?? "");
        if (write) writePtyOnce(write).catch(console.error);
        refreshOverlay();
        if (textarea) textarea.value = "";
        // stopImmediatePropagation is handled by the capture-phase wrapper
        // below so xterm's target-phase listener never fires.
      };

      const onKeydown = (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key && ke.key !== "Process" && ke.key !== "Dead" && ke.key !== "Unidentified") {
          const flushed = imeGate.flushPending();
          if (flushed) writePtyOnce(flushed).catch(console.error);
          refreshOverlay();
        }
      };

      const onBlur = () => {
        const flushed = imeGate.flushPending();
        if (flushed) writePtyOnce(flushed).catch(console.error);
        refreshOverlay();
      };

      if (textarea) {
        // Register on termEl (parent of the helper textarea) in capture
        // phase. This is the only way to run BEFORE xterm's own input
        // listener on the same textarea — listeners on the same element
        // run in registration order regardless of useCapture, and xterm
        // already registered during term.open() (which we just called or
        // was previously called). A parent-capture listener fires during
        // the capture phase, which precedes the target phase entirely;
        // stopImmediatePropagation then keeps xterm's target-phase
        // listener from running and emitting a duplicate triggerDataEvent.
        const onInputCapture = (e: Event) => {
          onInput(e);
          e.stopImmediatePropagation();
        };
        termEl.addEventListener("input", onInputCapture, true);
        // Keydown does not stopPropagation — xterm needs to translate the
        // key to PTY bytes (arrows, Ctrl-*, Enter, etc.). We just flush
        // any buffered glyph BEFORE xterm runs.
        termEl.addEventListener("keydown", onKeydown, true);
        // blur doesn't bubble, so listening on a parent wouldn't help.
        textarea.addEventListener("blur", onBlur, true);
        disposables.push({
          dispose: () => {
            termEl.removeEventListener("input", onInputCapture, true);
            termEl.removeEventListener("keydown", onKeydown, true);
            textarea.removeEventListener("blur", onBlur, true);
            if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
          },
        });
      }

      // Outbound: dedupe-aware. IME-committed text is double-fired by xterm
      // on WKWebView; consumeDup drops the second one.
      disposables.push(
        term.onData((data) => {
          if (consumeDup(data)) return;
          writePty(sessionId, data).catch(console.error);
        }),
      );
    } else {
      // Standard path (Linux WebKit2GTK, Windows WebView2, Chromium-based):
      // xterm.js's built-in IME handling already does the right thing.
      // We just forward whatever it produces.
      disposables.push(
        term.onData((data) => {
          writePty(sessionId, data).catch(console.error);
        }),
      );
    }

    // ResizeObserver with 500ms trailing debounce — Hyper's pattern. Avoids
    // a storm of fit()/resize() calls when the user drags split panes.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (!hasLayout()) return;
        safeFit();
        const { cols, rows } = term;
        if (cols > 0 && rows > 0) {
          resizePty(sessionId, cols, rows).catch(console.error);
        }
      }, 500);
    });
    ro.observe(wrapper);

    // Triggered from the isActive effect below.
    refreshRef.current = () => {
      requestAnimationFrame(() => {
        if (!hasLayout()) return;
        // Local repaint of xterm's existing buffer. No PTY round-trip, so
        // it doesn't feel like a reload.
        term.refresh(0, term.rows - 1);
        // Only fit when proposed dims actually changed — fit() forces an
        // internal resize that flashes the cursor to (0,0) for a frame.
        const proposed = fitAddon.proposeDimensions();
        if (proposed && (proposed.cols !== term.cols || proposed.rows !== term.rows)) {
          safeFit();
        }
        term.focus();
      });
    };

    // Inbound: PTY events -> term.write. Listener registration is async via
    // Tauri; track an unmount-cancellation flag so the late-arriving handler
    // doesn't try to attach to a torn-down session.
    let cancelled = false;

    (async () => {
      let unlistenData: (() => void) | null = null;
      let unlistenClosed: (() => void) | null = null;
      try {
        unlistenData = await onPtyData(sessionId, (data) => {
          term.write(data);
        });
        unlistenClosed = await onPtyClosed(sessionId, () => {
          term.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
        });
      } catch (err) {
        console.error("[Terminal] failed to register listeners:", err);
        if (!cancelled) term.write(`\r\n\x1b[31m[Listener error: ${err}]\x1b[0m\r\n`);
        return;
      }
      if (cancelled) {
        unlistenData?.();
        unlistenClosed?.();
        return;
      }
      // Same disposal model as xterm IDisposable so cleanup is uniform.
      disposables.push({ dispose: () => unlistenData?.() });
      disposables.push({ dispose: () => unlistenClosed?.() });

      // PTY spawn is gated on registry-level state, not on this component's
      // newness. This handles the StrictMode race where the first mount
      // creates the registry entry but cancels before reaching the spawn —
      // the second mount sees `needsSpawn === true` (because the first
      // never marked it) and spawns correctly. Mark BEFORE the await so
      // legitimately concurrent acquires don't double-spawn.
      if (needsSpawn) {
        markPtySpawned(sessionId);
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (cancelled) return;
        safeFit();
        const { cols, rows } = term;
        const create = continueSessionId
          ? createPtyWithContinue(sessionId, projectPath, continueSessionId, cols, rows)
          : createPty(sessionId, projectPath, cols, rows);
        create.catch((err) => {
          console.error("[Terminal] createPty error:", err);
          term.write(`\r\n\x1b[31m[Error: ${err}]\x1b[0m\r\n`);
        });
      }
    })();

    return () => {
      cancelled = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      // Hyper-style: tear down listeners only. The xterm instance lives on
      // in the registry — releaseTerm() in App.handleCloseSession is what
      // actually disposes it when the session is closed for real. PTY
      // unlisteners are wrapped as IDisposable inside the async block above,
      // so this single forEach covers them too.
      disposables.forEach((d) => d.dispose());
      refreshRef.current = null;
      // Detach the persistent term DOM from this wrapper so a future remount
      // can re-append it cleanly.
      if (termEl.parentElement === wrapper) {
        wrapper.removeChild(termEl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectPath, continueSessionId]);

  // When this terminal becomes the active tab, give it focus and make sure
  // its visible rows are painted (xterm's renderer can skip paints while
  // visibility:hidden, leaving stale cells behind).
  useEffect(() => {
    if (isActive) refreshRef.current?.();
  }, [isActive]);

  return (
    <div
      ref={wrapperRef}
      style={{
        flex: 1,
        minHeight: 0,
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    />
  );
}
