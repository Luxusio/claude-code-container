// Checked by the normal strict architecture compiler; never invoked.
type Ports=Parameters<typeof createAndroidWirelessApplication>[0];

import {createAndroidWirelessApplication} from "../../../packages/device-lab/providers/application/android-wireless.mjs";

function contracts(ports: Ports) {
    const app=createAndroidWirelessApplication(ports);
    app.handle({action:"status",backend:"android-device"});
    const {discover:omitted,...incomplete}=ports;void omitted;
    // @ts-expect-error Native discovery is required; no fallback is installed.
    createAndroidWirelessApplication(incomplete);
    const wrongDiscovery:Ports={...ports,
    // @ts-expect-error Discovery observations are synchronous.
    discover:async()=>({adb:"adb"}),
    };
    const wrongCommand:Ports={...ports,
    // @ts-expect-error Native command observations are synchronous.
    tcpip:async()=>({status:0,stdout:"",stderr:""}),
    };
    const wrongPublication:Ports={...ports,
    // @ts-expect-error Publisher selection returns a callable synchronously.
    selectJsonPublisher:async()=>()=>({}),
    };
    // @ts-expect-error No opaque wireless workflow native port.
    ports.wireless({action:"pair"});

    void [wrongDiscovery, wrongCommand, wrongPublication, app];
}
void contracts;
