# Monotonic observation wait budget

Android, iOS and broker observation waits share one monotonic deadline. Each
pause waits until the earlier of its interval target and that original deadline.
An early timer callback must recheck the same target and wait the remaining
time; it must not start another observation early or reset the interval.

An expired budget schedules no timer. A callback that reaches or overshoots
the target needs no further sleep. Request allowances, normalization, provider
errors and the distinction between failed observations and completed absence
remain unchanged. Timer correction must not extend the overall deadline.

Verification uses deterministic early, repeated early, on-time, overshooting,
fractional final and expired timer callbacks. Provider regression tests retain
their existing errors and absence assertions. Hyper-V readiness ordering tests
use the existing clock and sleep ports so scheduler load cannot change the
scrub, detach, ISO deletion and network-mismatch assertion.

Historical full-suite failures require fresh full-suite evidence before being
declared resolved. Portable fixtures do not certify native device readiness.
