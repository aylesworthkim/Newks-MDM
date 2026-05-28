package com.newks.mdmagent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Auto-starts the agent after the tablet finishes booting so it reconnects
 * to the portal without anyone opening the app first. This is how SureMDM
 * and similar MDM agents survive reboots -- BOOT_COMPLETED is a standard
 * Android broadcast available to any app with RECEIVE_BOOT_COMPLETED
 * permission. No device-owner privileges required.
 *
 * Caveats baked into Android, not ours:
 *   - The app must be opened at least once after install before BOOT_COMPLETED
 *     fires (Android 7+ security feature). After that, every reboot.
 *   - If the user force-stops the agent via Settings, this receiver won't fire
 *     until they open the app again.
 *   - Some OEM aggressive-battery-saver layers (Xiaomi MIUI etc.) can block
 *     auto-start; Toast TT500 is stock-ish AOSP so should be fine.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val config = AgentConfig(context.applicationContext)
        if (config.state.value.deviceId == null) {
            // Not enrolled yet -- nothing useful to do. Launching the
            // foreground service here would show a "connecting..." notification
            // forever on a tablet that's never been set up.
            Log.d(TAG, "boot complete but no enrollment on file; not starting agent")
            return
        }
        Log.d(TAG, "boot complete; starting HeartbeatService for ${config.state.value.deviceId}")
        HeartbeatService.start(context.applicationContext)
    }

    companion object {
        private const val TAG = "NewksMdm"
    }
}
