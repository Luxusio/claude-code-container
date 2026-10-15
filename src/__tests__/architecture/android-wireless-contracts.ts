import { createAndroidWirelessApplication } from "../../../packages/device-lab/providers/application/android-wireless.mjs";
import { createDeviceObservation } from "../../../packages/device-lab/providers/application/device-observation.mjs";
import type { AndroidWirelessPorts } from "../../../packages/device-lab/providers/ports/android-wireless.mjs";
import type { AndroidObservationPorts, IosObservationPorts } from "../../../packages/device-lab/providers/ports/device-observation.mjs";

function contracts(ports: AndroidWirelessPorts<object>, android: AndroidObservationPorts, ios: IosObservationPorts) {
    createAndroidWirelessApplication(ports).handle({ action: "status" });
    const { discover, ...withoutDiscovery } = ports;
    // @ts-expect-error native availability and target observations are required
    createAndroidWirelessApplication(withoutDiscovery);
    // @ts-expect-error discovery must settle synchronously
    createAndroidWirelessApplication({ ...ports, discover: async () => ({ available: false }) });
    // @ts-expect-error a raw receipt does not prove a mutation outcome
    createAndroidWirelessApplication({ ...ports, pair: () => ({ status: 0, stdout: "paired" }) });
    // @ts-expect-error pairing observations must settle synchronously
    createAndroidWirelessApplication({ ...ports, pair: async () => ({ ok: true, evidence: {} }) });
    // @ts-expect-error inventory is normalized before it enters policy
    createAndroidWirelessApplication({ ...ports, listDevices: () => ({ status: 0, stdout: "USB device" }) });
    // @ts-expect-error policy has no wire publisher
    createAndroidWirelessApplication({ ...ports, jsonResult: (value: object) => value });
    const { connect, ...withoutConnect } = ports;
    // @ts-expect-error native endpoint connection capability is required
    createAndroidWirelessApplication(withoutConnect);
    // @ts-expect-error AVD line receipts are native adapter input
    createDeviceObservation({ ...android, hostAvds: () => ({ status: 0, stdout: "unit" }) });
    // @ts-expect-error simulator queries must settle synchronously
    createDeviceObservation({ ...ios, simulatorCatalog: async () => ({ ok: true, detail: "", evidence: {} }) });
    // @ts-expect-error SDK simulator DTOs cannot stand in for an owned-target fact
    createDeviceObservation({ ...ios, ownedTarget: () => ({ simulator: { state: "Booted" } }) });
    void [discover, connect];
}
void contracts;
