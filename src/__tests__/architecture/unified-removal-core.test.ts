import { describe, expect, it } from "vitest";
import { createUnifiedWorkspaceRemoval } from "../../application/workspace/unified-removal.js";
import type { UnifiedRemovalPorts, UnifiedRemovalRequest } from "../../ports/workspace/unified-removal.js";
import type { WorkspaceEntry } from "../../domain/workspace/source-entry.js";
export const names = ["scanSource", "destinationPath", "pathExists", "captureSourceIdentity", "captureDestinationFence", "assertWorkspaceIdentity", "assertSourceIdentity", "assertDestinationFence", "metadataExists", "metadataKind", "unreachableRecordedPath", "isTrackedGitlink", "inspectNestedStatus", "worktreeMatches", "pathContent", "unmanagedPathRefusal", "unreadablePathRefusal", "captureDirectoryIdentity", "captureRegistration", "removeRegisteredNested", "relayEntryError", "assertRootOwnership", "inspectRootBranch", "inspectRootStatus", "workspaceName", "sourceName", "removeRegisteredRoot"] as const;
const request: UnifiedRemovalRequest = {
    repositoryPath: "source",
    destinationPath: "workspace",
    branch: "topic",
    options: undefined
};
const a: WorkspaceEntry = {
    name: "a",
    path: "source/a",
    isGitRepo: true
};
const b: WorkspaceEntry = {
    name: "b",
    path: "source/b",
    isGitRepo: true
};
function fixture(entries: WorkspaceEntry[] = [a, b]) {
    const trace: string[] = [];
    const directory = Symbol("directory"), source = Symbol("source"), fence = Symbol("fence"), registration = Symbol("registration"), quarantine = Symbol("quarantine");
    const ports: UnifiedRemovalPorts<symbol, symbol, symbol, symbol, symbol> = {
        scanSource: () => {
            trace.push("scan");
            return entries;
        },
        destinationPath: (_r, n) => `workspace/${n}`,
        pathExists: () => true,
        captureSourceIdentity: p => {
            trace.push(`capture:${p}`);
            return source;
        },
        captureDestinationFence: () => fence,
        assertWorkspaceIdentity: (_r, d) => {
            expect(d).toBe(directory);
            trace.push("workspace");
        },
        assertSourceIdentity: (_s, s) => {
            expect(s).toBe(source);
            trace.push("source");
        },
        assertDestinationFence: (_r, _d, f) => {
            expect(f).toBe(fence);
            trace.push("fence");
        },
        metadataExists: () => false,
        metadataKind: () => "worktree",
        unreachableRecordedPath: () => null,
        isTrackedGitlink: () => false,
        inspectNestedStatus: () => ({
            kind: "observed",
            readContent: () => ""
        }),
        worktreeMatches: () => true,
        pathContent: () => "empty",
        unmanagedPathRefusal: () => "unmanaged",
        unreadablePathRefusal: () => "unreadable",
        captureDirectoryIdentity: () => directory,
        captureRegistration: (r, _s, _d, d) => {
            expect(r.options).toBe(request.options);
            expect(d).toBe(directory);
            trace.push("registration");
            return registration;
        },
        removeRegisteredNested: (_r, s, _d, d, reg, force, si, guard) => {
            expect(d).toBe(directory);
            expect(reg).toBe(registration);
            expect(si).toBe(source);
            expect(force).toBe(false);
            trace.push(`remove:${s}`);
            guard();
        },
        relayEntryError: (n, _d, e) => `${n}:${String(e)}`,
        assertRootOwnership: () => {
            trace.push("ownership");
        },
        inspectRootBranch: () => ({
            failed: false,
            observedBranch: "topic"
        }),
        inspectRootStatus: (_r, es, target, mode) => {
            expect(es).toBe(entries);
            trace.push(`${target.kind}:${"stage" in target ? target.stage : String(target.root === quarantine)}:${mode}`);
            return {
                kind: "observed",
                readContent: () => ""
            };
        },
        workspaceName: () => "workspace",
        sourceName: () => "source",
        removeRegisteredRoot: (_r, d, reg, veto) => {
            expect(d).toBe(directory);
            expect(reg).toBe(registration);
            trace.push("root");
            veto?.(quarantine);
        },
    };
    return {
        ports,
        trace,
        directory,
        quarantine
    };
}
function caught(fn: () => unknown): unknown {
    try {
        fn();
    }
    catch (e) {
        return e;
    }
    throw new Error("Expected throw");
}
describe("unified removal operation", () => {
    it("requires all 27 callable ports without effects", () => {
        const f = fixture();
        createUnifiedWorkspaceRemoval(f.ports);
        for (const n of names)
            for (const v of [undefined, null, 1, {}])
                expect(() => createUnifiedWorkspaceRemoval({
                    ...f.ports,
                    [n]: v
                } as never)).toThrow(TypeError);
        expect(f.trace).toEqual([]);
    });
    it("captures all sources before reverse removal, relays guards and quarantined authority, then publishes mutable results", () => {
        const f = fixture();
        const result = createUnifiedWorkspaceRemoval(f.ports)(request, f.directory);
        expect(result).toEqual({
            removed: ["b", "a", "source"],
            errors: []
        });
        expect(f.trace.slice(0, 5)).toEqual(["scan", "workspace:pre:ordinary", "workspace:pre:ignored", "capture:source/a", "capture:source/b"]);
        expect(f.trace.filter(x => x.startsWith("remove:"))).toEqual(["remove:source/b", "remove:source/a"]);
        expect(f.trace.slice(-4)).toEqual(["registration", "root", "quarantined:true:ordinary", "quarantined:true:ignored"]);
        const index = f.trace.indexOf("remove:source/b");
        expect(f.trace.slice(index + 1, index + 7)).toEqual(["workspace", "source", "fence", "workspace", "source", "fence"]);
        result.removed.push("mutable");
        result.errors = ["mutable"];
    });
    it.each(["scanSource", "destinationPath", "captureSourceIdentity", "captureDirectoryIdentity", "assertRootOwnership", "inspectRootBranch"] as const)("preserves uncaught %s throws", name => {
        const f = fixture();
        const fault = Symbol(name);
        const ports = {
            ...f.ports,
            [name]: () => {
                throw fault;
            }
        };
        expect(caught(() => createUnifiedWorkspaceRemoval(ports)(request, f.directory))).toBe(fault);
        expect(f.trace).not.toContain("root");
    });
    it("first operation guard escapes, while second and post-removal guards relay and prevent publication", () => {
        for (const failAt of [1, 2, 4]) {
            const f = fixture([a]);
            let count = 0;
            const fault = Symbol("guard");
            const ports = {
                ...f.ports,
                assertWorkspaceIdentity: () => {
                    if (++count === failAt)
                        throw fault;
                },
                relayEntryError: (_n: string, _d: string, e: unknown) => {
                    expect(e).toBe(fault);
                    return "guard refused";
                }
            };
            const remove = () => createUnifiedWorkspaceRemoval(ports)(request, f.directory);
            if (failAt === 1)
                expect(caught(remove)).toBe(fault);
            else
                expect(remove()).toEqual({
                    removed: [],
                    errors: ["guard refused"]
                });
            expect(f.trace).not.toContain("root");
        }
    });
    it("continues after per-entry fence failure and retains partial success", () => {
        const f = fixture();
        const ports = {
            ...f.ports,
            captureDestinationFence: (_r: UnifiedRemovalRequest, d: string) => {
                if (d.endsWith("b"))
                    throw new Error("fence changed");
                return Symbol();
            },
            assertDestinationFence: () => {
            }
        };
        expect(createUnifiedWorkspaceRemoval(ports)(request, f.directory)).toEqual({
            removed: ["a"],
            errors: ["b: fence changed"]
        });
        expect(f.trace).not.toContain("root");
    });
    it("only suppresses recognized unreachable metadata failures", () => {
        for (const recognized of [true, false]) {
            const f = fixture([a]);
            const fault = Symbol("metadata");
            const ports = {
                ...f.ports,
                metadataExists: () => true,
                metadataKind: () => {
                    throw fault;
                },
                unreachableRecordedPath: (e: unknown) => {
                    expect(e).toBe(fault);
                    return recognized ? "foreign/path" : null;
                }
            };
            if (recognized)
                expect(createUnifiedWorkspaceRemoval(ports)(request, f.directory).errors).toEqual([]);
            else
                expect(caught(() => createUnifiedWorkspaceRemoval(ports)(request, f.directory))).toBe(fault);
        }
    });
    it("never treats unreadable unmanaged content as deletable under force", () => {
        const f = fixture([a]);
        const ports = {
            ...f.ports,
            worktreeMatches: () => false,
            pathContent: () => "unreadable" as const
        };
        expect(createUnifiedWorkspaceRemoval(ports)({
            ...request,
            options: {
                force: true
            }
        }, f.directory)).toEqual({
            removed: [],
            errors: ["unreadable"]
        });
    });
    it("relay failures escape unchanged", () => {
        const f = fixture([a]);
        const fault = Symbol("relay");
        const ports = {
            ...f.ports,
            captureRegistration: () => {
                throw 1;
            },
            relayEntryError: () => {
                throw fault;
            }
        };
        expect(caught(() => createUnifiedWorkspaceRemoval(ports)(request, f.directory))).toBe(fault);
    });
    it("missing source fences refuse before destination authority, while missing paths are skipped", () => {
        const f = fixture([a]);
        let fences = 0;
        const ports = {
            ...f.ports,
            captureSourceIdentity: () => undefined as unknown as symbol,
            captureDestinationFence: () => {
                fences++;
                return Symbol();
            }
        };
        expect(createUnifiedWorkspaceRemoval(ports)(request, f.directory)).toEqual({
            removed: [],
            errors: ["a: missing source repository fence"]
        });
        expect(fences).toBe(0);
        const absent = {
            ...ports,
            pathExists: () => false
        };
        expect(createUnifiedWorkspaceRemoval(absent)(request, f.directory)).toEqual({
            removed: ["source"],
            errors: []
        });
        expect(fences).toBe(0);
    });
    it("tracked dirty status refuses without nested registration, and force skips its lazy content", () => {
        for (const force of [false, true]) {
            const f = fixture([a]);
            let content = 0;
            let registrations = 0;
            const ports = {
                ...f.ports,
                metadataExists: () => true,
                metadataKind: () => "gitlink" as const,
                isTrackedGitlink: () => true,
                inspectNestedStatus: () => ({
                    kind: "observed" as const,
                    readContent: () => {
                        content++;
                        return "dirty";
                    }
                }),
                captureRegistration: () => {
                    registrations++;
                    return Symbol();
                },
                removeRegisteredRoot: () => {
                }
            };
            const result = createUnifiedWorkspaceRemoval(ports)({
                ...request,
                options: {
                    force
                }
            }, f.directory);
            expect(result).toEqual(force ? {
                removed: ["source"],
                errors: []
            } : {
                removed: [],
                errors: ["a: tracked submodule contains modified or untracked files, use --force to delete it"]
            });
            expect(content).toBe(force ? 0 : 1);
            expect(registrations).toBe(force ? 1 : 0);
        }
    });
    it("reads tracked entry name before lazy failure detail, retaining thrown operand identity", () => {
        const f = fixture([a]);
        const order: string[] = [];
        let armed = false;
        const entry = {
            ...a,
            get name() {
                if (armed)
                    order.push("name");
                return "a";
            }
        };
        const fault = Symbol("detail");
        const ports = {
            ...f.ports,
            scanSource: () => [entry],
            inspectRootStatus: () => ({
                kind: "observed" as const,
                readContent: () => ""
            }),
            metadataExists: () => true,
            metadataKind: () => "gitlink" as const,
            isTrackedGitlink: () => true,
            inspectNestedStatus: () => {
                armed = true;
                return {
                    kind: "failed" as const,
                    readDetail: () => {
                        order.push("detail");
                        throw fault;
                    }
                };
            }
        };
        expect(caught(() => createUnifiedWorkspaceRemoval(ports)(request, f.directory))).toBe(fault);
        expect(order).toEqual(["name", "detail"]);
    });
    it.each(["pre", "final", "quarantined"] as const)("keeps ordinary and ignored %s failure fallback distinct", stage => {
        for (const mode of ["ordinary", "ignored"] as const) {
            const f = fixture([]);
            let count = 0;
            const original = f.ports.inspectRootStatus;
            const ports: typeof f.ports = {
                ...f.ports,
                inspectRootStatus: (r, es, t, m) => {
                    const matches = (stage === "quarantined" ? t.kind === stage : t.kind === "workspace" && t.stage === stage) && m === mode;
                    count++;
                    return matches ? {
                        kind: "failed",
                        readDetail: () => ""
                    } : original(r, es, t, m);
                }
            };
            const result = createUnifiedWorkspaceRemoval(ports)(request, f.directory);
            const prefix = stage === "final" ? "re-inspect" : "inspect";
            expect(result.errors).toEqual([`unable to ${prefix} ${stage === "quarantined" ? "quarantined " : ""}${mode === "ignored" ? "ignored root worktree content" : "root worktree status"}`]);
            expect(count).toBeGreaterThan(0);
        }
    });
    it("strict force skips lazy content but still performs both status observations and selects veto after registration", () => {
        const f = fixture([]);
        const order: string[] = [];
        const options = {
            get force() {
                order.push("force");
                return true;
            }
        };
        const ports = {
            ...f.ports,
            inspectRootStatus: () => ({
                kind: "observed" as const,
                readContent: () => {
                    throw new Error("eager content");
                }
            }),
            captureRegistration: () => {
                order.push("registration");
                return 0;
            },
            removeRegisteredNested: (_r: UnifiedRemovalRequest, _s: string, _d: string, _identity: symbol, _registration: number) => {
                throw new Error("unexpected nested removal");
            },
            removeRegisteredRoot: (_r: UnifiedRemovalRequest, _d: symbol, receipt: number, veto: unknown) => {
                expect(receipt).toBe(0);
                expect(veto).toBeUndefined();
                order.push("remove");
            }
        };
        expect(createUnifiedWorkspaceRemoval(ports)({
            ...request,
            options
        }, f.directory).errors).toEqual([]);
        expect(order.slice(-3)).toEqual(["registration", "force", "remove"]);
    });
    it("retains failed branch's nonempty observed branch diagnostic", () => {
        const f = fixture([]);
        expect(() => createUnifiedWorkspaceRemoval({
            ...f.ports,
            inspectRootBranch: () => ({
                failed: true,
                observedBranch: "other"
            })
        })(request, f.directory)).toThrow("Workspace belongs to branch 'other', not 'topic'.");
    });
    it.each([null, undefined])("preserves raw final catch property access for %s", fault => {
        const f = fixture([]);
        expect(() => createUnifiedWorkspaceRemoval({
            ...f.ports,
            captureRegistration: () => {
                throw fault;
            }
        })(request, f.directory)).toThrow(TypeError);
    });
});
