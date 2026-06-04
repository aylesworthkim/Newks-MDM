package com.newks.mdmagent

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Small facade between the WebSocket layer ([ConnectionManager]) and the
 * Android screen-capture machinery ([ScreenCaptureService]). Keeps
 * ConnectionManager unaware of Service intents, and gives the capture
 * pieces a single place to call back into the WS layer.
 *
 * In v0.5.0+ this is dramatically simpler than the MediaProjection-era
 * implementation -- there's no per-session consent activity to launch.
 * If the AccessibilityService is enabled, capture starts immediately; if
 * not, ScreenCaptureService surfaces a SESSION_STOPPED so the operator
 * sees an actionable error in the portal.
 */
object SessionCoordinator {

    private const val TAG = "NewksMdm"

    /** Called from ConnectionManager when a START_SESSION arrives over WS. */
    fun requestStart(appContext: Context, sessionId: String) {
        Log.d(TAG, "session $sessionId: starting capture")
        val intent = Intent(appContext, ScreenCaptureService::class.java).apply {
            putExtra(ScreenCaptureService.EXTRA_SESSION_ID, sessionId)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            appContext.startForegroundService(intent)
        } else {
            appContext.startService(intent)
        }
    }

    /** Called from ConnectionManager when a STOP_SESSION arrives over WS. */
    fun requestStop(appContext: Context, sessionId: String) {
        Log.d(TAG, "session $sessionId: stop requested")
        val intent = Intent(appContext, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_STOP
            putExtra(ScreenCaptureService.EXTRA_SESSION_ID, sessionId)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            appContext.startForegroundService(intent)
        } else {
            appContext.startService(intent)
        }
    }

    /** Called by [ScreenCaptureService] once capture is actually running. */
    fun notifyStarted(appContext: Context, sessionId: String, width: Int, height: Int) {
        ConnectionManager
            .getOrCreate(appContext, AgentConfig(appContext))
            .sendSessionStarted(sessionId, width, height)
    }

    /** Called by [ScreenCaptureService] when capture ends (server, user
     *  toggle, accessibility loss, etc.). */
    fun notifyStopped(appContext: Context, sessionId: String, reason: String) {
        ConnectionManager
            .getOrCreate(appContext, AgentConfig(appContext))
            .sendSessionStopped(sessionId, reason)
    }

    /** Called by [ScreenCaptureService] for each captured/encoded frame. */
    fun notifyFrame(appContext: Context, sessionId: String, jpegBase64: String) {
        ConnectionManager
            .getOrCreate(appContext, AgentConfig(appContext))
            .sendSessionFrame(sessionId, jpegBase64)
    }
}
