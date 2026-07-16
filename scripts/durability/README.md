# Device-lab durability test

Run the non-destructive broker soak test with:

```sh
npm run test:durability:device-lab
```

The default run performs 100 rounds with eight concurrent requests. Each round
exercises broker health, status, authenticated status RPC, and authenticated
echo RPC. Requests and response bodies are bounded.

Use command-line options to change the workload without configuring environment
variables:

```sh
npm run test:durability:device-lab -- --duration 10m --concurrency 16
npm run test:durability:device-lab -- --iterations 1000 --timeout 5s
npm run test:durability:device-lab -- --iterations 500 --restart-every 25
```

`--restart-every N` forcibly stops only the broker process tree created by the
runner, then starts a new broker on the same port and isolated state directory.
The next generation must have a different PID while retaining the same owner
identity and authentication token, and an authenticated echo RPC must succeed.
Forced restarts are disabled by default.

Process ownership is tracked by PID plus an OS start token, not PID alone.
Linux uses `/proc` start ticks and Windows uses CIM creation timestamps. The
runner samples descendants during every round, restart, and final cleanup so a
reparented process remains attributable. A reused PID is never probed or
signaled as the old process. Platforms without a strong start token fail closed
before running instead of using coarse timestamps.

The runner also checks for practical process and memory leaks:

- `--max-rss-growth 128MiB` limits RSS growth within each broker generation.
  The default is 128MiB; use `0` to disable RSS checks.
- `--rss-sample-every 10` changes the RSS sampling interval in rounds. RSS is
  also sampled before every restart and final cleanup.
- `--max-survivors 0` requires every observed runner-owned process to be gone
  after cleanup. Use `-1` to disable the final assertion while retaining
  best-effort process-tree cleanup.

The test starts a dedicated broker on an ephemeral port with an isolated
temporary home directory. It does not start, stop, create, delete, or mutate
devices. Cleanup targets only the broker process and temporary state created by
the current run. Existing CCC brokers, device records, emulators, physical
devices, sandboxes, and virtual machines are not used or modified.

The isolated home is deleted only after the run and its cleanup both succeed.
On a request, restart, process-cleanup, or filesystem-cleanup failure, the home
is preserved and the final error prints its artifact path. Broker stderr, owner
authentication files, runtime metadata, and logs therefore remain available
for diagnosis.

Repository and installed-package execution use `scripts/durability/run.mjs`.
The launcher rebuilds only when both `src/` and `tsconfig.json` identify a
source checkout. In an installed npm package it requires the shipped
`dist/index.js`, skips build, and forwards all remaining CLI arguments. The
package scripts should integrate it as follows:

```json
{
  "test:durability:device-lab": "node scripts/durability/run.mjs broker",
  "test:durability:device-lab:real": "node scripts/durability/run.mjs real"
}
```

Destructive and physical-provider repetition is intentionally a separate
command. See [REAL_PROVIDER_CYCLES.md](./REAL_PROVIDER_CYCLES.md) before running
`npm run test:durability:device-lab:real`.
