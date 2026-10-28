# iOS app observation deadline

An iOS Simulator `wait_for_app` succeeds only when a matching observation
finishes within the operation's wait budget. After each native process probe,
check the remaining budget before accepting a positive result or starting
another probe. Subprocess timeout rounding and decoding time do not extend the
overall deadline.

When the budget expires, retain the existing last clean observation for timeout
diagnostics. Native observation failure remains distinct from a clean no-match.
Keep existing timeout bounds, polling defaults, ownership checks and public
result fields.

First query `simctl spawn <verified-owned-target> launchctl list` in the
Simulator's default bootstrap namespace. The Oct28 native host observation
returned Safari as `30323 0 UIKitApplication:com.apple.mobilesafari[244c][rb-legacy]`.
Parse a valid `PID Status Label` table and require a positive safe integer PID
with the exact requested UIKit application bundle label and bracket suffix.
Registered services with `-` or zero PID, neighboring bundle names and malformed
tables do not prove the application is running. Omit the table's raw output
from clean observation results.

A clean list with no matching running row is an authoritative no-match for
that sweep. Pause within the same budget; do not let legacy service-description
substring matches override it. If the list command or its table fails, retain
the existing process and service-domain fallback probes. Every command still
uses only the current remaining allowance, and late positive rows are refused.

Verify with a deterministic composed simulator fixture: advance its clock past
the deadline while a probe returns a valid PID. The result must not report
`running:true`, and no further probe runs. A positive observation completed
within budget must still succeed. Portable fixtures prove budget policy;
acceptance on a real macOS/iOS host requires its separate native run.
