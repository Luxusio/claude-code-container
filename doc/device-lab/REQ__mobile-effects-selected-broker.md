# Mobile effects use the admitted broker

When Device Lab admits a mobile operation through an Appium session, every
native effect in that operation must use the broker selected by that admission.
The follow-up effects must not launch another broker or rediscover a different
host. This applies to single effects and sequences such as Android rotation.

The application keeps the existing effect order and stops when an effect fails.
The public failure preserves the broker receipt and dispatches no later effect.
Native requests, authentication, ownership guards and response envelopes retain
their existing contracts.

Verify selection with an admission selecting a host and port different from the
initial candidates: all follow-up effects use that selection with autolaunch
disabled. Verify failure with a real local broker RPC refusal: only the first
effect is dispatched and its failure receipt reaches the public MCP result.

These portable checks do not establish live device or installed native-host
acceptance.
