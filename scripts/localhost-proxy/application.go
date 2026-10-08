package main

func routeProxyConnection[Client proxyConnectionOwner, Upstream proxyConnectionOwner](client Client, ports proxyRoutingPorts[Client, Upstream]) {
	// Select the ordinary interface method now, including nil-interface panic.
	var clientOwner proxyConnectionOwner = client
	defer clientOwner.Close()
	port, err := ports.originalDestinationPort(client)
	if err != nil || port == 0 {
		return
	}
	upstream, err := ports.connect(localProxyAddress, port)
	if err != nil {
		upstream, err = ports.connect(hostProxyAddress, port)
		if err != nil {
			return
		}
	}
	var upstreamOwner proxyConnectionOwner = upstream
	defer upstreamOwner.Close()
	ports.relay(client, upstream)
}
