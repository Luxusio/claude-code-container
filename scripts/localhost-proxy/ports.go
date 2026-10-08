package main

// Type parameters preserve the native client pointer and upstream interface,
// including typed nil values, without narrowing through runtime assertions.
type proxyConnectionOwner interface {
	Close() error
}

type proxyRoutingPorts[Client proxyConnectionOwner, Upstream proxyConnectionOwner] struct {
	originalDestinationPort func(Client) (uint16, error)
	connect                 func(string, uint16) (Upstream, error)
	relay                   func(Client, Upstream)
}
