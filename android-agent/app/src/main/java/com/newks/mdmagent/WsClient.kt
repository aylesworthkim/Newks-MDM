package com.newks.mdmagent

import android.util.Log
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Thin wrapper around OkHttp's WebSocket. Owns one connection at a time and
 * forwards events back via [Listener]. Reconnect logic intentionally lives in
 * [ConnectionManager], not here -- this class only knows about a single
 * connection's lifecycle.
 */
class WsClient(
    private val url: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onOpen()
        fun onMessage(payload: JsonObject)
        fun onClosed(code: Int, reason: String)
        fun onFailure(t: Throwable)
    }

    private val client: OkHttpClient = OkHttpClient.Builder()
        // OkHttp-level ping keeps NAT mappings alive on flaky Wi-Fi.
        .pingInterval(30, TimeUnit.SECONDS)
        // No read timeout -- WS connections are long-lived.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    @Volatile
    private var ws: WebSocket? = null

    fun connect() {
        if (ws != null) return
        val request = Request.Builder().url(url).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "ws open ($url)")
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val obj = json.parseToJsonElement(text).jsonObject
                    listener.onMessage(obj)
                } catch (e: Exception) {
                    Log.w(TAG, "bad ws message: $text", e)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // Acknowledge the server-initiated close so OkHttp emits onClosed cleanly.
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "ws closed $code $reason")
                ws = null
                listener.onClosed(code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "ws failure: ${t.message}")
                ws = null
                listener.onFailure(t)
            }
        })
    }

    fun send(payload: String): Boolean = ws?.send(payload) ?: false

    fun close() {
        ws?.close(1000, "client closing")
        ws = null
    }

    companion object {
        private const val TAG = "NewksMdm"
    }
}
