// One wire contract shared by the MCP, host CLI and integration runners.
// Bump for incompatible changes or fixes that require replacing an older broker.
// Package releases alone do not change compatibility.
// Version 11 also requires native iOS Shutdown confirmation before stopped publication.
// Version 12 admits macOS snapshot methods with destructive confirmation at the broker.
// Replace older daemons before reusing their in-memory adapter implementation.
export const DEVICE_BROKER_PROTOCOL_VERSION = 12;
export function isCompatibleBrokerProtocol(value) {
    return value === DEVICE_BROKER_PROTOCOL_VERSION;
}
