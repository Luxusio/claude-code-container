import type { DeviceLabToolOutputMap } from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";

declare const session: DeviceLabToolOutputMap["mobile_session_status"];
declare const lifecycle: DeviceLabToolOutputMap["device_start"];

session.deviceId;
lifecycle.device.id;

// These are intentional compile-time regression guards.
// @ts-expect-error mobile_session_status has no nested device object.
session.device.id;
// @ts-expect-error lifecycle responses expose device.id, not a top-level deviceId.
lifecycle.deviceId;
