package com.newks.mdmagent

import android.accessibilityservice.AccessibilityService.GestureResultCallback
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED }

data class CommandLogEntry(
    val commandId: String,
    val commandType: String,
    val receivedAt: Long,
    val status: String,                 // "received" | "completed" | "failed"
    val resultSummary: String? = null,
)

/**
 * Singleton WebSocket lifecycle owner. Exposes connection state and the
 * command log as StateFlows, accepts incoming server messages, and provides
 * `send...` methods used by the rest of the agent (especially
 * [SessionCoordinator] for remote-screen frame/state messages, and
 * [AgentAccessibilityService] callbacks for input acks).
 */
class ConnectionManager private constructor(
    private val appContext: Context,
    private val config: AgentConfig,
) : WsClient.Listener {

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _commandLog = MutableStateFlow<List<CommandLogEntry>>(emptyList())
    val commandLog: StateFlow<List<CommandLogEntry>> = _commandLog.asStateFlow()

    private val _activeSessionId = MutableStateFlow<String?>(null)
    val activeSessionId: StateFlow<String?> = _activeSessionId.asStateFlow()

    private val executor = CommandExecutor(appContext)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private var wsClient: WsClient? = null
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null
    private var reconnectDelayMs = INITIAL_RECONNECT_MS

    fun start() {
        val state = config.state.value
        val deviceId = state.deviceId ?: return
        val backendUrl = state.backendUrl.takeIf { it.isNotBlank() } ?: return

        if (wsClient != null) return

        val wsUrl = httpToWs(backendUrl).trimEnd('/') + "/ws"
        Log.d(TAG, "connecting to $wsUrl as $deviceId")
        _connectionState.value = ConnectionState.CONNECTING
        wsClient = WsClient(wsUrl, this).also { it.connect() }
    }

    fun stop() {
        Log.d(TAG, "stopping connection")
        heartbeatJob?.cancel()
        heartbeatJob = null
        reconnectJob?.cancel()
        reconnectJob = null
        wsClient?.close()
        wsClient = null
        _connectionState.value = ConnectionState.DISCONNECTED
    }

    // -------------------- Outbound: session messages --------------------

    fun sendSessionStarted(sessionId: String, width: Int, height: Int) {
        _activeSessionId.value = sessionId
        wsClient?.send(json.encodeToString(
            SessionStartedMessage.serializer(),
            SessionStartedMessage(sessionId = sessionId, width = width, height = height),
        ))
    }

    fun sendSessionDenied(sessionId: String, reason: String) {
        _activeSessionId.value = null
        wsClient?.send(json.encodeToString(
            SessionDeniedMessage.serializer(),
            SessionDeniedMessage(sessionId = sessionId, reason = reason),
        ))
    }

    fun sendSessionStopped(sessionId: String, reason: String) {
        _activeSessionId.value = null
        wsClient?.send(json.encodeToString(
            SessionStoppedMessage.serializer(),
            SessionStoppedMessage(sessionId = sessionId, reason = reason),
        ))
    }

    fun sendSessionFrame(sessionId: String, jpegBase64: String) {
        wsClient?.send(json.encodeToString(
            SessionFrameMessage.serializer(),
            SessionFrameMessage(
                sessionId = sessionId,
                jpegBase64 = jpegBase64,
                ts = System.currentTimeMillis(),
            ),
        ))
    }

    private fun sendInputResult(sessionId: String, ok: Boolean, reason: String?) {
        wsClient?.send(json.encodeToString(
            InputResultMessage.serializer(),
            InputResultMessage(sessionId = sessionId, ok = ok, reason = reason),
        ))
    }

    // -------------------- WsClient.Listener --------------------

    override fun onOpen() {
        val deviceId = config.state.value.deviceId ?: run {
            stop()
            return
        }
        wsClient?.send(json.encodeToString(
            RegisterMessage.serializer(),
            RegisterMessage(deviceId = deviceId),
        ))
        _connectionState.value = ConnectionState.CONNECTED
        reconnectDelayMs = INITIAL_RECONNECT_MS

        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                val sent = wsClient?.send(json.encodeToString(
                    HeartbeatMessage.serializer(),
                    HeartbeatMessage(
                        // v0.5.0+: accessibility is the single load-bearing
                        // capability. consentArmed (kept for backend wire-
                        // protocol compatibility) is now equivalent to
                        // accessibilityEnabled -- both true means the
                        // tablet can be remote-viewed without any prompt.
                        consentArmed = AgentAccessibilityService.isEnabled(),
                        accessibilityEnabled = AgentAccessibilityService.isEnabled(),
                    ),
                )) ?: false
                if (!sent) break
            }
        }
    }

    override fun onMessage(payload: JsonObject) {
        when (payload["type"]?.jsonPrimitive?.contentOrNull) {
            "WELCOME" -> Log.d(TAG, "welcomed by server")
            "COMMAND" -> handleCommand(payload)
            "START_SESSION" -> handleStartSession(payload)
            "STOP_SESSION" -> handleStopSession(payload)
            "INPUT_TAP" -> handleInputTap(payload)
            "INPUT_SWIPE" -> handleInputSwipe(payload)
            "INPUT_KEY" -> handleInputKey(payload)
            "INPUT_PASTE" -> handleInputPaste(payload)
            "ERROR" -> Log.w(TAG, "server error: ${payload["message"]}")
        }
    }

    override fun onClosed(code: Int, reason: String) {
        _connectionState.value = ConnectionState.DISCONNECTED
        scheduleReconnect()
    }

    override fun onFailure(t: Throwable) {
        _connectionState.value = ConnectionState.DISCONNECTED
        scheduleReconnect()
    }

    // -------------------- internals --------------------

    private fun scheduleReconnect() {
        wsClient = null
        heartbeatJob?.cancel()
        reconnectJob?.cancel()
        val delay = reconnectDelayMs
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(MAX_RECONNECT_MS)

        if (config.state.value.deviceId == null) return

        Log.d(TAG, "reconnecting in ${delay}ms")
        reconnectJob = scope.launch {
            delay(delay)
            if (isActive) start()
        }
    }

    private fun handleCommand(payload: JsonObject) {
        val commandId = payload["commandId"]?.jsonPrimitive?.contentOrNull ?: return
        val commandType = payload["commandType"]?.jsonPrimitive?.contentOrNull ?: return
        val cmdPayload = payload["payload"] as? JsonObject ?: JsonObject(emptyMap())

        Log.d(TAG, "received command $commandType ($commandId)")
        appendLog(CommandLogEntry(
            commandId = commandId,
            commandType = commandType,
            receivedAt = System.currentTimeMillis(),
            status = "received",
        ))

        scope.launch {
            val result = executor.execute(commandType, cmdPayload)
            wsClient?.send(json.encodeToString(
                CommandResultMessage.serializer(),
                CommandResultMessage(
                    commandId = commandId,
                    ok = result.ok,
                    result = result.detail,
                ),
            ))
            updateLog(commandId) { entry ->
                entry.copy(
                    status = if (result.ok) "completed" else "failed",
                    resultSummary = result.summary,
                )
            }
        }
    }

    private fun handleStartSession(payload: JsonObject) {
        val sessionId = payload["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
        Log.d(TAG, "START_SESSION $sessionId")
        SessionCoordinator.requestStart(appContext, sessionId)
    }

    private fun handleStopSession(payload: JsonObject) {
        val sessionId = payload["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
        Log.d(TAG, "STOP_SESSION $sessionId")
        SessionCoordinator.requestStop(appContext, sessionId)
    }

    private fun handleInputTap(payload: JsonObject) {
        val sessionId = payload["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
        val x = payload["x"]?.jsonPrimitive?.floatOrNull ?: return
        val y = payload["y"]?.jsonPrimitive?.floatOrNull ?: return

        if (!AgentAccessibilityService.isEnabled()) {
            sendInputResult(sessionId, false, "accessibility service not enabled")
            return
        }

        // Use the FULL physical display size (including status bar + nav bar),
        // not Resources.displayMetrics which excludes system insets. The
        // accessibility screenshot we send to the browser captures the full
        // physical display, so the proportional coordinates the browser sends
        // back are relative to that. Multiplying by the smaller "usable area"
        // metrics here would land taps systematically above their intended
        // target -- especially noticeable on bottom-of-screen buttons like
        // "Save" or anything near the nav bar.
        val (fullW, fullH) = fullDisplaySize()
        val pxX = x.coerceIn(0f, 1f) * fullW
        val pxY = y.coerceIn(0f, 1f) * fullH

        AgentAccessibilityService.dispatchTap(pxX, pxY, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                sendInputResult(sessionId, true, null)
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                sendInputResult(sessionId, false, "gesture cancelled")
            }
        })
    }

    private fun handleInputSwipe(payload: JsonObject) {
        val sessionId = payload["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
        val fromX = payload["fromX"]?.jsonPrimitive?.floatOrNull ?: return
        val fromY = payload["fromY"]?.jsonPrimitive?.floatOrNull ?: return
        val toX = payload["toX"]?.jsonPrimitive?.floatOrNull ?: return
        val toY = payload["toY"]?.jsonPrimitive?.floatOrNull ?: return
        val durationMs = payload["durationMs"]?.jsonPrimitive?.longOrNull ?: 200L

        if (!AgentAccessibilityService.isEnabled()) {
            sendInputResult(sessionId, false, "accessibility service not enabled")
            return
        }

        val (fullW, fullH) = fullDisplaySize()
        val w = fullW.toFloat()
        val h = fullH.toFloat()
        AgentAccessibilityService.dispatchSwipe(
            fromXPx = fromX.coerceIn(0f, 1f) * w,
            fromYPx = fromY.coerceIn(0f, 1f) * h,
            toXPx = toX.coerceIn(0f, 1f) * w,
            toYPx = toY.coerceIn(0f, 1f) * h,
            durationMs = durationMs,
            callback = object : GestureResultCallback() {
                override fun onCompleted(g: GestureDescription?) = sendInputResult(sessionId, true, null)
                override fun onCancelled(g: GestureDescription?) = sendInputResult(sessionId, false, "gesture cancelled")
            },
        )
    }

    private fun handleInputKey(payload: JsonObject) {
        val sessionId = payload["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
        val key = payload["key"]?.jsonPrimitive?.contentOrNull ?: return

        if (!AgentAccessibilityService.isEnabled()) {
            sendInputResult(sessionId, false, "accessibility service not enabled")
            return
        }
        val ok = AgentAccessibilityService.performGlobalKey(key)
        sendInputResult(sessionId, ok, if (ok) null else "unknown key or dispatch failed")
    }

    private fun handleInputPaste(payload: JsonObject) {
        val sessionId = payload["sessionId"]?.jsonPrimitive?.contentOrNull ?: return
        val text = payload["text"]?.jsonPrimitive?.contentOrNull ?: return

        if (!AgentAccessibilityService.isEnabled()) {
            sendInputResult(sessionId, false, "accessibility service not enabled")
            return
        }
        val ok = AgentAccessibilityService.pasteText(appContext, text)
        sendInputResult(
            sessionId, ok,
            if (ok) null else "no focused editable field on the tablet",
        )
    }

    private fun appendLog(entry: CommandLogEntry) {
        _commandLog.value = (listOf(entry) + _commandLog.value).take(MAX_LOG_ENTRIES)
    }

    private fun updateLog(commandId: String, transform: (CommandLogEntry) -> CommandLogEntry) {
        _commandLog.value = _commandLog.value.map {
            if (it.commandId == commandId) transform(it) else it
        }
    }

    private fun httpToWs(url: String): String = url
        .replaceFirst("https://", "wss://")
        .replaceFirst("http://", "ws://")

    /**
     * Returns the full physical display size in pixels, INCLUDING system
     * bars (status bar at top, navigation bar at bottom). This matches
     * what AccessibilityService.takeScreenshot captures, and matches what
     * AccessibilityService.dispatchGesture expects for coordinates --
     * unlike Resources.displayMetrics which excludes system insets and
     * would cause clicks near the screen edges to land off-target.
     */
    private fun fullDisplaySize(): Pair<Int, Int> {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val wm = appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                val bounds = wm.maximumWindowMetrics.bounds
                bounds.width() to bounds.height()
            } else {
                @Suppress("DEPRECATION")
                val wm = appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                @Suppress("DEPRECATION")
                val display = wm.defaultDisplay
                val metrics = DisplayMetrics()
                @Suppress("DEPRECATION")
                display.getRealMetrics(metrics)
                metrics.widthPixels to metrics.heightPixels
            }
        } catch (e: Exception) {
            // Fall back to the smaller "usable area" metrics if WindowManager
            // is somehow unavailable. Clicks may be slightly off-target but
            // at least they won't crash.
            Log.w(TAG, "fullDisplaySize failed; using displayMetrics fallback", e)
            val metrics = appContext.resources.displayMetrics
            metrics.widthPixels to metrics.heightPixels
        }
    }

    // Wire-format messages we send to the server.
    @Serializable
    private data class RegisterMessage(val type: String = "REGISTER_SOCKET", val deviceId: String)

    @Serializable
    private data class HeartbeatMessage(
        val type: String = "HEARTBEAT",
        val consentArmed: Boolean = false,
        val accessibilityEnabled: Boolean = false,
    )

    @Serializable
    private data class CommandResultMessage(
        val type: String = "COMMAND_RESULT",
        val commandId: String,
        val ok: Boolean,
        val result: JsonElement,
    )

    @Serializable
    private data class SessionStartedMessage(
        val type: String = "SESSION_STARTED",
        val sessionId: String,
        val width: Int,
        val height: Int,
    )

    @Serializable
    private data class SessionDeniedMessage(
        val type: String = "SESSION_DENIED",
        val sessionId: String,
        val reason: String,
    )

    @Serializable
    private data class SessionStoppedMessage(
        val type: String = "SESSION_STOPPED",
        val sessionId: String,
        val reason: String,
    )

    @Serializable
    private data class SessionFrameMessage(
        val type: String = "SESSION_FRAME",
        val sessionId: String,
        val jpegBase64: String,
        val ts: Long,
    )

    @Serializable
    private data class InputResultMessage(
        val type: String = "INPUT_RESULT",
        val sessionId: String,
        val ok: Boolean,
        val reason: String? = null,
    )

    companion object {
        private const val TAG = "NewksMdm"
        private const val HEARTBEAT_INTERVAL_MS = 30_000L
        private const val INITIAL_RECONNECT_MS = 5_000L
        private const val MAX_RECONNECT_MS = 30_000L
        private const val MAX_LOG_ENTRIES = 50

        @Volatile
        private var INSTANCE: ConnectionManager? = null

        fun getOrCreate(appContext: Context, config: AgentConfig): ConnectionManager {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: ConnectionManager(appContext.applicationContext, config)
                    .also { INSTANCE = it }
            }
        }
    }
}
