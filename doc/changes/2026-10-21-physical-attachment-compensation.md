# Physical attachment compensation

Failed Android/iOS attachment attempts its exact lease release once
and retains the original failure if release also throws. Broker publication
and cleanup have separate exception boundaries; direct attachment preserves
the primary value and cleanup error in an ordinary `AggregateError`.

The [compensation contract](../device-lab/REQ__physical-attachment-compensation.md)
preserves successor fencing, existing provider-exception behavior and wire
diagnostics. Behavior, built-artifact and independent review/QA evidence are
required before delivery; native physical-device certification is separate.
