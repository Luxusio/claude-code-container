package main

import (
	"errors"
	"reflect"
	"testing"
)

type traceOwner struct {
	name string
	events *[]string
	closePanic any
}
func (owner *traceOwner) Close() error {
	*owner.events = append(*owner.events, "close:"+owner.name)
	if owner.closePanic != nil { panic(owner.closePanic) }
	return errors.New("ignored close failure")
}

func TestRoutingPolicyOrdering(t *testing.T) {
	for _, mode := range []string{"local", "fallback", "both-fail", "metadata-error", "zero", "relay-panic", "metadata-panic", "connect-panic", "close-panic"} {
		t.Run(mode, func(t *testing.T) {
			events := []string{}
			client := &traceOwner{name:"client", events:&events}
			upstream := &traceOwner{name:"upstream", events:&events}
			raw := &struct{ mode string }{mode}
			if mode == "close-panic" { upstream.closePanic = raw }
			attempt := 0
			ports := proxyRoutingPorts[*traceOwner, *traceOwner]{
				originalDestinationPort: func(owned *traceOwner) (uint16, error) {
					if owned != client { t.Fatal("client identity replaced") }; events = append(events, "metadata")
					if mode == "metadata-panic" { panic(raw) }
					if mode == "metadata-error" { return 123, errors.New("raw metadata") }
					if mode == "zero" { return 0, nil }; return 123, nil
				},
				connect: func(host string, port uint16) (*traceOwner, error) {
					if port != 123 { t.Fatalf("port %d", port) }; events = append(events, "dial:"+host); attempt++
					if mode == "connect-panic" { panic(raw) }
					if mode == "both-fail" || (mode == "fallback" && attempt == 1) { return upstream, errors.New("any local rejection") }
					return upstream, nil
				},
				relay: func(owned *traceOwner, peer *traceOwner) {
					if owned != client || peer != upstream { t.Fatal("relay identity replaced") }; events = append(events, "relay")
					if mode == "relay-panic" { panic(raw) }
				},
			}
			var recovered any
			func() { defer func() { recovered = recover() }(); routeProxyConnection(client, ports) }()
			want := []string{"metadata"}
			switch mode {
			case "metadata-error", "zero", "metadata-panic":
			case "connect-panic": want = append(want, "dial:127.0.0.1")
			case "both-fail": want = append(want, "dial:127.0.0.1", "dial:host.docker.internal")
			default:
				want = append(want, "dial:127.0.0.1")
				if mode == "fallback" { want = append(want, "dial:host.docker.internal") }
				want = append(want, "relay", "close:upstream")
			}
			want = append(want, "close:client")
			if !reflect.DeepEqual(events, want) { t.Fatalf("trace\n got %v\nwant %v", events, want) }
			panicExpected := mode == "relay-panic" || mode == "metadata-panic" || mode == "connect-panic" || mode == "close-panic"
			if panicExpected && recovered != raw { t.Fatalf("lost raw panic identity: %v", recovered) }
			if !panicExpected && recovered != nil { t.Fatalf("unexpected panic: %v", recovered) }
		})
	}
}
