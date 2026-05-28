package com.newks.mdmagent

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Small facade between the WebSocket layer ([ConnectionManager]) and the
 * Android screen-capture machinery ([MediaProjectionConsentActivity] +
 * [ScreenCaptureService]). Keeps ConnectionManager unaware of Activity /
 * Service intents, and gives the capture pieces a single place to call
 * back into the WS layer.
 *
 * Consent is requested ONCE per app lifetime: the first time
 * [requestStart] is called we route through the consent activity to get a
 * MediaProjection token. After that, [ScreenCaptureService] caches the
 * token and subsequent sessions skip the dialog entirely until the user
 * revokes via the system notification, the process dies, or the tablet
 * reboots. See ScreenCaptureService's class comment for the full lifetime
 * picture.
 */
object SessionCoordinator {

    private const val TAG = "NewksMdm"

    /** Called from ConnectionManager when a START_SESSION arrives over WS. */
    fun requestStart(appContext: Context, sessionId: String) {
        if (ScreenCaptureService.hasActiveProjection) {
            // Cached projection -- send the session id straight to the
            // running service, skip the consent dialog.
            Log.d(TAG, "session $sessionId: reusing cached MediaProjection (no consent prompt)")
            val intent = Intent(appContext, ScreenCaptureService::class.java).apply {
                putExtra(ScreenCaptureService.EXTRA_SESSION_ID, sessionId)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                appContext.startForegroundService(intent)
            } else {
                appContext.startService(intent)
            }
            return
        }

        Log.d(TAG, "session $sessionId: requesting consent (first session this app lifetime)")
        MediaProjectionConsentActivity.launch(appContext, sessionId)
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

    /** Called when the user denies consent in [MediaProjectionConsentActivity]. */
    fun notifyDenied(appContext: Context, sessionId: String, reason: String) {
        ConnectionManager
            .getOrCreate(appContext, AgentConfig(appContext))
            .sendSessionDenied(sessionId, reason)
    }

    /** Called by [ScreenCaptureService] once capture is actually running. */
    fun notifyStarted(appContext: Context, sessionId: String, width: Int, height: Int) {
        ConnectionManager
            .getOrCreate(appContext, AgentConfig(appContext))
            .sendSessionStarted(sessionId, width, height)
    }

    /** Called by [ScreenCaptureService] when capture ends (user, server, or device). */
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
