import { describe, it, expect, afterEach } from 'vitest'
import * as net from 'net'

// Helper: create a TCP server that echoes with a prefix
function echoServer(prefix: string): Promise<{ port: number; server: net.Server }> {
    return new Promise((resolve) => {
        const server = net.createServer((socket) => {
            socket.on('data', (chunk) => socket.write(`${prefix}:${chunk}`))
        })
        server.listen(0, '127.0.0.1', () => {
            resolve({ port: (server.address() as net.AddressInfo).port, server })
        })
    })
}

// Helper: send data through a TCP connection and get response
function sendAndReceive(port: number, data: string, timeout = 500): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
            socket.write(data)
        })
        let buf = ''
        socket.on('data', (chunk) => { buf += chunk.toString() })
        socket.on('error', reject)
        setTimeout(() => { socket.destroy(); resolve(buf) }, timeout)
    })
}

describe('localhost-proxy', () => {
    const servers: net.Server[] = []
    afterEach(() => {
        for (const s of servers) s.close()
        servers.length = 0
    })

    describe('tryConnect', () => {
        it('connects to a listening server and returns socket', async () => {
            const { tryConnect } = await import('../localhost-proxy.js')
            const { port, server } = await echoServer('local')
            servers.push(server)

            const socket = await tryConnect('127.0.0.1', port)
            expect(socket).toBeInstanceOf(net.Socket)
            socket.destroy()
        })

        it('rejects with ECONNREFUSED when no server listening', async () => {
            const { tryConnect } = await import('../localhost-proxy.js')
            try {
                await tryConnect('127.0.0.1', 59999)
                expect.unreachable('should have thrown')
            } catch (err: any) {
                expect(err.code).toBe('ECONNREFUSED')
            }
        })
    })

    describe('proxyConnection', () => {
        it('proxies to local server when available (use case 2: container server)', async () => {
            const { proxyConnection } = await import('../localhost-proxy.js')

            // "local" server simulating container server
            const { port: localPort, server: localServer } = await echoServer('container')
            servers.push(localServer)

            // Create a server that calls proxyConnection for each client
            const proxyServer = net.createServer((client) => {
                proxyConnection(client, localPort, '127.0.0.1')
            })
            servers.push(proxyServer)
            await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r))
            const proxyPort = (proxyServer.address() as net.AddressInfo).port

            const result = await sendAndReceive(proxyPort, 'hello')
            expect(result).toBe('container:hello')
        })

        it('falls back to host when local connection refused (use case 1: host server)', async () => {
            const { proxyConnection } = await import('../localhost-proxy.js')

            // "host" server simulating host.docker.internal
            const { port: hostPort, server: hostServer } = await echoServer('host')
            servers.push(hostServer)

            // localPort: nothing listening (simulates no container server)
            const unusedPort = 59997

            const proxyServer = net.createServer((client) => {
                // Override hostAddr to 127.0.0.1 and hostPort for testing
                proxyConnection(client, unusedPort, '127.0.0.1', '127.0.0.1', hostPort)
            })
            servers.push(proxyServer)
            await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r))
            const proxyPort = (proxyServer.address() as net.AddressInfo).port

            const result = await sendAndReceive(proxyPort, 'hello')
            expect(result).toBe('host:hello')
        })

        it('destroys client when both local and host fail', async () => {
            const { proxyConnection } = await import('../localhost-proxy.js')

            const proxyServer = net.createServer((client) => {
                proxyConnection(client, 59996, '127.0.0.1', '127.0.0.1', 59995)
            })
            servers.push(proxyServer)
            await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r))
            const proxyPort = (proxyServer.address() as net.AddressInfo).port

            const closed = await new Promise<boolean>((resolve) => {
                const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort })
                socket.on('close', () => resolve(true))
                socket.on('error', () => resolve(true))
                setTimeout(() => { socket.destroy(); resolve(false) }, 2000)
            })
            expect(closed).toBe(true)
        })

        it('pipes data bidirectionally', async () => {
            const { proxyConnection } = await import('../localhost-proxy.js')

            // Server that sends data back AND expects more
            const { port: localPort, server: localServer } = await echoServer('bi')
            servers.push(localServer)

            const proxyServer = net.createServer((client) => {
                proxyConnection(client, localPort, '127.0.0.1')
            })
            servers.push(proxyServer)
            await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r))
            const proxyPort = (proxyServer.address() as net.AddressInfo).port

            // Send multiple messages
            const result = await new Promise<string>((resolve) => {
                const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort }, () => {
                    socket.write('msg1')
                    setTimeout(() => socket.write('msg2'), 50)
                })
                let buf = ''
                socket.on('data', (chunk) => { buf += chunk.toString() })
                setTimeout(() => { socket.destroy(); resolve(buf) }, 300)
            })

            expect(result).toContain('bi:msg1')
            expect(result).toContain('bi:msg2')
        })
    })

    describe('startProxy / stopProxy', () => {
        it('starts a TCP server on specified port and stops it', async () => {
            const { startProxy, stopProxy } = await import('../localhost-proxy.js')

            const server = await startProxy(0) // random port
            const addr = server.address() as net.AddressInfo

            expect(addr.port).toBeGreaterThan(0)
            expect(server.listening).toBe(true)

            stopProxy(server)
            expect(server.listening).toBe(false)
        })
    })

    describe('PROXY_PORT constant', () => {
        it('exports a port number above 1024', async () => {
            const { PROXY_PORT } = await import('../localhost-proxy.js')
            expect(typeof PROXY_PORT).toBe('number')
            expect(PROXY_PORT).toBeGreaterThan(1024)
        })
    })
})
