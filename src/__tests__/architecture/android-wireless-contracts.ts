import { createAndroidWirelessApplication } from "../../../packages/device-lab/providers/application/android-wireless.mjs";
type Ports = Parameters<typeof createAndroidWirelessApplication>[0];
function contracts(ports: Ports) {
    createAndroidWirelessApplication(ports).handle({ action: "status" });
    const { discover, ...withoutDiscovery } = ports;
    // @ts-expect-error native availability and target observations are required
    createAndroidWirelessApplication(withoutDiscovery);
    // @ts-expect-error discovery must settle synchronously
    createAndroidWirelessApplication({ ...ports, discover: async () => ({ available: false }) });
    // @ts-expect-error pairing receipts must settle synchronously
    createAndroidWirelessApplication({ ...ports, pair: async () => ({ status: 0 }) });
    const { connect, ...withoutConnect } = ports;
    // @ts-expect-error native endpoint connection capability is required
    createAndroidWirelessApplication(withoutConnect);
    void [discover, connect];
}
void contracts;
