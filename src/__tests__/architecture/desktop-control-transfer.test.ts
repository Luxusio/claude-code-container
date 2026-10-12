import { expect, it } from "vitest";
import { createDesktopControlTransfer as create } from "../../../packages/device-lab/providers/application/desktop-control-transfer.mjs";
import type { DesktopArguments } from "../../../packages/device-lab/providers/domain/desktop-control-transfer.mjs";
import type { X11Ports, WindowsPorts, MacosPorts, NativeObservation } from "../../../packages/device-lab/providers/ports/desktop-control-transfer.mjs";
const target = {
    id: "owned"
},
    helper = {
    workspace: "owned"
},
    bridge = {
    host: "guest"
},
    stage = {
    allocation: "stage"
};
type Win = WindowsPorts<typeof target, typeof helper, typeof stage>;
type Mac = MacosPorts<typeof target, typeof bridge, typeof stage>;
const evidence = {
    status: 9,
    stdout: "not parsed",
    response: {
        ok: false
    },
    token: Symbol("opaque")
};
const good: NativeObservation = {
    ok: true,
    evidence
},
    bad: NativeObservation = {
    ok: false,
    evidence
};
const unexpected = (): never => {
    throw new Error("Unexpected native effect");
};
function x11(p: Partial < X11Ports >= {}): X11Ports {
    return {
        variant: "x11",
        windowList: unexpected,
        activateWindow: unexpected,
        activeWindow: unexpected,
        movePointer: unexpected,
        click: unexpected,
        doubleClick: unexpected,
        key: unexpected,
        type: unexpected,
        scroll: unexpected,
        cursorPosition: unexpected,
        drag: unexpected,
        ...p
    };
}
function win(p: Partial<Win> = {}): Win {
    return {
        variant: "windows",
        target: () => target,
        workspace: () => helper,
        guestPath: unexpected,
        inputPath: unexpected,
        outputPath: unexpected,
        stageUpload: unexpected,
        disposeUpload: unexpected,
        click: unexpected,
        doubleClick: unexpected,
        key: unexpected,
        type: unexpected,
        scroll: unexpected,
        drag: unexpected,
        focusWindow: unexpected,
        cursorPosition: unexpected,
        windowList: unexpected,
        upload: unexpected,
        download: unexpected,
        downloadOutput: unexpected,
        copyDownload: unexpected,
        ...p
    };
}
function mac(p: Partial<Mac> = {}): Mac {
    return {
        variant: "macos",
        target: () => target,
        supportsKey: unexpected,
        click: unexpected,
        doubleClick: unexpected,
        key: unexpected,
        type: unexpected,
        scroll: unexpected,
        drag: unexpected,
        focusWindow: unexpected,
        movePointer: unexpected,
        cursorPosition: unexpected,
        windowList: unexpected,
        bridge: unexpected,
        guestPath: unexpected,
        stageInput: unexpected,
        stageOutput: unexpected,
        upload: unexpected,
        download: unexpected,
        commitOutput: unexpected,
        disposeInput: unexpected,
        disposeOutput: unexpected,
        ...p
    };
}
it.each(["activation", "readback", "mismatch", "equal"])("X11 focus %s preserves ordered authority", async mode => {
    const order: string[] = [];
    const app = create(x11({
        activateWindow: (h, t) => {
            expect([h, t]).toEqual(["42", 5000]);
            order.push("activate");
            return mode === "activation" ? bad : good;
        },
        activeWindow: t => {
            expect(t).toBe(5000);
            order.push("readback");
            return {
                ...(mode === "readback" ? bad : good),
                handle : mode === "mismatch" ? "042": "42"
            };
        }
    }));
    const result = await app.handle("display_focus_window", {
        handle: "42"
    });
    expect(order).toEqual(mode === "activation" ? ["activate"]: ["activate", "readback"]);
    expect(result?.kind).toBe(mode === "equal" ? "completed" : mode === "mismatch" ? "refused" : "failed");
    if (result?.kind === "completed" || result?.kind === "failed") expect(result.evidence).toBe(evidence);
});
it.each(["click", "double_click", "key", "type", "scroll", "cursor_position", "move", "drag", "window_list"])("X11 %s consumes named leaves and permissive defaults", async action => {
    const calls: unknown[][] = [];
    const leaf =(...a: unknown[]) => {
        calls.push(a);
        return good;
    };
    const args: DesktopArguments = action === "move" ? {
        x: 1,
        y: 2
    }
    : action === "drag" ? {
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4
    }
    : action === "scroll" ? {
        direction: "up"
    }
    : {};
    const p = x11({
        click: leaf,
        doubleClick: leaf,
        key: leaf,
        type: leaf,
        scroll: leaf,
        cursorPosition: leaf,
        movePointer: leaf,
        drag: leaf,
        windowList: leaf
    });
    const result = await create(p).handle("display_" + action, args);
    expect(result?.kind).toBe("completed");
    if (result?.kind === "completed") expect(result.evidence).toBe(evidence);
    const expected: Record < string,
    unknown[] >= {
        click: [undefined, undefined, "left"],
        double_click: [undefined, undefined, "left"],
        key: [undefined],
        type: [undefined],
        scroll: [undefined, undefined, "up", 3],
        cursor_position: [],
        move: [1, 2],
        drag: [ {
            x1: 1,
            y1: 2,
            x2: 3,
            y2: 4,
            durationMs: 700
        }],
        window_list: [30000]
    };
    expect(calls).toEqual([expected[action]]);
});
it("X11 refuses strict input and leaves other actions unhandled", async () => {
    const app = create(x11());
    for (const[name, args] of[["display_move", {
        x: 1.5,
        y: 2
    }], ["display_drag", {
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        durationMs: 0
    }], ["display_focus_window", {
        handle: "0"
    }], ["display_scroll", {
        direction: "diagonal"
    }]] as[string, DesktopArguments][]) expect((await app.handle(name, args))?.kind).toBe("refused");
    expect(await app.handle("device_upload", {})).toBeUndefined();
    expect(await app.handle("unknown", {})).toBeUndefined();
});
it.each([0, 90000, 123])("X11 list bounds requested timeout %s", async requested => {
    let timeout = 0;
    await create(x11({
        windowList: t => {
            timeout = t;
            return good;
        }
    })).handle("display_window_list", {
        helperTimeoutMs: requested
    });
    expect(timeout).toBe(requested === 123 ? 123: 30000);
});
it.each(["windows", "macos"] as const)("%s click preserves numeric coercion", async platform => {
    const calls: unknown[][] = [];
    const leaf =(...a: unknown[]) => {
        calls.push(a);
        return good;
    };
    const p = platform === "windows" ? win({
        click: async (...a) => leaf(...a)
    }): mac({
        click: leaf
    });
    // External numeric input is deliberately coerced by these two platforms.
    const args = {
        x: "2",
        y: "3",
        helperTimeoutMs: 123
    }
    as unknown as DesktopArguments;
    expect((await create(p).handle("device_click", args))?.kind).toBe("completed");
    expect(calls).toEqual([[target, 2, 3, "left", 123]]);
});
it("Windows upload staging refusal cannot transfer or dispose an unallocated handle", async () => {
    const app = create(win({
        guestPath: () => ({
            ok: true,
            path: "remote"
        }),
        inputPath: () => ({
            ok: true,
            path: "local"
        }),
        stageUpload: () => ({
            ok: false,
            message: "stage-denied"
        })
    }));
    expect(await app.handle("device_upload", {})).toEqual({
        kind : "refused",
        message: "stage-denied"
    });
});
it.each(["windows", "macos"] as const)("%s dispatches all controls, preserves defaults and opaque evidence", async platform => {
    const calls: unknown[][] = [];
    const leaf =(...a: unknown[]) => {
        calls.push(a);
        return good;
    };
    const asyncLeaf = async (...a: unknown[]) => leaf(...a);
    const p = platform === "windows" ? win({
        click: asyncLeaf,
        doubleClick: asyncLeaf,
        key: asyncLeaf,
        type: asyncLeaf,
        scroll: asyncLeaf,
        drag: asyncLeaf,
        focusWindow: asyncLeaf,
        cursorPosition: asyncLeaf,
        windowList: asyncLeaf
    }): mac({
        supportsKey: () => true,
        click: leaf,
        doubleClick: leaf,
        key: leaf,
        type: leaf,
        scroll: leaf,
        drag: leaf,
        focusWindow: (...a) => ({
            ...leaf(...a),
            verified: true
        }),
        movePointer: leaf,
        cursorPosition: leaf,
        windowList: leaf
    });
    const handle = platform === "windows" ? "42": "macos:1:2:Editor";
    const rows: [string, DesktopArguments, unknown[]][] = [["click", {
        x: 2,
        y: 3
    }, [target, 2, 3, "left", undefined]], ["double_click", {
        x: 2,
        y: 3,
        button: "right"
    }, [target, 2, 3, "right", undefined]], ["key", {
        key: "Enter"
    }, [target, "Enter", undefined]], ["type", {
        text: "A+{B}"
    }, [target, "A+{B}", undefined]], ["scroll", {
        x: 2,
        y: 3,
        amount: 0
    }, platform === "windows" ? [target, 2, 3, "down", 1, undefined]: [target, "down", 1, undefined]], ["drag", {
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4
    }, [target, {
        x1: 1,
        y1: 2,
        x2: 3,
        y2: 4,
        durationMs: 700
    }, undefined]], ["focus_window", {
        handle
    }, [target, handle, undefined]], ["cursor_position", {}, platform === "windows" ? [target, undefined, undefined, undefined]: [target, undefined]], ["cursor_position", {
        x: 2,
        y: 3
    }, [target, 2, 3, undefined]], ["window_list", {
        helperTimeoutMs: 123
    }, [target, 123]]];
    for (const[action, args, expected] of rows) {
        const result = await create(p).handle("device_" + action, args);
        expect(result?.kind).toBe("completed");
        if (result?.kind === "completed") expect(result.evidence).toBe(evidence);
        expect(calls.pop()).toEqual(expected);
    }
    expect((await create(p).handle("device_scroll", {}))?.kind).toBe(platform === "windows" ? "refused" : "completed");
});
it.each(["windows", "macos"] as const)("%s refuses invalid controls and leaves unowned targets unhandled", async platform => {
    const p = platform === "windows" ? win(): mac();
    const app = create(p);
    for (const[name, args] of[["device_click", {}], ["device_type", {
        text: null
    }], ["device_scroll", {
        x: 1,
        y: 2,
        direction: "diagonal"
    }], ["device_drag", {
        x1: - 1,
        y1: 0,
        x2: 1,
        y2: 1
    }], ["device_cursor_position", {
        x: 1
    }], ["device_focus_window", {
        handle: "0"
    }]] as[string, DesktopArguments][]) expect((await app.handle(name, args))?.kind).toBe("refused");
    expect(await app.handle("unknown", {})).toBeUndefined();
    expect(await create(platform === "windows" ? win({
        target: () => undefined
    }): mac({
        target: () => undefined
    })).handle("device_key", {
        key: "Enter"
    })).toBeUndefined();
});
it("macOS unsupported key and unverified focus refuse before unrelated effects", async () => {
    expect(await create(mac({
        supportsKey: () => false
    })).handle("device_key", {
        key: "Super+Enter"
    })).toEqual({
        kind : "refused",
        message: "Unsupported macOS key expression: Super+Enter"
    });
    expect(await create(mac({
        focusWindow: () => ({
            ...good,
            verified: false
        })
    })).handle("device_focus_window", {
        handle: "macos:1:2:Editor"
    })).toEqual({
        kind : "refused",
        message: "window-focus-unverified"
    });
    expect((await create(mac({
        focusWindow: () => ({
            ...bad,
            verified: true
        })
    })).handle("device_focus_window", {
        handle: "macos:1:2:Editor"
    }))?.kind).toBe("failed");
});
it.each(["upload", "download"] as const)("Windows %s admits guest before local, with no premature allocation", async action => {
    for (const denied of["guest", "local"]) {
        const order: string[] = [];
        const local = () => {
            order.push("local");
            return {
                ok: false as const,
                message: "local-denied"
            };
        };
        const app = create(win({
            workspace: () => {
                order.push("workspace");
                return helper;
            },
            guestPath: () => {
                order.push("guest");
                return denied === "guest" ? {
                    ok: false,
                    message: "guest-denied"
                }
                : {
                    ok: true,
                    path: "remote"
                };
            },
            inputPath: local,
            outputPath: local
        }));
        expect(await app.handle("device_" + action, {})).toEqual({
            kind : "refused",
            message: denied + "-denied"
        });
        expect(order).toEqual(denied === "guest" ? ["workspace", "guest"]: ["workspace", "guest", "local"]);
    }
});
it.each(["success", "refusal", "rejection", "throw"])("Windows upload retains stage until %s settles", async mode => {
    const order: string[] = [];
    let live = false;
    let resolve !: (r: NativeObservation) => void,
    reject !: (e: Error) => void;
    const boom = new Error("transfer");
    const deferred = new Promise < NativeObservation >((yes, no) => {
        resolve = yes;
        reject = no;
    });
    const app = create(win({
        guestPath: () => ({
            ok: true,
            path: "remote"
        }),
        inputPath: () => ({
            ok: true,
            path: "local"
        }),
        stageUpload: (h, p) => {
            expect([h, p]).toEqual([helper, "local"]);
            live = true;
            order.push("stage");
            return {
                ok: true,
                handle: stage,
                guestPath: "staged"
            };
        },
        upload: (t, s, r) => {
            expect([t, s, r, live]).toEqual([target, "staged", "remote", true]);
            order.push("upload");
            if (mode === "throw") throw boom;
            return deferred;
        },
        disposeUpload: h => {
            expect(h).toBe(stage);
            expect(live).toBe(true);
            live = false;
            order.push("dispose");
            return undefined;
        }
    }));
    const pending = app.handle("device_upload", {});
    if (mode === "throw") await expect(pending).rejects.toBe(boom);
    else {
        expect(live).toBe(true);
        expect(order).toEqual(["stage", "upload"]);
        if (mode === "rejection") reject(boom);
        else resolve(mode === "success" ? good : bad);
        if (mode === "rejection") await expect(pending).rejects.toBe(boom);
        else expect((await pending)?.kind).toBe(mode === "success" ? "completed" : "failed");
    }
    expect(live).toBe(false);
    expect(order).toEqual(["stage", "upload", "dispose"]);
});
it.each(["transfer", "unsafe", "missing", "copy", "success"])("Windows download %s gates output and bounded copy", async mode => {
    const order: string[] = [];
    const app = create(win({
        guestPath: () => ({
            ok: true,
            path: "remote"
        }),
        outputPath: () => ({
            ok: true,
            path: "local"
        }),
        download: async () => {
            order.push("download");
            return mode === "transfer" ? bad : good;
        },
        downloadOutput: (e, r) => {
            expect(e).toBe(evidence);
            expect(r).toBe("remote");
            order.push("output");
            return mode === "unsafe" || mode === "missing" ? {
                ok: false
            }
            : {
                ok: true,
                path: "safe"
            };
        },
        copyDownload: (s, d) => {
            expect([s, d]).toEqual(["safe", "local"]);
            order.push("copy");
            return mode === "copy" ? bad : good;
        }
    }));
    const result = await app.handle("device_download", {});
    expect(result?.kind).toBe(mode === "success" ? "completed" : mode === "unsafe" || mode === "missing" ? "refused" : "failed");
    expect(order).toEqual(mode === "transfer" ? ["download"] : mode === "unsafe" || mode === "missing" ? ["download", "output"]: ["download", "output", "copy"]);
});
it.each(["upload", "download"] as const)("macOS %s admits bridge then guest then stage", async action => {
    for (const denied of["bridge", "guest", "stage"]) {
        const order: string[] = [];
        const allocate = () => {
            order.push("stage");
            return {
                ok: false as const,
                message: "stage-denied"
            };
        };
        const app = create(mac({
            bridge: (t, n) => {
                expect([t, n]).toEqual([target, "device_" + action]);
                order.push("bridge");
                return denied === "bridge" ? {
                    ok: false,
                    evidence
                }
                : {
                    ok: true,
                    bridge
                };
            },
            guestPath: () => {
                order.push("guest");
                return denied === "guest" ? {
                    ok: false,
                    message: "guest-denied"
                }
                : {
                    ok: true,
                    path: "remote"
                };
            },
            stageInput: allocate,
            stageOutput: allocate
        }));
        expect((await app.handle("device_" + action, {}))?.kind).toBe(denied === "bridge" ? "failed" : "refused");
        expect(order).toEqual(denied === "bridge" ? ["bridge"]: denied === "guest" ? ["bridge", "guest"]: ["bridge", "guest", "stage"]);
    }
});
it.each(["transfer-failed", "transfer-throw", "commit-refused", "commit-throw", "success"])("macOS download %s finally removes stage", async mode => {
    const order: string[] = [];
    let live = false;
    const boom = new Error("native throw");
    const app = create(mac({
        bridge: () => ({
            ok: true,
            bridge
        }),
        guestPath: () => ({
            ok: true,
            path: "remote"
        }),
        stageOutput: () => {
            live = true;
            order.push("stage");
            return {
                ok: true,
                path: "requested",
                stagedPath: "temporary",
                handle: stage
            };
        },
        download: (t, b, r, s) => {
            expect([t, b, r, s, live]).toEqual([target, bridge, "remote", "temporary", true]);
            order.push("transfer");
            if (mode === "transfer-throw") throw boom;
            return mode === "transfer-failed" ? bad : good;
        },
        commitOutput: h => {
            expect(h).toBe(stage);
            expect(live).toBe(true);
            order.push("commit");
            if (mode === "commit-throw") throw boom;
            return mode === "commit-refused" ? {
                ok: false,
                message: "publication-denied"
            }
            : {
                ok: true,
                path: "committed-logical"
            };
        },
        disposeOutput: h => {
            expect(h).toBe(stage);
            live = false;
            order.push("dispose");
            return undefined;
        }
    }));
    const pending = app.handle("device_download", {});
    if (mode.endsWith("throw")) await expect(pending).rejects.toBe(boom);
    else {
        const result = await pending;
        expect(result?.kind).toBe(mode === "success" ? "completed" : mode === "commit-refused" ? "refused" : "failed");
        if (result?.kind === "completed") {
            expect(result.args.localPath).toBe("committed-logical");
            expect(result.evidence).toBe(evidence);
        }
    }
    expect(live).toBe(false);
    expect(order).toEqual(mode.startsWith("transfer-") ? ["stage", "transfer", "dispose"]: ["stage", "transfer", "commit", "dispose"]);
});
it.each(["success", "failure", "throw"])("macOS upload %s disposes input after transfer", async mode => {
    const order: string[] = [];
    const boom = new Error("upload throw");
    const app = create(mac({
        bridge: () => ({
            ok: true,
            bridge
        }),
        guestPath: () => ({
            ok: true,
            path: "remote"
        }),
        stageInput: () => {
            order.push("stage");
            return {
                ok: true,
                path: "logical",
                stagedPath: "temporary",
                handle: stage
            };
        },
        upload: (t, b, s, r) => {
            expect([t, b, s, r]).toEqual([target, bridge, "temporary", "remote"]);
            order.push("transfer");
            if (mode === "throw") throw boom;
            return mode === "failure" ? bad : good;
        },
        disposeInput: h => {
            expect(h).toBe(stage);
            order.push("dispose");
            return undefined;
        }
    }));
    const pending = app.handle("device_upload", {});
    if (mode === "throw") await expect(pending).rejects.toBe(boom);
    else expect((await pending)?.kind).toBe(mode === "success" ? "completed" : "failed");
    expect(order).toEqual(["stage", "transfer", "dispose"]);
});
