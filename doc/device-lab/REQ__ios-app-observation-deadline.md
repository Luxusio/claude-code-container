# iOS app observation deadline

An iOS Simulator `wait_for_app` succeeds only when a matching observation
finishes within the operation's wait budget. After each native process probe,
check the remaining budget before accepting a positive result or starting
another probe. Subprocess timeout rounding and decoding time do not extend the
overall deadline.

When the budget expires, retain the existing last clean observation for timeout
diagnostics. Native observation failure remains distinct from a clean no-match.
Keep existing timeout bounds, polling defaults, fallback probes, ownership
checks and public result fields.

Verify with a deterministic composed simulator fixture: advance its clock past
the deadline while a probe returns a valid PID. The result must not report
`running:true`, and no further probe runs. A positive observation completed
within budget must still succeed. Portable fixtures prove budget policy;
acceptance on a real macOS/iOS host requires its separate native run.
