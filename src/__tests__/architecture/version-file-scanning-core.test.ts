import { describe, expect, it, vi } from "vitest";
import { createVersionFileScanner } from "../../application/tooling/version-file-scanning.js";
import { createVersionScanIgnoredDirectories, extractVersionHints, matchesPattern } from "../../domain/tooling/version-files.js";
import { formatScannedFiles, formatVersionHints } from "../../presentation/tool-version-context.js";
import type { VersionScanEntry, VersionFileScanningPorts } from "../../ports/tooling/version-file-scanning.js";
const request = {
    baseDirectory: "root",
    directory: "root",
    depth: 0,
    maxDepth: 3
};
function fixture(tree: Record<string, VersionScanEntry[]>, fault?: string) {
    const trace: string[] = [];
    const ports: VersionFileScanningPorts = {
        listDirectoryEntries(path) {
            trace.push(`list:${path}`);
            if (fault === `list:${path}`)
                throw Error("list");
            return tree[path] ?? [];
        },
        childPath(dir, name) {
            trace.push(`child:${name}`);
            if (fault === `child:${name}`)
                throw Error("child");
            return `${dir}/${name}`;
        },
        observeFileByteSize(path) {
            trace.push(`size:${path}`);
            if (fault === `size:${path}`)
                throw Error("size");
            return path.includes("large") ? 102401 : 102400;
        },
        readVersionFileText(path) {
            trace.push(`read:${path}`);
            if (fault === `read:${path}`)
                throw Error("read");
            return path;
        },
        sourcePath(base, path) {
            trace.push(`source:${path}`);
            if (fault === `source:${path}`)
                throw Error("source");
            return path.slice(base.length + 1);
        },
    };
    return {
        trace,
        ports
    };
}
function entry(name: string, kind: "file" | "directory" | "other" = "file"): VersionScanEntry {
    return {
        name,
        isDirectory() {
            expect(this.name).toBe(name);
            return kind === "directory";
        },
        isFile() {
            expect(this.name).toBe(name);
            return kind === "file";
        }
    };
}
describe("version discovery through explicit synchronous observations", () => {
    it("constructs without effects and scans unsorted DFS with immediate duplicate merge", () => {
        const f = fixture({
            root: [
                entry(".nvmrc"),
                entry("sub", "directory"),
                entry("go.mod")
            ],
            "root/sub": [
                entry(".node-version"),
                entry("Cargo.toml")
            ]
        });
        const scan = createVersionFileScanner(f.ports, new Set());
        expect(f.trace).toEqual([]);
        expect([
            ...scan(request).keys()
        ]).toEqual([
            ".nvmrc",
            "sub/.node-version",
            "sub/Cargo.toml",
            "go.mod"
        ]);
        expect(f.trace).toEqual([
            "list:root",
            "child:.nvmrc",
            "size:root/.nvmrc",
            "read:root/.nvmrc",
            "source:root/.nvmrc",
            "child:sub",
            "list:root/sub",
            "child:.node-version",
            "size:root/sub/.node-version",
            "read:root/sub/.node-version",
            "source:root/sub/.node-version",
            "child:Cargo.toml",
            "size:root/sub/Cargo.toml",
            "read:root/sub/Cargo.toml",
            "source:root/sub/Cargo.toml",
            "child:go.mod",
            "size:root/go.mod",
            "read:root/go.mod",
            "source:root/go.mod"
        ]);
        const duplicate = createVersionFileScanner({
            ...f.ports,
            sourcePath: () => "same"
        }, new Set());
        expect([
            ...duplicate(request)
        ]).toEqual([
            [
                "same",
                "root/go.mod"
            ]
        ]);
        const first = scan(request);
        first.clear();
        expect(scan(request).size).toBe(4);
    });
    it("keeps the supplied ignored set live and preserves case, hidden and classifier short circuits", () => {
        const ignored = new Set<string>();
        const f = fixture({
            root: [
                entry("skip", "directory"),
                entry("Skip", "directory"),
                entry(".hidden", "directory"),
                entry("link", "other"),
                entry(".nvmrc")
            ],
            "root/Skip": [
                entry("go.mod")
            ]
        });
        const scan = createVersionFileScanner(f.ports, ignored);
        ignored.add("skip");
        expect([
            ...scan(request).keys()
        ]).toEqual([
            "Skip/go.mod",
            ".nvmrc"
        ]);
        expect(f.trace).not.toContain("list:root/skip");
        expect(f.trace).not.toContain("list:root/.hidden");
        expect(f.trace).not.toContain("size:root/link");
        const snapshot = createVersionScanIgnoredDirectories([
            "custom"
        ]);
        for (const name of [
            "custom",
            ".svn",
            ".hg",
            ".gradle",
            ".maven",
            ".venv",
            "venv",
            ".tox",
            ".pytest_cache",
            "Pods",
            ".flutter",
            ".dart_tool",
            ".pub-cache",
            "bin",
            "obj",
            ".vs",
            ".idea"
        ])
            expect(snapshot.has(name)).toBe(true);
        expect(snapshot.has("Custom")).toBe(false);
    });
    it.each([
        [
            -1,
            -2,
            false
        ],
        [
            0,
            0,
            true
        ],
        [
            NaN,
            0,
            true
        ],
        [
            0,
            NaN,
            true
        ],
        [
            Infinity,
            Infinity,
            true
        ]
    ])("uses raw depth comparison %s > %s", (depth, maxDepth, lists) => {
        const f = fixture({
            root: [
                entry(".nvmrc")
            ]
        });
        const result = createVersionFileScanner(f.ports, new Set())({
            ...request,
            depth,
            maxDepth
        });
        expect(f.trace.includes("list:root")).toBe(lists);
        expect(result.size).toBe(lists ? 1 : 0);
    });
    it("reads the inclusive byte limit but never reads oversized files", () => {
        const f = fixture({
            root: [
                entry(".nvmrc"),
                entry("large.csproj")
            ]
        });
        expect([
            ...createVersionFileScanner(f.ports, new Set())(request).keys()
        ]).toEqual([
            ".nvmrc"
        ]);
        expect(f.trace).not.toContain("read:root/large.csproj");
    });
    it.each([
        "size",
        "read",
        "source"
    ])("%s failure skips only that file", boundary => {
        const f = fixture({
            root: [
                entry(".nvmrc"),
                entry("go.mod")
            ]
        }, `${boundary}:root/.nvmrc`);
        expect([
            ...createVersionFileScanner(f.ports, new Set())(request).keys()
        ]).toEqual([
            "go.mod"
        ]);
    });
    it.each([
        "name",
        "directory",
        "file",
        "child"
    ])("%s failure aborts only its directory preserving prior results", boundary => {
        const broken: VersionScanEntry = {
            get name() {
                if (boundary === "name")
                    throw Error("name");
                return "bad.csproj";
            },
            isDirectory() {
                if (boundary === "directory")
                    throw Error("directory");
                return false;
            },
            isFile() {
                if (boundary === "file")
                    throw Error("file");
                return true;
            }
        };
        const f = fixture({
            root: [
                entry("sub", "directory"),
                entry("go.mod")
            ],
            "root/sub": [
                entry(".nvmrc"),
                broken,
                entry("Cargo.toml")
            ]
        }, boundary === "child" ? "child:bad.csproj" : undefined);
        expect([
            ...createVersionFileScanner(f.ports, new Set())(request).keys()
        ]).toEqual([
            "sub/.nvmrc",
            "go.mod"
        ]);
        expect(f.trace).not.toContain("child:Cargo.toml");
    });
    it("does not eagerly classify structural entries or detach member receivers", () => {
        const events: string[] = [];
        const lazy = {
            get name() {
                events.push("name");
                return ".nvmrc";
            },
            isDirectory() {
                expect(this).toBe(lazy);
                events.push("directory");
                return false;
            },
            isFile() {
                expect(this).toBe(lazy);
                events.push("file");
                return true;
            }
        };
        const f = fixture({
            root: [
                lazy
            ]
        });
        createVersionFileScanner(f.ports, new Set())(request);
        expect(events).toEqual([
            "name",
            "directory",
            "file",
            "name"
        ]);
    });
    it("list failure allows parent siblings and required callable validation has no observations", () => {
        const f = fixture({
            root: [
                entry("sub", "directory"),
                entry("go.mod")
            ]
        }, "list:root/sub");
        expect([
            ...createVersionFileScanner(f.ports, new Set())(request).keys()
        ]).toEqual([
            "go.mod"
        ]);
        for (const name of Object.keys(f.ports))
            expect(() => createVersionFileScanner({
                ...f.ports,
                [name]: undefined
            } as unknown as VersionFileScanningPorts, new Set())).toThrow();
    });
    it("Map insertion faults skip a file, while child merge faults abort the parent", () => {
        const f = fixture({
            root: [
                entry(".nvmrc"),
                entry("sub", "directory"),
                entry("go.mod")
            ],
            "root/sub": [
                entry("Cargo.toml")
            ]
        });
        const scan = createVersionFileScanner(f.ports, new Set());
        const original = Map.prototype.set;
        const fileFault = vi.spyOn(Map.prototype, "set").mockImplementation(function(this: Map<unknown, unknown>, key: unknown, value: unknown) {
            if (key === ".nvmrc")
                throw Error("file insertion");
            return original.call(this, key, value);
        });
        let result: Map<string, string>;
        try {
            result = scan(request);
        }
        finally {
            fileFault.mockRestore();
        }
        expect([
            ...result.keys()
        ]).toEqual([
            "sub/Cargo.toml",
            "go.mod"
        ]);
        let occurrences = 0;
        const mergeFault = vi.spyOn(Map.prototype, "set").mockImplementation(function(this: Map<unknown, unknown>, key: unknown, value: unknown) {
            if (key === "sub/Cargo.toml" && ++occurrences === 2)
                throw Error("child merge");
            return original.call(this, key, value);
        });
        try {
            result = scan(request);
        }
        finally {
            mergeFault.mockRestore();
        }
        expect([
            ...result.keys()
        ]).toEqual([
            ".nvmrc"
        ]);
    });
});
describe("version domain and exact prompt bytes", () => {
    it.each([
        "package.json .nvmrc .node-version volta.json .volta.json package-lock.json yarn.lock .yarnrc.yml .npmrc pnpm-lock.yaml deno.json deno.jsonc import_map.json bunfig.toml",
        "pom.xml build.gradle build.gradle.kts gradle.properties gradle-wrapper.properties .java-version .sdkmanrc system.properties settings.gradle.kts settings.gradle build.sbt .scala-version build.properties project.clj deps.edn shadow-cljs.edn",
        "pyproject.toml setup.py setup.cfg requirements.txt Pipfile .python-version runtime.txt environment.yml conda.yaml poetry.lock uv.lock Pipfile.lock",
        "go.mod go.work go.sum Cargo.toml rust-toolchain rust-toolchain.toml build.zig build.zig.zon CMakeLists.txt Makefile configure.ac meson.build conanfile.txt conanfile.py vcpkg.json .clang-version",
        "Gemfile .ruby-version .rvmrc .ruby-gemset Rakefile composer.json .php-version artisan mix.exs .elixir-version .erlang-version rebar.config rebar3.config",
        "Package.swift .swift-version Podfile pubspec.yaml .flutter-version .dart-version analysis_options.yaml app.json metro.config.js global.json .dotnet-version Directory.Build.props nuget.config",
        "stack.yaml cabal.project .ghc-version hie.yaml dune-project dune .ocaml-version .ocamlformat elm.json spago.dhall packages.dhall cpanfile Makefile.PL Build.PL .perl-version .lua-version .luarocks DESCRIPTION .Rversion renv.lock",
        "Project.toml Manifest.toml .terraform-version versions.tf main.tf providers.tf .terraformrc .terraform.lock.hcl ansible.cfg requirements.yml galaxy.yml Pulumi.yaml Pulumi.yml skaffold.yaml kustomization.yaml helmfile.yaml Chart.yaml Dockerfile docker-compose.yml docker-compose.yaml .dockerignore flake.nix shell.nix default.nix .envrc .tool-versions .mise.toml .rtx.toml .asdf"
    ])("preserves inventory %s", names => {
        for (const name of names.split(" "))
            expect(matchesPattern(name), name).toBe(true);
    });
    it("preserves wildcard suffix and exact case matching", () => {
        for (const suffix of [
            ".csproj",
            ".fsproj",
            ".vbproj",
            ".cabal",
            ".opam",
            ".rockspec"
        ]) {
            expect(matchesPattern(suffix)).toBe(true);
            expect(matchesPattern(`a${suffix}`)).toBe(true);
        }
        for (const name of [
            "PACKAGE.JSON",
            "a.csproj.bak",
            "random.txt",
            "sub/package.json"
        ])
            expect(matchesPattern(name)).toBe(false);
    });
    it.each([
        [
            ".nvmrc",
            " v22\r\n",
            "node",
            "22"
        ],
        [
            ".node-version",
            "v20",
            "node",
            "20"
        ],
        [
            ".python-version",
            " 3.12\r\n",
            "python",
            "3.12"
        ],
        [
            ".ruby-version",
            "3.3",
            "ruby",
            "3.3"
        ],
        [
            ".java-version",
            "21",
            "java",
            "temurin-21"
        ],
        [
            "rust-toolchain",
            "stable",
            "rust",
            "stable"
        ],
        [
            ".terraform-version",
            "1.9",
            "terraform",
            "1.9"
        ],
        [
            "package.json",
            '{"engines":{"node":">=18.2 || 20"}}',
            "node",
            "18"
        ],
        [
            "volta.json",
            '{"node":"v22"}',
            "node",
            "22"
        ],
        [
            ".volta.json",
            '{"node":"20"}',
            "node",
            "20"
        ],
        [
            "global.json",
            '{"sdk":{"version":"8.0.100"}}',
            "dotnet",
            "8.0.100"
        ],
        [
            ".sdkmanrc",
            "x=1\r\njava=21-tem\r\n",
            "java",
            "21-tem"
        ],
        [
            "pyproject.toml",
            "requires-python = '>=3.11'",
            "python",
            "3.11"
        ],
        [
            "go.mod",
            "module a\r\ngo 1.22.3\r\n",
            "go",
            "1.22"
        ],
        [
            "Cargo.toml",
            'rust-version = "1.70.1"',
            "rust",
            "1.70"
        ],
        [
            "rust-toolchain.toml",
            'channel = "nightly-2025-01-01"',
            "rust",
            "nightly-2025-01-01"
        ]
    ])("parses %s", (name, content, tool, version) => {
        expect(extractVersionHints(new Map([
            [
                `sub/${name}`,
                content
            ]
        ]))).toEqual([
            {
                tool,
                version,
                source: `sub/${name}`
            }
        ]);
    });
    it("keeps regex limitations, first-tool order, CRLF and input immutability", () => {
        const files = new Map([
            [
                ".tool-versions",
                "node 20\r\npython 3.12 3.11\r\nfoo-bar 1\n ruby 3\nnode 22"
            ],
            [
                ".nvmrc",
                "18"
            ],
            [
                "go.mod",
                " go 1.21"
            ],
            [
                "pyproject.toml",
                'requires-python = "3.11"'
            ]
        ]);
        const before = [
            ...files
        ];
        expect(extractVersionHints(files)).toEqual([
            {
                tool: "node",
                version: "22",
                source: ".tool-versions"
            }
        ]);
        expect([
            ...files
        ]).toEqual(before);
        const lfFiles = new Map(files);
        lfFiles.set(".tool-versions", files.get(".tool-versions")!.replace(/\r\n/g, "\n"));
        expect(extractVersionHints(lfFiles)).toEqual([
            {
                tool: "node",
                version: "20",
                source: ".tool-versions"
            },
            {
                tool: "python",
                version: "3.12 3.11",
                source: ".tool-versions"
            }
        ]);
        expect([
            ...files
        ]).toEqual(before);
        expect(extractVersionHints(new Map([
            [
                "sub\\.nvmrc",
                "22"
            ],
            [
                ".python-version",
                " \r\n"
            ],
            [
                ".nvmrc",
                "v"
            ]
        ]))).toEqual([]);
    });
    it.each([
        "package.json",
        "volta.json",
        ".volta.json",
        "global.json"
    ])("contains malformed JSON failures in %s", name => {
        expect(extractVersionHints(new Map([
            [
                name,
                "{"
            ],
            [
                "go.mod",
                "go 1.23"
            ]
        ]))).toEqual([
            {
                tool: "go",
                version: "1.23",
                source: "go.mod"
            }
        ]);
    });
    it("retains truthy non-string JSON oddities and individual JSON catches", () => {
        for (const value of [
            42,
            true,
            {},
            [
                "8"
            ]
        ]) {
            expect(extractVersionHints(new Map([
                [
                    "global.json",
                    JSON.stringify({
                        sdk: {
                            version: value
                        }
                    })
                ]
            ]))).toEqual([
                {
                    tool: "dotnet",
                    version: value,
                    source: "global.json"
                }
            ]);
            expect(extractVersionHints(new Map([
                [
                    "package.json",
                    JSON.stringify({
                        engines: {
                            node: value
                        }
                    })
                ],
                [
                    "volta.json",
                    JSON.stringify({
                        node: value
                    })
                ]
            ]))).toEqual([]);
        }
        for (const content of [
            "null",
            "{}",
            '{"sdk":{"version":0}}'
        ])
            expect(extractVersionHints(new Map([
                [
                    "global.json",
                    content
                ]
            ]))).toEqual([]);
    });
    it("formats exact ordered bytes and truncates JavaScript code units at 2000", () => {
        expect(formatScannedFiles(new Map())).toBe("No version files found in project.");
        const content = "x".repeat(1999) + "😀";
        const files = new Map([
            [
                "b",
                "y".repeat(2000)
            ],
            [
                "a",
                content
            ]
        ]);
        expect(formatScannedFiles(files)).toBe(`Detected version files:\n\n=== b ===\n${"y".repeat(2000)}\n\n=== a ===\n${content.slice(0, 2000)}\n... (truncated, use Read tool for full content)\n\n`);
        const hints = [
            {
                tool: "python",
                version: "3.12",
                source: "b"
            },
            {
                tool: "node",
                version: "22",
                source: "a"
            }
        ];
        expect(formatVersionHints(hints)).toBe('Pre-extracted versions:\n  python = "3.12" (from b)\n  node = "22" (from a)\n\n');
        expect(formatVersionHints([])).toBe("");
        expect([
            ...files.keys()
        ]).toEqual([
            "b",
            "a"
        ]);
    });
});
