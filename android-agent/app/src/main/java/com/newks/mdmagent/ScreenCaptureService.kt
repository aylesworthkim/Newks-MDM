package com.newks.mdmagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Foreground service that owns the per-session screen-capture loop. In
 * v0.5.0+ this is a thin wrapper around [AgentAccessibilityService.captureFrame],
 * which uses Android's AccessibilityService.takeScreenshot() API to grab
 * frames without a per-session consent dialog.
 *
 * History: pre-v0.5.0 this service ran the MediaProjection + VirtualDisplay
 * + ImageReader pipeline. That pipeline required the user to tap "Start
 * now" on a SystemUI consent dialog every time the agent process was
 * restarted (after every reboot, force-stop, or low-memory kill). The
 * accessibility-based path eliminates that dialog entirely; the user
 * grants Accessibility access ONCE at install time and capture persists
 * across reboots.
 *
 * Lifecycle:
 *   1. SessionCoordinator.requestStart() starts this service with EXTRA_SESSION_ID.
 *   2. Service verifies AgentAccessibilityService is enabled; if not, sends
 *      SESSION_STOPPED with reason and exits.
 *   3. Goes foreground (dataSync type) and loops calling captureFrame()
 *      at FRAME_INTERVAL_MS, forwarding each JPEG to SessionCoordinator.
 *   4. Stops on ACTION_STOP or when the coroutine scope is cancelled.
 */
class ScreenCaptureService : Service() {

    private var captureJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var sessionId: String? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            val sid = intent.getStringExtra(EXTRA_SESSION_ID) ?: sessionId
            stopCapture(sid ?: "", "stop requested")
            return START_NOT_STICKY
        }

        val sid = intent?.getStringExtra(EXTRA_SESSION_ID)
        if (sid == null) {
            Log.w(TAG, "no session id on start; ignoring")
            stopSelf()
            return START_NOT_STICKY
        }

        // Hard requirement: accessibility service must be enabled, otherwise
        // takeScreenshot() can't be called. Surface the failure to the
        // backend so the portal shows why no frames arrived.
        if (!AgentAccessibilityService.isEnabled()) {
            Log.w(TAG, "accessibility service not enabled; cannot capture")
            SessionCoordinator.notifyStopped(
                applicationContext, sid,
                "accessibility service not enabled on tablet",
            )
            stopSelf()
            return START_NOT_STICKY
        }
        if (!AgentAccessibilityService.isScreenshotSupported()) {
            Log.w(TAG, "android version too old for takeScreenshot (need API 30+)")
            SessionCoordinator.notifyStopped(
                applicationContext, sid,
                "tablet android version too old for screen capture",
            )
            stopSelf()
            return START_NOT_STICKY
        }

        sessionId = sid

        // Foreground with DATA_SYNC type (vs MEDIA_PROJECTION in the
        // pre-v0.5 implementation -- we're not using MediaProjection anymore).
        val notification = buildNotification("Sharing screen with Newk's portal")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        startCapture(sid)
        return START_STICKY
    }

    private fun startCapture(sid: String) {
        // Notify backend the session is live. We report the target dimensions
        // (display * SCALE) since accessibility-based screenshots return at
        // full device resolution and we downscale during encoding.
        val metrics = resources.displayMetrics
        val targetWidth = (metrics.widthPixels * SCALE).toInt().coerceAtLeast(2) and 0x7FFFFFFE
        val targetHeight = (metrics.heightPixels * SCALE).toInt().coerceAtLeast(2) and 0x7FFFFFFE
        SessionCoordinator.notifyStarted(applicationContext, sid, targetWidth, targetHeight)

        captureJob = scope.launch {
            while (isActive) {
                AgentAccessibilityService.captureFrame(SCALE, JPEG_QUALITY) { jpeg ->
                    if (jpeg != null) {
                        val b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)
                        SessionCoordinator.notifyFrame(applicationContext, sid, b64)
                    }
                    // null = rate-limited or transient failure; just skip
                    // this tick and try again next interval.
                }
                delay(FRAME_INTERVAL_MS)
            }
        }
    }

    private fun stopCapture(sid: String, reason: String) {
        captureJob?.cancel()
        captureJob = null
        if (sid.isNotEmpty()) {
            SessionCoordinator.notifyStopped(applicationContext, sid, reason)
        }
        sessionId = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    override fun onDestroy() {
        super.onDestroy()
        sessionId?.let { stopCapture(it, "service destroyed") }
        scope.cancel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureNotificationChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Remote screen session",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Visible while a screen-share session is active"
                    setShowBadge(false)
                },
            )
        }
    }

    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Newk's MDM Agent")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    companion object {
        const val EXTRA_SESSION_ID = "session_id"
        const val ACTION_STOP = "com.newks.mdmagent.action.STOP_SCREEN_CAPTURE"
        private const val CHANNEL_ID = "mdm_screen_session"
        private const val NOTIFICATION_ID = 1002

        // Capture settings tuned for clarity vs bandwidth. Each frame at these
        // settings is ~150-250 KB depending on screen content; at 2 fps that's
        // ~400 KB/s per active session, well within Cloudways' budget.
        // takeScreenshot is rate-limited to ~3/sec by Android, so 2 fps leaves
        // headroom for the occasional retry. Increase JPEG_QUALITY toward 85
        // if quality is still insufficient at the cost of more bandwidth.
        private const val FRAME_INTERVAL_MS = 500L     // 2 fps
        private const val SCALE = 0.75f                 // 75% of native resolution
        private const val JPEG_QUALITY = 70             // 70/100 -- noticeably sharper than 50
        private const val TAG = "NewksMdm"
    }
}
