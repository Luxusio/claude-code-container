# Current X11 display input and capability contract

This repair derives from [unified display control](REQ__unified-display-control.md),
the public desktop key/flow contract in [minimal output](REQ__minimal-output.md),
and the architecture SPEC's [Control boundary](../common/SPEC__ccc-architecture-contracts.md#required-ports).
It corrects reported false success, focus advertisement and unsupported-device
routing without adding a provider, display-selection mechanism or isolation claim.

The X11 native facade translates public desktop aliases to X11 key names:
`Enter` to `Return`, `Backspace` to `BackSpace`, and `ArrowUp`, `ArrowDown`,
`ArrowLeft`, `ArrowRight` to `Up`, `Down`, `Left`, `Right`. Translation also
applies to known components of modifier combinations. Other native expressions
remain supported by xdotool. Arguments remain separate values with the existing
option terminator; key text never becomes a shell command.

xdotool can report an unknown key name as ignored while returning exit zero.
That specific diagnostic is a failed key operation and the public MCP result
must have `isError:true`. Nonempty stderr alone does not imply failure. A failed
key stops an ordinary `run_flow`; only explicit `stopOnError:false` permits the
following step. A successful command receipt alone does not prove a delivered
key event: the native regression must observe the event in an owned window.

Current-display focus is advertised only when a bounded, nonmutating native
`getactivewindow` probe succeeds and returns a valid positive window handle.
The existing synchronous access port may optionally provide this fact; absence
means focus is not established. Other display capabilities and availability
retain their meanings. A failed or malformed probe does not by itself establish
that no window manager exists. Discovery is not lasting focus authority: an
actual focus request still requires successful activation followed by exact
target-handle readback, and failures remain errors.

The reserved `x11-current-display` ID identifies the local display. Required-device
tools that it does not implement, including `exec` and `ui`, return the existing
`device-tool-unsupported` diagnostic locally, before broker, provider or stored
device discovery. Existing backend mismatch and `list-files-unsupported` results
remain distinct. Explicit broker flags do not make this local ID a broker device.
Do not add unsupported operations to the display capability map.

## Verification and limits

Behavioral tests cover aliases, native expressions, ignored-key failure, benign
stderr, public key/flow results, optional focus facts and unsupported routing.
The native test uses its own Xvfb server and window, proves `Return` as a positive
control, then observes the event for `Enter` and refusal for invalid input.
It also verifies focus is not advertised on that display without a supporting WM.
Source, bundled and extracted MCP consumers must retain these public outcomes.

The provider currently selects `:99`; inherited `DISPLAY` alone does not isolate
tests because command construction supplies that value. Source tests must use
the existing command environment option for their allocated display. Bundled
checks may use private native-command wrappers. Never input into shared `:99`,
and dispose only the fixture's own window, display and child processes.

This repair does not provide per-window leases or prove isolation among agents
sharing a display. It does not complete another application's blocked desktop QA,
native macOS clone/cleanup acceptance or the full architecture migration.
