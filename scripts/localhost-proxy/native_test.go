package main

import (
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Keep the actual baseline/candidate handleConn business body. Only effect
// helpers and native connection carrier names are replaced in private modules.
func handleBody(t *testing.T, source string) string {
	return nativeBody(t, source, "handleConn")
}
func nativeBody(t *testing.T, source string, name string) string {
	t.Helper(); start := strings.Index(source, "func "+name+"(")
	if start < 0 { t.Fatal("actual handleConn missing") }
	open := strings.Index(source[start:], "{") + start; depth := 1
	for index := open+1; index < len(source); index++ {
		if source[index] == '{' { depth++ }; if source[index] == '}' { depth-- }
		if depth == 0 { return source[start:index+1] }
	}; t.Fatal("unterminated actual handleConn"); return ""
}

const handleEffectsHarness = `
package main
import ("fmt"; "errors"; "strings")
type harnessUpstream interface { Close() error }
type harnessOwner struct { name string }
var events []string
var mode string
var raw = &struct{ marker string }{"raw"}
var calls int
func (owner *harnessOwner) Close() error {
 if owner == nil { events=append(events,"close:typed-nil"); panic(raw) }
 events=append(events,"close:"+owner.name)
 if mode=="close-panic" && owner.name=="upstream" { panic(raw) }
 return errors.New("ignored-close")
}
func getOriginalDstPort(client *harnessOwner) (uint16,error) {
 events=append(events,"metadata")
 if mode=="metadata-panic" { panic(raw) }
 if mode=="metadata-error" { return 123,errors.New("metadata") }
 if mode=="zero" { return 0,nil }; return 123,nil
}
func tryConnect(host string,port uint16) (harnessUpstream,error) {
 events=append(events,fmt.Sprintf("dial:%s:%d",host,port)); calls++
 if mode=="connect-panic" { panic(raw) }
 if mode=="both-fail" || (mode=="fallback" && calls==1) { return &harnessOwner{"failed-survivor"},errors.New("any-error") }
 if mode=="nil-interface" { return nil,nil }
 if mode=="typed-nil" { var value *harnessOwner; return value,nil }
 return &harnessOwner{"upstream"},nil
}
func pipe(client *harnessOwner,upstream harnessUpstream) {
 events=append(events,"relay")
 if mode=="relay-panic" { panic(raw) }
}
func main() {
 for _, name := range []string{"local","fallback","both-fail","metadata-error","zero","relay-panic","metadata-panic","connect-panic","close-panic","nil-interface","typed-nil"} {
  mode=name; events=nil; calls=0; var failure any
  func(){defer func(){failure=recover()}(); handleConn(&harnessOwner{"client"})}()
  outcome:="none"; if failure==raw {outcome="raw"} else if failure!=nil {outcome="native-panic"}
  fmt.Printf("%s|%s|%s\n",name,strings.Join(events,","),outcome)
 }
}
`

func TestActualFrozenAndCandidateHandleConn(t *testing.T) {
	working, err := os.Getwd(); if err != nil { t.Fatal(err) }
	root := filepath.Clean(filepath.Join(working,"../.."))
	frozen := filepath.Join(root,"doc/harness/checkpoints/localhost-proxy-20261009/baseline/scripts/localhost-proxy")
	read := func(path string) []byte { bytes, err := os.ReadFile(path); if err != nil { t.Fatal(err) }; return bytes }
	baselineSource := string(read(filepath.Join(frozen,"main.go")))
	candidateSource := string(read(filepath.Join(working,"main.go")))
	for _, name := range []string{"getOriginalDstPort","tryConnect","pipe","main"} {
		if nativeBody(t,baselineSource,name) != nativeBody(t,candidateSource,name) {t.Fatalf("retained native %s bytes changed",name)}
	}
	if handleBody(t, baselineSource)==handleBody(t,candidateSource) { t.Fatal("production handleConn was not migrated") }
	run := func(source string, candidate bool) string {
		directory := t.TempDir(); write := func(name string, bytes []byte) { if err := os.WriteFile(filepath.Join(directory,name),bytes,0600); err != nil {t.Fatal(err)} }
		write("go.mod",read(filepath.Join(frozen,"go.mod")))
		body := handleBody(t,source)
		body = strings.ReplaceAll(body,"*net.TCPConn","*harnessOwner")
		body = strings.ReplaceAll(body,"net.Conn","harnessUpstream")
		write("main.go",[]byte(handleEffectsHarness+"\n"+body+"\n"))
		if candidate { for _, file := range []string{"policy.go","ports.go","application.go"} { write(file,read(filepath.Join(working,file))) } }
		command := exec.Command("go","run","."); command.Dir=directory
		// This is source compilation only; no original syscall/dial/listener runs.
		command.Env=append(os.Environ(),"GOWORK=off","GOTOOLCHAIN=local","GOPROXY=off","GOSUMDB=off")
		output, err := command.CombinedOutput(); if err != nil {t.Fatalf("actual source harness: %v\n%s",err,output)}; return string(output)
	}
	baseline := run(baselineSource,false); candidate := run(candidateSource,true)
	if candidate != baseline {t.Fatalf("actual baseline/candidate policy trace differs\nbaseline:\n%s\ncandidate:\n%s",baseline,candidate)}
	if !strings.Contains(baseline,"fallback|metadata,dial:127.0.0.1:123,dial:host.docker.internal:123,relay,close:upstream,close:client|none") {t.Fatal("baseline fallback witness missing")}
	if !strings.Contains(baseline,"zero|metadata,close:client|none") {t.Fatal("baseline Go zero refusal witness missing")}
}

func tcpPair(t *testing.T) (*net.TCPConn, *net.TCPConn) {
	t.Helper()
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP:net.ParseIP("127.0.0.1"), Port:0})
	if err != nil { t.Fatal(err) }; defer listener.Close()
	accepted := make(chan *net.TCPConn, 1); failures := make(chan error, 1)
	go func() { connection, err := listener.AcceptTCP(); if err != nil { failures <- err } else { accepted <- connection } }()
	client, err := net.DialTCP("tcp", nil, listener.Addr().(*net.TCPAddr)); if err != nil { t.Fatal(err) }
	t.Cleanup(func(){client.Close()})
	select {
	case server := <-accepted:
		t.Cleanup(func(){server.Close()}); deadline := time.Now().Add(3*time.Second); client.SetDeadline(deadline); server.SetDeadline(deadline); return client, server
	case err := <-failures: t.Fatal(err)
	case <-time.After(3*time.Second): t.Fatal("private accept timeout")
	}; return nil, nil
}
func TestNativeTryConnectAllocatedLoopback(t *testing.T) {
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP:net.ParseIP("127.0.0.1"), Port:0}); if err != nil { t.Fatal(err) }
	port := uint16(listener.Addr().(*net.TCPAddr).Port)
	connection, err := tryConnect("127.0.0.1", port); if err != nil { listener.Close(); t.Fatal(err) }; defer connection.Close()
	accepted, err := listener.AcceptTCP(); if err != nil { listener.Close(); t.Fatal(err) }; accepted.Close(); listener.Close()
	refused, err := tryConnect("127.0.0.1", port)
	if err == nil { refused.Close(); t.Fatal("closed allocated port unexpectedly connected") }
	if connectTimeout != 3*time.Second { t.Fatalf("dial timeout changed: %v", connectTimeout) }
}
func TestNativeRelayBothDirectionsAndHalfClose(t *testing.T) {
	left, inbound := tcpPair(t); outbound, right := tcpPair(t)
	done := make(chan struct{}); go func() { pipe(inbound, outbound); close(done) }()
	if _, err := left.Write([]byte("client bytes")); err != nil { t.Fatal(err) }
	buffer := make([]byte, len("client bytes")); if _, err := io.ReadFull(right, buffer); err != nil { t.Fatal(err) }; if string(buffer) != "client bytes" { t.Fatal(string(buffer)) }
	if err := left.CloseWrite(); err != nil { t.Fatal(err) }
	if bytes, err := io.ReadAll(right); err != nil || len(bytes) != 0 { t.Fatalf("peer EOF: %q %v", bytes, err) }
	if _, err := right.Write([]byte("upstream survives EOF")); err != nil { t.Fatal(err) }
	if err := right.CloseWrite(); err != nil { t.Fatal(err) }
	bytes, err := io.ReadAll(left); if err != nil || string(bytes) != "upstream survives EOF" { t.Fatalf("reverse: %q %v", bytes, err) }
	select { case <-done: case <-time.After(3*time.Second): t.Fatal("relay did not finish both copies") }
}
