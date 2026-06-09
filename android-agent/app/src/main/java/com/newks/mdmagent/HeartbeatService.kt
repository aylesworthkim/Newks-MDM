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
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Foreground service whose job is to keep the agent's process alive so the
 * WebSocket loop in [ConnectionManager] can run when the app's UI is closed.
 *
 * Also responsible for nudging the user to enable the AccessibilityService
 * if it isn't already. In v0.5.0+ accessibility is the load-bearing
 * capability for remote support -- both screen capture and input dispatch
 * depend on it. If a store manager disables it (or it gets reset after a
 * system update), the agent is online but no remote sessions will work,
 * which is exactly the case where we want to prompt them.
 */
class HeartbeatService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        ensureStatusChannel()
        ensureEnablePromptChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildStatusNotification("Connected to Newk's portal")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                STATUS_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(STATUS_NOTIFICATION_ID, notification)
        }

        // Start (or join) the singleton WS connection.
        val config = AgentConfig(applicationContext)
        ConnectionManager.getOrCreate(applicationContext, config).start()

        // If accessibility is off, surface the actionable prompt so the
        // store manager can re-enable it without IT having to walk them
        // through Settings.
        maybePostEnablePromptNotification()

        // v0.7.0+: check for a newer agent version and prompt to install
        // if one is available. Runs on every service start (boot, app
        // open, system-restart) which gives us roughly daily checks in
        // typical store usage. v0.7.2+: outcome is recorded via AgentLog
        // so support staff can retrieve it via FETCH_DIAGNOSTICS even
        // when the silent path was taken (e.g. up-to-date or network error).
        val backendUrl = config.state.value.backendUrl
        if (config.state.value.deviceId != null && backendUrl.isNotBlank()) {
            scope.launch {
                val result = AgentUpdater(applicationContext).checkAndPrompt(backendUrl)
                AgentLog.d(TAG, "boot/onStart update check returned: $result")
            }
        } else {
            AgentLog.d(TAG, "skipping update check (not enrolled or blank backendUrl)")
        }

        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
        // Deliberately do NOT stop the connection on destroy. The system
        // can tear us down during a memory squeeze; we want the next
        // onStartCommand (START_STICKY) to re-attach.
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
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description =
                    "Prompts to enable the accessibility service when remote support is disabled"
                setShowBadge(true)
            }
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildStatusNotification(statusText: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val tapPendingIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this, 0, it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        return NotificationCompat.Builder(this, STATUS_CHANNEL_ID)
            .setContentTitle("Newk's MDM Agent")
            .setContentText(statusText)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .apply { tapPendingIntent?.let { setContentIntent(it) } }
            .build()
    }

    /**
     * Post the "Tap to enable remote support" notification IF enrolled AND
     * the accessibility service is NOT enabled. Cancels the notification
     * (if any) when accessibility IS enabled.
     */
    private fun maybePostEnablePromptNotification() {
        val config = AgentConfig(applicationContext)
        if (config.state.value.deviceId == null) {
            Log.d(TAG, "not enrolled; skipping enable-prompt notification")
            return
        }
        if (AgentAccessibilityService.isEnabled() ||
            AgentAccessibilityService.isEnabledInSettings(applicationContext)
        ) {
            Log.d(TAG, "accessibility already enabled; cancelling any stale prompt")
            cancelEnablePromptNotification(this)
            return
        }

        // Deep-link to the system Accessibility settings page. The user
        // toggles "Newk's MDM Agent" on, returns to whatever they were
        // doing; the next heartbeat tick cancels this notification.
        val settingsIntent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, settingsIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification = NotificationCompat.Builder(this, ENABLE_PROMPT_CHANNEL_ID)
            .setContentTitle("Newk's MDM Agent")
            .setContentText("Tap to enable remote support for this tablet")
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "Newk's IT cannot remotely view or assist with this tablet until the " +
                "accessibility service is enabled. Tap to open Accessibility settings " +
                "and toggle \"Newk's MDM Agent\" on.",
            ))
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(ENABLE_PROMPT_NOTIFICATION_ID, notification)
        Log.d(TAG, "posted enable-prompt notification (accessibility off)")
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

        /** Called by other parts of the agent when the enable-prompt is no
         *  longer relevant (e.g. accessibility just got enabled). Safe to
         *  call when no notification was posted. */
        fun cancelEnablePromptNotification(context: Context) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(ENABLE_PROMPT_NOTIFICATION_ID)
        }
    }
}
