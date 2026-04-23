import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { usePty } from "../hooks/usePty";
import type { UnlistenFn } from "@tauri-apps/api/event";

interface TerminalProps {
  sessionId: string;
  projectPath: string;
  continueSessionId?: string;
}

export function Terminal({ sessionId, projectPath, continueSessionId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const unlistenDataRef = useRef<UnlistenFn | null>(null);
  const unlistenClosedRef = useRef<UnlistenFn | null>(null);
  const { createPty, createPtyWithContinue, writePty, resizePty, onPtyData, onPtyClosed } = usePty();

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
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
      fontFamily: '"Menlo", "Monaco", "Consolas", "Courier New", "Apple SD Gothic Neo", "Noto Sans Mono CJK KR", "D2Coding", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Small delay to ensure DOM layout is computed before fitting
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Forward keystrokes to PTY
    const dataDisposable = term.onData((data) => {
      writePty(sessionId, data).catch(console.error);
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
        const { cols: newCols, rows: newRows } = term;
        resizePty(sessionId, newCols, newRows).catch(console.error);
      });
    });
    resizeObserver.observe(containerRef.current);

    // Register listeners FIRST, then create PTY (avoids missing initial output)
    const init = async () => {
      // Wait for layout to settle so fitAddon has correct dimensions
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      fitAddon.fit();

      const { cols, rows } = term;

      try {
        unlistenDataRef.current = await onPtyData(sessionId, (data: string) => {
          term.write(data);
        });

        unlistenClosedRef.current = await onPtyClosed(sessionId, () => {
          term.write("\r\n\x1b[33m[Process exited]\x1b[0m\r\n");
        });
      } catch (err) {
        console.error(`[Terminal] failed to register listeners:`, err);
        term.write(`\r\n\x1b[31m[Listener error: ${err}]\x1b[0m\r\n`);
        return;
      }

      const createFn = continueSessionId
        ? createPtyWithContinue(sessionId, projectPath, continueSessionId, cols, rows)
        : createPty(sessionId, projectPath, cols, rows);

      createFn.catch((err) => {
        console.error(`[Terminal] createPty error:`, err);
        term.write(`\r\n\x1b[31m[Error: ${err}]\x1b[0m\r\n`);
      });
    };

    init();

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unlistenDataRef.current?.();
      unlistenClosedRef.current?.();
      term.dispose();
      // Note: PTY lifetime is managed by App's handleCloseSession, not here.
      // Omitting closePty avoids race conditions with async cleanup in React StrictMode.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectPath, continueSessionId]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        width: "100%",
        overflow: "hidden",
      }}
    />
  );
}
