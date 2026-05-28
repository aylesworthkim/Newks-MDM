package com.newks.mdmagent

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/**
 * Single-activity entry point.
 *
 * Resolves ANDROID_ID once as the device's serial number, requests
 * POST_NOTIFICATIONS on Android 13+ (so the foreground-service notification
 * can render), then hands control to [AgentApp].
 */
class MainActivity : ComponentActivity() {

    private val requestNotificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* no-op: if denied the service still runs, system shows a generic notification */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // POST_NOTIFICATIONS is required on Android 13+ for any app-shown
        // notification, including the foreground-service notification.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        val androidId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
            ?: "unknown-${System.currentTimeMillis()}"

        setContent {
            AgentApp(
                appContext = applicationContext,
                serialNumber = androidId,
            )
        }
    }
}
