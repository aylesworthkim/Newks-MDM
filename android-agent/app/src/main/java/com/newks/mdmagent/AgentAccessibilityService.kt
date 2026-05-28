package com.newks.mdmagent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Path
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * AccessibilityService whose only role is dispatching input gestures
 * (taps + swipes) and global system actions (BACK / HOME / RECENTS) during
 * an active remote-control session.
 *
 * The user must manually enable this service in
 *   Settings -> Accessibility -> Newk's MDM Agent
 * before remote input will work. The companion provides [isEnabled] and
 * [intentToOpenSettings] so the UI can show status + deep-link to the
 * settings screen.
 *
 * SECURITY NOTE: accessibility services are a massive trust grant. We
 * deliberately don't subscribe to any event content (no
 * canRetrieveWindowContent) and ignore the typeWindowStateChanged events
 * we're forced to declare. Nothing on-screen is read, logged, or sent
 * back to the server -- only the gestures the support user explicitly
 * triggers from the portal are dispatched here.
 */
class AgentAccessibilityService : AccessibilityService() {

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Intentionally a no-op. We don't observe; we only dispatch.
    }

    override fun onInterrupt() {
        // No-op.
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.d(TAG, "accessibility service connected")
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    companion object {
        private const val TAG = "NewksMdm"
        private const val TAP_DURATION_MS = 60L

        @Volatile
        private var instance: AgentAccessibilityService? = null

        /**
         * True only when the service is actually bound and running. Returns
         * false if the user enabled it but it hasn't yet connected, but
         * also if the user disabled it -- either way we shouldn't try to
         * dispatch.
         */
        fun isEnabled(): Boolean = instance != null

        /**
         * Survives the user enabling the service from system Settings even
         * though we can't tell `instance` is set yet. Use this when we want
         * to know "did the user toggle us on in Settings" vs. the binding
         * state.
         */
        fun isEnabledInSettings(context: Context): Boolean {
            val expected = context.packageName + "/" + AgentAccessibilityService::class.java.canonicalName
            val enabledList = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            ) ?: return false
            val splitter = TextUtils.SimpleStringSplitter(':').apply { setString(enabledList) }
            for (svc in splitter) {
                if (svc.equals(expected, ignoreCase = true)) return true
            }
            return false
        }

        fun dispatchTap(
            xPx: Float,
            yPx: Float,
            callback: GestureResultCallback,
        ) {
            val svc = instance ?: run {
                callback.onCancelled(null)
                return
            }
            val path = Path().apply { moveTo(xPx, yPx) }
            val stroke = GestureDescription.StrokeDescription(path, 0, TAP_DURATION_MS)
            val gesture = GestureDescription.Builder().addStroke(stroke).build()
            try {
                svc.dispatchGesture(gesture, callback, null)
            } catch (e: Exception) {
                Log.w(TAG, "dispatchTap failed", e)
                callback.onCancelled(null)
            }
        }

        fun dispatchSwipe(
            fromXPx: Float,
            fromYPx: Float,
            toXPx: Float,
            toYPx: Float,
            durationMs: Long,
            callback: GestureResultCallback,
        ) {
            val svc = instance ?: run {
                callback.onCancelled(null)
                return
            }
            val path = Path().apply {
                moveTo(fromXPx, fromYPx)
                lineTo(toXPx, toYPx)
            }
            val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(50, 3000))
            val gesture = GestureDescription.Builder().addStroke(stroke).build()
            try {
                svc.dispatchGesture(gesture, callback, null)
            } catch (e: Exception) {
                Log.w(TAG, "dispatchSwipe failed", e)
                callback.onCancelled(null)
            }
        }

        /**
         * Synchronous, since performGlobalAction is itself synchronous.
         * Returns true if the action was dispatched.
         */
        fun performGlobalKey(key: String): Boolean {
            val svc = instance ?: return false
            val action = when (key) {
                "BACK" -> GLOBAL_ACTION_BACK
                "HOME" -> GLOBAL_ACTION_HOME
                "RECENTS" -> GLOBAL_ACTION_RECENTS
                else -> return false
            }
            return svc.performGlobalAction(action)
        }
    }
}
