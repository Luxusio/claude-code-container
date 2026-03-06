// Transparent localhost proxy for Docker Desktop (macOS/Windows/WSL2).
//
// On Docker Desktop, --network host uses a VM, so localhost in the container
// doesn't reach the host. This proxy intercepts localhost traffic (via iptables
// REDIRECT) and:
//   1. Tries connecting to 127.0.0.1:PORT (container-local server)
//   2. If refused, falls back to host.docker.internal:PORT (host server)
//
// Uses SO_ORIGINAL_DST to recover the original destination port after iptables
// REDIRECT rewrites it to the proxy port.

package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"time"
	"unsafe"
)

const (
	proxyPort      = 19999
	connectTimeout = 3 * time.Second
	soOriginalDst  = 80 // SO_ORIGINAL_DST (linux/netfilter_ipv4.h)
)

// getOriginalDstPort reads the original destination port from a redirected socket
// using the SO_ORIGINAL_DST socket option (set by iptables REDIRECT).
func getOriginalDstPort(conn *net.TCPConn) (uint16, error) {
	rawConn, err := conn.SyscallConn()
	if err != nil {
		return 0, err
	}

	var port uint16
	var sockErr error

	err = rawConn.Control(func(fd uintptr) {
		// getsockopt(fd, SOL_IP, SO_ORIGINAL_DST, &sockaddr_in, &len)
		var buf [16]byte
		bufLen := uint32(len(buf))
		_, _, errno := syscall.Syscall6(
			syscall.SYS_GETSOCKOPT,
			fd,
			uintptr(syscall.SOL_IP),
			soOriginalDst,
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(unsafe.Pointer(&bufLen)),
			0,
		)
		if errno != 0 {
			sockErr = fmt.Errorf("getsockopt SO_ORIGINAL_DST: %v", errno)
			return
		}
		// sockaddr_in: family(2) + port(2, network byte order) + addr(4) + pad(8)
		port = uint16(buf[2])<<8 | uint16(buf[3])
	})

	if err != nil {
		return 0, err
	}
	return port, sockErr
}

// tryConnect attempts a TCP connection with a timeout.
func tryConnect(host string, port uint16) (net.Conn, error) {
	addr := fmt.Sprintf("%s:%d", host, port)
	return net.DialTimeout("tcp", addr, connectTimeout)
}

// pipe copies data between two connections bidirectionally.
func pipe(a, b net.Conn) {
	done := make(chan struct{})
	go func() {
		io.Copy(a, b)
		a.(*net.TCPConn).CloseWrite()
		close(done)
	}()
	io.Copy(b, a)
	b.(*net.TCPConn).CloseWrite()
	<-done
}

// handleConn processes a redirected connection.
func handleConn(client *net.TCPConn) {
	defer client.Close()

	port, err := getOriginalDstPort(client)
	if err != nil || port == 0 {
		return
	}

	// Try container-local first, then fall back to host
	upstream, err := tryConnect("127.0.0.1", port)
	if err != nil {
		upstream, err = tryConnect("host.docker.internal", port)
		if err != nil {
			return
		}
	}
	defer upstream.Close()

	pipe(client, upstream)
}

func main() {
	addr := fmt.Sprintf("127.0.0.1:%d", proxyPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("proxy:%d\n", proxyPort)

	for {
		conn, err := ln.Accept()
		if err != nil {
			continue
		}
		go handleConn(conn.(*net.TCPConn))
	}
}
