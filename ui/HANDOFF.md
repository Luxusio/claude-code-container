# Handoff: ui
written_at: 2026-04-07T03:05:11Z

## Verification
```bash
echo '{"cmd":"list_containers"}' | /project/claude-code-container-2990bbf949b6/ui/src-sidecar/target/debug/ccc-daemon
```
Expected output: {"data":[],"ok":true} (or a list of ccc-* containers if any are running)

## What changed
Added stdin JSON-RPC dispatch to src-sidecar/src/main.rs. New dispatch_json() function parses a JSON line and routes by "cmd" field. main() now checks stdin first — if a line is present and non-empty it calls dispatch_json() and returns; otherwise falls through to existing CLI args mode. Binary rebuilt; symlink ccc-daemon-aarch64-unknown-linux-gnu updated.

## Do not regress
CLI args mode must still work: /project/claude-code-container-2990bbf949b6/ui/src-sidecar/target/debug/ccc-daemon list_containers should also return {"ok":true,"data":[...]}
