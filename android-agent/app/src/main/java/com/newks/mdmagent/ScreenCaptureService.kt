package com.newks.mdmagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
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
import java.io.ByteArrayOutputStream

/**
 * Foreground service that owns the MediaProjection + VirtualDisplay +
 * ImageReader for the lifetime of "remote support is enabled" -- which spans
 * many individual screen-share sessions.
 *
 * Why service-lifetime, not session-lifetime: Android's MediaProjection
 * consent dialog ("Start now") is rendered by SystemUI and cannot be
 * suppressed by the app. To avoid prompting the store manager on every single
 * remote session, we obtain the MediaProjection token once and reuse it
 * across multiple START_SESSION / STOP_SESSION cycles. The token only dies
 * when the user explicitly revokes via the system notification, the process
 * dies, or the tablet reboots.
 *
 * Two start modes (driven from [SessionCoordinator]):
 *   1. First-time: started with EXTRA_RESULT_CODE + EXTRA_DATA from the
 *      consent activity. Service obtains MediaProjection and caches it.
 *   2. Subsequent: started with only EXTRA_SESSION_ID. Service reuses the
 *      cached MediaProjection to spin up a new VirtualDisplay.
 *
 * Capture state (VirtualDisplay + ImageReader) is per-session and torn down
 * on ACTION_STOP. Projection state survives until ACTION_SHUTDOWN, the
 * MediaProjection.Callback.onStop fires (user revoked), or onDestroy.
 *
 * SCALE and JPEG_QUALITY are tuned for ~1 fps + adb-reverse-over-USB
 * bandwidth. For a real LAN deployment we can raise both significantly.
 */
class ScreenCaptureService : Service() {

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var captureJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private var sessionId: String? = null
    private var captureWidth: Int = 0
    private var captureHeight: Int = 0

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                val sid = intent.getStringExtra(EXTRA_SESSION_ID) ?: sessionId
                stopCurrentCapture(sid ?: "", "stop requested")
                // Service + projection stay alive for the next session.
                updateNotification(idleText())
                return START_STICKY
            }
            ACTION_SHUTDOWN -> {
                shutdownEverything("explicit shutdown")
                return START_NOT_STICKY
            }
        }

        val sid = intent?.getStringExtra(EXTRA_SESSION_ID)

        // Cached-projection fast path: skip consent + getMediaProjection,
        // just rebuild the per-session capture surface. Only meaningful if a
        // sessionId was provided -- a sessionId-less call with cached
        // projection means "re-arm" which is a no-op.
        if (mediaProjection != null) {
            if (sid != null) {
                Log.d(TAG, "reusing cached MediaProjection for session $sid")
                sessionId = sid
                startCapture(sid)
                updateNotification(activeText())
            } else {
                Log.d(TAG, "pre-arm called but projection already cached; no-op")
            }
            return START_STICKY
        }

        // First-time path: need the consent result that the activity captured.
        // Two valid first-time entries:
        //   (1) sessionId + extras -- IT initiated a session, no projection
        //       yet, capture starts immediately on grant.
        //   (2) no sessionId + extras -- pre-arm flow from the boot-time
        //       notification, projection gets cached and we stay idle.
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val data = intent?.getParcelableExtraCompat<Intent>(EXTRA_DATA)
        if (resultCode == 0 || data == null) {
            Log.w(TAG, "no cached projection and no consent extras; cannot start")
            if (sid != null) {
                SessionCoordinator.notifyStopped(applicationContext, sid, "no consent extras")
            }
            stopSelf()
            return START_NOT_STICKY
        }

        // Go foreground BEFORE getMediaProjection (required on Android 14+).
        val initialText = if (sid != null) activeText() else idleText()
        val notification = buildNotification(initialText)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        val mpm = getSystemService(MediaProjectionManager::class.java)
        val projection = mpm?.getMediaProjection(resultCode, data)
        if (projection == null) {
            Log.w(TAG, "could not obtain MediaProjection")
            if (sid != null) {
                SessionCoordinator.notifyStopped(applicationContext, sid, "no media projection")
            }
            stopSelf()
            return START_NOT_STICKY
        }
        mediaProjection = projection
        hasActiveProjection = true
        // Pre-arm notification (if HeartbeatService posted one) is no longer
        // needed -- the projection is armed now. Safe to cancel an ID that
        // wasn't posted; NotificationManager just no-ops.
        HeartbeatService.cancelEnablePromptNotification(applicationContext)
        // Android 14+ requires a registered callback before VirtualDisplay creation.
        projection.registerCallback(
            object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.d(TAG, "MediaProjection.onStop -- user revoked via system UI")
                    shutdownEverything("media projection stopped by user")
                }
            },
            Handler(Looper.getMainLooper()),
        )

        if (sid != null) {
            sessionId = sid
            startCapture(sid)
        }
        return START_STICKY
    }

    private fun startCapture(sid: String) {
        val metrics = resources.displayMetrics
        // Even dimensions only -- some encoders dislike odd numbers, even
        // though JPEG itself doesn't care. Cheap insurance.
        val targetWidth = ((metrics.widthPixels * SCALE).toInt() and 0x7FFFFFFE).coerceAtLeast(2)
        val targetHeight = ((metrics.heightPixels * SCALE).toInt() and 0x7FFFFFFE).coerceAtLeast(2)
        val density = metrics.densityDpi
        captureWidth = targetWidth
        captureHeight = targetHeight

        val reader = ImageReader.newInstance(targetWidth, targetHeight, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        virtualDisplay = mediaProjection?.createVirtualDisplay(
            "NewksMdmCapture",
            targetWidth, targetHeight, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null, null,
        )

        SessionCoordinator.notifyStarted(applicationContext, sid, targetWidth, targetHeight)

        captureJob = scope.launch {
            while (isActive) {
                val image = reader.acquireLatestImage()
                if (image != null) {
                    try {
                        val jpeg = encodeFrame(image, targetWidth, targetHeight)
                        val b64 = Base64.encodeToString(jpeg, Base64.NO_WRAP)
                        SessionCoordinator.notifyFrame(applicationContext, sid, b64)
                    } catch (e: Exception) {
                        Log.w(TAG, "frame encode failed", e)
                    } finally {
                        image.close()
                    }
                }
                delay(FRAME_INTERVAL_MS)
            }
        }
    }

    private fun encodeFrame(image: Image, width: Int, height: Int): ByteArray {
        // ImageReader exposes the pixel buffer with a row stride that's
        // usually wider than width * 4 (it pads to a hardware-friendly
        // alignment). We allocate the bitmap at the padded width, copy the
        // raw buffer, then crop back to the actual width.
        val plane = image.planes[0]
        val buffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * width
        val paddedWidth = width + rowPadding / pixelStride

        val paddedBitmap = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
        paddedBitmap.copyPixelsFromBuffer(buffer)
        val cropped = if (paddedWidth != width) {
            val c = Bitmap.createBitmap(paddedBitmap, 0, 0, width, height)
            paddedBitmap.recycle()
            c
        } else {
            paddedBitmap
        }

        val out = ByteArrayOutputStream()
        cropped.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        cropped.recycle()
        return out.toByteArray()
    }

    /**
     * Tear down the per-session capture surface. Leaves [mediaProjection]
     * intact so the next session reuses it without re-prompting the user.
     */
    private fun stopCurrentCapture(sid: String, reason: String) {
        captureJob?.cancel()
        captureJob = null
        try { virtualDisplay?.release() } catch (_: Exception) { /* ignore */ }
        virtualDisplay = null
        try { imageReader?.close() } catch (_: Exception) { /* ignore */ }
        imageReader = null
        if (sid.isNotEmpty()) {
            SessionCoordinator.notifyStopped(applicationContext, sid, reason)
        }
        sessionId = null
    }

    /**
     * Fully tear down. Used when the user revokes consent via the system
     * notification or we explicitly shut down. After this the next session
     * will re-prompt for consent.
     */
    private fun shutdownEverything(reason: String) {
        sessionId?.let { stopCurrentCapture(it, reason) }
        try { mediaProjection?.stop() } catch (_: Exception) { /* ignore */ }
        mediaProjection = null
        hasActiveProjection = false
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
        sessionId?.let { stopCurrentCapture(it, "service destroyed") }
        try { mediaProjection?.stop() } catch (_: Exception) { /* ignore */ }
        mediaProjection = null
        hasActiveProjection = false
        scope.cancel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureNotificationChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Remote support",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Visible while remote support is enabled or a screen-share session is active"
                    setShowBadge(false)
                },
            )
        }
    }

    private fun activeText() = "Sharing screen with Newk's portal"
    private fun idleText() = "Remote support enabled (no active session)"

    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Newk's MDM Agent")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    private fun updateNotification(text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    companion object {
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_DATA = "data"
        const val EXTRA_SESSION_ID = "session_id"
        const val ACTION_STOP = "com.newks.mdmagent.action.STOP_SCREEN_CAPTURE"
        const val ACTION_SHUTDOWN = "com.newks.mdmagent.action.SHUTDOWN_SCREEN_CAPTURE"
        private const val CHANNEL_ID = "mdm_screen_session"
        private const val NOTIFICATION_ID = 1002

        // MVP capture settings -- 1 fps, 50% scale, JPEG quality 50.
        // Tuned for adb-reverse-over-USB bandwidth. Real LAN can crank up.
        private const val FRAME_INTERVAL_MS = 1_000L
        private const val SCALE = 0.5f
        private const val JPEG_QUALITY = 50
        private const val TAG = "NewksMdm"

        // Read by SessionCoordinator to decide whether to launch the consent
        // activity. Volatile because it's written from the service thread and
        // read from whatever thread handles START_SESSION on the WS layer.
        @Volatile
        var hasActiveProjection: Boolean = false
            private set
    }
}

// Small Android-version-aware shim for getParcelableExtra. The non-typed
// overload is deprecated on Tiramisu (API 33+) but the typed overload only
// exists from 33+, so we have to branch.
@Suppress("DEPRECATION", "UNCHECKED_CAST")
private inline fun <reified T : android.os.Parcelable> Intent.getParcelableExtraCompat(name: String): T? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        getParcelableExtra(name, T::class.java)
    } else {
        getParcelableExtra(name) as? T
    }
