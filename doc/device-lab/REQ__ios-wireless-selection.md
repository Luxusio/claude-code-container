# iOS wireless selection through the default broker child

Authenticated `broker.device.tool.invoke` requests for `device_wireless` with backend `ios-device` must forward the supplied `udid` to the actual default backend child. Status is read-only and does not require an attached record. The provider must select that exact visible device, distinguish USB from Wi-Fi using inventory connection markers, and return `selected: null` when the requested UDID is absent. Without a selected device, the existing any-visible-Wi-Fi rule remains unchanged.

This forwarding does not grant pairing, trust bypass, lease acquisition, attachment, session allocation or lifecycle mutation. Public MCP early action refusal and brokerApple trust diagnostics remain distinct APIs. Existing authentication, owner isolation and child execution authority remain required.

Acceptance uses the real authenticated default child with a controlled xcrun inventory: selected Wi-Fi and USB outcomes, absent selection, and non-status refusal without native pairing commands. Native macOS/Apple hardware acceptance is separate.
