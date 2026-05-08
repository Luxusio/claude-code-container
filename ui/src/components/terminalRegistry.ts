import { Terminal as XTerm, ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

// Module-level registry of live xterm instances keyed by sessionId.
//
// Why this exists: in a naive React+xterm setup the xterm instance lives
// inside a component's effect, so any unmount (StrictMode, key change, tab
// closed-and-reopened, parent layout reshuffle) disposes it and recreates
// from scratch — losing scrollback, breaking PTY listener registration,
// flickering. Hyper's `term.tsx` solves this by keeping the term *outside*
// the React tree and letting components borrow it. Same pattern here.
//
// Lifecycle:
//   - getOrCreateTerm(id, opts) — first call creates+opens. Subsequent calls
//     reuse the existing instance regardless of who is asking.
//   - releaseTerm(id) — explicit disposal. Called from App.handleCloseSession
//     when the user actually closes the tab. Component unmounts NEVER call
//     this directly.

interface RegEntry {
  term: XTerm;
  fitAddon: FitAddon;
  termEl: HTMLElement;
  /** term.open() has been called on termEl. Hyper opens AFTER the element
   *  is attached to the wrapper — we mirror that to avoid 0×0 renderer
   *  init. The component flips this true once it appendChild's the el. */
  opened: boolean;
  /** A PTY-spawn request has been started for this session. Tracked
   *  independently of `term` newness because in React StrictMode the first
   *  mount can create the registry entry but cancel before createPty fires;
   *  the second mount must still spawn even though the term was reused. */
  ptySpawned: boolean;
}

const registry = new Map<string, RegEntry>();

export interface AcquireResult {
  term: XTerm;
  fitAddon: FitAddon;
  termEl: HTMLElement;
  /** Whether term.open() still needs to be called by the caller. */
  needsOpen: boolean;
  /** Whether the PTY still needs to be spawned by the caller. Setting this
   *  to false (via markPtySpawned) prevents the next acquirer from
   *  spawning. */
  needsSpawn: boolean;
}

export function getOrCreateTerm(sessionId: string, opts: ITerminalOptions): AcquireResult {
  let entry = registry.get(sessionId);
  if (!entry) {
    const term = new XTerm(opts);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const termEl = document.createElement("div");
    termEl.style.width = "100%";
    termEl.style.height = "100%";
    entry = { term, fitAddon, termEl, opened: false, ptySpawned: false };
    registry.set(sessionId, entry);
  }
  return {
    term: entry.term,
    fitAddon: entry.fitAddon,
    termEl: entry.termEl,
    needsOpen: !entry.opened,
    needsSpawn: !entry.ptySpawned,
  };
}

export function markOpened(sessionId: string): void {
  const e = registry.get(sessionId);
  if (e) e.opened = true;
}

export function markPtySpawned(sessionId: string): void {
  const e = registry.get(sessionId);
  if (e) e.ptySpawned = true;
}

export function releaseTerm(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  // Detach DOM if still attached somewhere (defensive — the component
  // should have removed it already during its unmount).
  entry.termEl.parentElement?.removeChild(entry.termEl);
  entry.term.dispose();
  registry.delete(sessionId);
}

export function hasTerm(sessionId: string): boolean {
  return registry.has(sessionId);
}
