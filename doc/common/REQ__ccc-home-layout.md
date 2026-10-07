---
type: REQ
status: active
created: 2026-09-27
source: user request ("그리고 .ccc폴더 구조도 싹 한번 정리했으면 좋겠어", "전부다 그냥 프로필 폴더 안으로 넣는건 어때 코덱스랑 클 자체도", "default profile이런식이면 좋지 않겠나"); per-profile codex chosen (option A)
---

# ~/.ccc home layout

The host-side `~/.ccc` directory keeps each account's credentials in one profile
folder, keeps disposable runtime files in one place, and keeps settings in one file.

## Layout

```
~/.ccc/
├── config.json            # settings, including remote configs under "remote"
├── profiles/
│   ├── default/           # the account used without --profile
│   │   ├── claude/        # mounted at /home/ccc/.claude
│   │   ├── claude.json    # mounted at /home/ccc/.claude.json
│   │   └── codex/         # mounted at /home/ccc/.codex
│   └── <name>/            # same three entries per named profile
├── run/                   # disposable: locks/, clipboard.port, clipboard.starting.v2,
│                          # clipboard-files/, bin/
├── devices/               # device lab state (unchanged)
└── device-broker-private/ # host-only broker state (unchanged)
```

Paths inside the container do not change.

## Observable behaviors

1. The account used without `--profile` is the profile `default`.
   - `ccc profile list` shows it.
   - `--profile default` is the same as passing no profile, so the container
     name and `claude --continue` history stay the same.
   - `ccc profile add default` and `ccc profile rm default` are refused.
2. Every profile has its own `codex/`. A named profile that existed before this
   change starts without a codex login and asks for one the first time codex runs.
   The default profile keeps the existing codex login.
3. Session locks, the clipboard bridge port file, clipboard file transfers and the
   macOS clipboard helper live under `run/`. Do not remove mounted runtime files while any running or stopped container
   still references them.
4. `ccc remote` saves a project's remote config in `config.json` under
   `remote.<project-hash>`. Configs saved by older versions in
   `remote/<project-hash>.json` are still read.
5. A new `ccc remote` container mounts a Claude folder that the remote host resolves
   with the same rule as the local one. For the default profile, that is
   `~/.ccc/profiles/default/claude` when that folder is marked as the no-profile
   account, or when the remote host has no older `~/.ccc/claude`, `claude.json` or
   `codex`. Otherwise it is the older `~/.ccc/claude`. A named profile always uses
   `~/.ccc/profiles/<name>/claude`. The remote host's `~/.ccc/remote-runtime` stays
   where it is: it holds the lock that clients of different ccc versions share.

## Migration of an existing ~/.ccc

On the first host-side ccc start after the update, ccc moves the old entries:

| old | new |
|---|---|
| `claude/` | `profiles/default/claude/` |
| `claude.json` | `profiles/default/claude.json` |
| `codex/` | `profiles/default/codex/` |
| `locks/`, `clipboard-files/`, `bin/` | `run/…` |
| `remote/<hash>.json` | `config.json` → `remote.<hash>` |
| `clipboard.port` | renamed to `run/clipboard.port`, retaining its inode |
| `clipboard.starting`, `clipboard.starting.v2` | active ownership defers migration; never removed by migration |

- The migration runs only when no ccc session is running, counting sessions of an
  older ccc that still uses `~/.ccc/locks`. If one is, ccc skips
  it and tries again on a later start. Until then the old paths keep working.
- Migration also waits while any running or stopped container references legacy
  managed mount paths. Failed or unavailable mount inspection is not proof that
  migration is safe. Credentials and clipboard files stay at their original paths.
- Both legacy and v2 clipboard startup locks, in both old and new runtime
  directories, are honored and held during migration. Existing locks defer the
  move; migration never reclaims another startup's ownership.
- The clipboard port file is renamed before other entries, preserving its inode
  and contents. If a different destination port file exists, migration defers
  without replacing either file or moving credentials. Normal clipboard startup
  performs authenticated reuse or serialized retirement; migration does not
  issue asynchronous shutdown. A failed port move defers the remaining moves.
- Each other entry moves on its own. If one move fails (for example Windows refuses to
  rename a folder that a running container still uses), ccc prints one warning
  naming it, keeps using the old path for that entry, and retries later. No
  credential is copied or deleted; entries are renamed.
- If both the old and the new entry exist, ccc uses the new one, leaves the old one
  untouched, and says so once. Such notices are recorded in
  `~/.ccc/run/layout-conflicts`; deleting it shows them one more time.
- A profile the user had named `default` before this layout is not the no-profile
  account. ccc renames it to `default-pre-layout` (or `default-pre-layout-2`, …),
  says so, and then moves the no-profile login into `profiles/default`. Until that
  happens, the no-profile account keeps using the older `~/.ccc/claude`,
  `claude.json` and `codex`. ccc marks the folder
  it owns with `profiles/default/.ccc-default-profile`.
- A `remote/<hash>.json` that is not valid JSON is kept, reported once, and not used.
- If `config.json` is not valid JSON, ccc never overwrites it. The remote configs
  stay in `remote/` and keep working, `ccc --default <tool>` and saving a new
  remote config fail with an error naming the file, and the migration warns on each
  start until the file is fixed or removed.
- Two ccc starts at the same time do not both migrate: one holds
  `~/.ccc/.layout-migration.lock`.
- Existing containers keep their credential mount sources. Migration waits until
  those references are removed through the normal container lifecycle; it never
  forces running or stopped containers to lose their backing paths.
- An older ccc binary run after the migration no longer finds `~/.ccc/claude` and
  asks for a login. The migration is one-way.

## Verification cues

- After one start, `~/.ccc` contains `config.json`, `profiles/`, `run/`, and the
  device folders, and no `claude/`, `claude.json`, `codex/`, `locks/` or `remote/`.
- `ccc profile list` includes `default`.
- `docker inspect <container>` shows `/home/ccc/.codex` mounted from
  `~/.ccc/profiles/<profile>/codex`.
