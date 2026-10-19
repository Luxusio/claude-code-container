// One wire contract shared by the MCP, host CLI and integration runners.
// Bump for incompatible changes or fixes that require replacing an older broker.
// Package releases alone do not change compatibility.
// Version 8 yields while native generic provider status commands run.
// Replace older daemons before reusing their in-memory adapter implementation.
export const DEVICE_BROKER_PROTOCOL_VERSION = 8;
export function isCompatibleBrokerProtocol(value) {
    return value === DEVICE_BROKER_PROTOCOL_VERSION;
}
