package com.newks.mdmagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Foreground service whose job is to keep the agent's process alive so the
 * WebSocket loop in [ConnectionManager] can run when the app's UI is closed.
 *
 * Also responsible for the post-boot "Tap to enable remote support"
 * notification: after a reboot the MediaProjection token is gone (Android
 * destroys it with the process), so the first remote-screen session of the
 * day would otherwise prompt the store manager mid-support-call. To avoid
 * that, we post a high-priority notification when this service starts
 * without an active projection, asking the user to grant up front. The
 * grant is then cached for the day (see [ScreenCaptureService]).
 */
class HeartbeatService : Service() {

    override fun onCreate() {
        super.onCreate()
        ensureStatusChannel()
        ensureEnablePromptChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildStatusNotification("Connected to Newk's portal")

        // Android 14+ requires us to declare a foregroundServiceType when
        // calling startForeground. "dataSync" is the closest matching subtype
        // for a heartbeat/management agent.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                STATUS_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(STATUS_NOTIFICATION_ID, notification)
        }

        // Start (or join) the singleton connection.
        val config = AgentConfig(applicationContext)
        ConnectionManager.getOrCreate(applicationContext, config).start()

        // If we're enrolled but the projection isn't armed (fresh boot,
        // process restart, prior revoke), surface the enable-remote-support
        // prompt so the store manager can grant once instead of being
        // prompted mid-session.
        maybePostEnablePromptNotification()

        // START_STICKY: if the system kills the service for resources, ask it
        // to restart with a null intent. Combined with the sticky foreground
        // notification this makes the agent robust to OOM kills.
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        // Deliberately do NOT stop the connection on destroy. The service can
        // be torn down by Android during a memory squeeze even when we want
        // to keep working. The connection survives, the system restarts us
        // (START_STICKY), and the next onStartCommand re-attaches.
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureStatusChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(STATUS_CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                STATUS_CHANNEL_ID,
                "MDM agent status",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Background heartbeat to the management portal"
                setShowBadge(false)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun ensureEnablePromptChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(ENABLE_PROMPT_CHANNEL_ID) == null) {
            val channel = NotificationChannel(
                ENABLE_PROMPT_CHANNEL_ID,
                "Remote support enablement",
                // DEFAULT importance so the notification surfaces visibly on
                // the lock screen / status bar. The store manager needs to
                // see this on first power-on of the day.
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Prompts to allow remote screen sharing after device boot"
                setShowBadge(true)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildStatusNotification(statusText: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val tapPendingIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        return NotificationCompat.Builder(this, STATUS_CHANNEL_ID)
            .setContentTitle("Newk's MDM Agent")
            .setContentText(statusText)
            // System icon -- avoids needing a custom drawable in chunk 4c.
            // Replace with a branded icon when we get one.
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .apply { tapPendingIntent?.let { setContentIntent(it) } }
            .build()
    }

    /**
     * Post the "Tap to enable remote support" notification IF we're enrolled
     * AND the MediaProjection isn't already armed. No-op otherwise.
     *
     * Skipping when not enrolled: a brand-new install where the user hasn't
     * gone through enrollment yet shouldn't see this prompt -- they need to
     * enroll first.
     *
     * Skipping when projection IS armed: avoids re-pestering the user after
     * they've already granted today.
     */
    private fun maybePostEnablePromptNotification() {
        val config = AgentConfig(applicationContext)
        if (config.state.value.deviceId == null) {
            Log.d(TAG, "not enrolled; skipping enable-prompt notification")
            return
        }
        if (ScreenCaptureService.hasActiveProjection) {
            Log.d(TAG, "projection already armed; skipping enable-prompt notification")
            cancelEnablePromptNotification(this)
            return
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            MediaProjectionConsentActivity.preArmIntent(this),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification = NotificationCompat.Builder(this, ENABLE_PROMPT_CHANNEL_ID)
            .setContentTitle("Newk's MDM Agent")
            .setContentText("Tap to enable remote support for this tablet today")
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "Newk's IT will be able to remotely view this screen during a " +
                "support call. You'll see a screen-sharing icon while a session " +
                "is active. Tap to grant -- no further prompts until the tablet " +
                "reboots.",
            ))
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(ENABLE_PROMPT_NOTIFICATION_ID, notification)
        Log.d(TAG, "posted enable-prompt notification")
    }

    companion object {
        private const val TAG = "NewksMdm"
        private const val STATUS_CHANNEL_ID = "mdm_agent_status"
        private const val STATUS_NOTIFICATION_ID = 1001
        private const val ENABLE_PROMPT_CHANNEL_ID = "mdm_enable_remote_support"
        private const val ENABLE_PROMPT_NOTIFICATION_ID = 1003

        fun start(context: Context) {
            val intent = Intent(context, HeartbeatService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, HeartbeatService::class.java))
        }

        /** Called by [ScreenCaptureService] after a MediaProjection is
         *  successfully cached, so the now-redundant prompt notification
         *  disappears from the status bar. Safe to call when no notification
         *  was posted; NotificationManager silently no-ops. */
        fun cancelEnablePromptNotification(context: Context) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(ENABLE_PROMPT_NOTIFICATION_ID)
        }
    }
}
