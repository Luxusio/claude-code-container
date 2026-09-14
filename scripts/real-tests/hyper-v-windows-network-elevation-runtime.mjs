// Kept as a tiny bundle-only bridge so the standalone network proof packages the same
// elevated session transport as production without importing a stale dist/ copy.
export { withElevatedHyperVNetworkExecutor } from "../../src/device-lab/broker/hyper-v/elevated-network-session.ts";
