package com.halo.bot.platform

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

/**
 * A loopback listener that lets something else on this phone start a routine.
 *
 * Grok Bot added a webhook trigger beside its cron triggers (docs/GROK_BOT_0.24_0.27_TEARDOWN.md
 * §11.4); theirs is a hosted endpoint, ours does not need to be. On Windows the callers were Task
 * Scheduler and build scripts; on Android they are Tasker, MacroDroid, Automate, a Shortcut, or an
 * HTTP request from something else on the same wifi — which is exactly why it binds loopback only.
 *
 * Two things keep it honest: it binds 127.0.0.1, so nothing off this device can reach it, and the
 * routine's token is its whole address — an unknown token is a flat 404 with no hint that another
 * token would have worked.
 */

/** Tried first so a URL a user pasted into an automation app keeps working across restarts. */
private const val PREFERRED_PORT = 8477

class WebhookServer(private val fire: (String) -> Boolean) {
    @Volatile private var server: ServerSocket? = null
    @Volatile var port: Int = 0
        private set

    private val tokenPattern = Regex("^/hook/([A-Za-z0-9]{8,64})/?$")

    fun start() {
        if (server != null) return
        val socket = openSocket() ?: return
        server = socket
        port = socket.localPort
        thread(isDaemon = true, name = "halo-webhook") {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    break
                }
                thread(isDaemon = true) { handle(client) }
            }
        }
    }

    private fun openSocket(): ServerSocket? {
        val loopback = InetAddress.getByName("127.0.0.1")
        // Port 0 asks the OS for any free port: better a URL that changes than no webhooks at all.
        for (candidate in intArrayOf(PREFERRED_PORT, 0)) {
            runCatching { return ServerSocket(candidate, 8, loopback) }
        }
        return null
    }

    private fun handle(client: Socket) {
        client.use { socket ->
            socket.soTimeout = 5000
            val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
            val requestLine = runCatching { reader.readLine() }.getOrNull() ?: return
            // Reading the rest of the head keeps a client from seeing a broken pipe on POST.
            runCatching { while (true) { val line = reader.readLine() ?: break; if (line.isEmpty()) break } }

            val path = requestLine.split(" ").getOrNull(1)?.substringBefore('?').orEmpty()
            val token = tokenPattern.find(path)?.groupValues?.get(1)
            val started = token != null && runCatching { fire(token) }.getOrDefault(false)
            val body = if (started) "started\n" else "no such hook\n"
            val status = if (started) "202 Accepted" else "404 Not Found"
            socket.getOutputStream().write(
                ("HTTP/1.1 $status\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body")
                    .toByteArray(),
            )
            socket.getOutputStream().flush()
        }
    }

    fun url(token: String): String = if (port > 0) "http://127.0.0.1:$port/hook/$token" else ""

    fun stop() {
        runCatching { server?.close() }
        server = null
        port = 0
    }
}
