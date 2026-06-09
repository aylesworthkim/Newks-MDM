package com.newks.mdmagent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.ByteArrayOutputStream

/**
 * AccessibilityService -- the single load-bearing capability for remote
 * support in v0.5.0+.
 *
 * Two responsibilities:
 *   1. Dispatching input gestures (taps, swipes) and global system actions
 *      (BACK / HOME / RECENTS) to the device.
 *   2. Capturing screen frames via [takeScreenshot]. This replaces the
 *      previous MediaProjection-based capture, which required the user to
 *      tap "Start now" on a system consent dialog at the start of every
 *      session (and again after every reboot). With accessibility-based
 *      capture, the user grants the service ONCE in Settings; support
 *      staff can then view + control the tablet across reboots with no
 *      per-session friction.
 *
 * The user must enable this service in
 *   Settings -> Accessibility -> Newk's MDM Agent
 * before remote support will work AT ALL. The companion provides
 * [isEnabled] and [isEnabledInSettings] so the heartbeat layer can report
 * status to the portal and the in-app UI can surface a "tap to enable"
 * prompt.
 *
 * SECURITY NOTE: accessibility services are a massive trust grant. We
 * deliberately don't subscribe to event content (no canRetrieveWindowContent),
 * we don't log keystrokes, and we don't proactively scrape the screen --
 * screenshots are only taken when a support session is active and the
 * support user has explicitly initiated capture from the portal.
 */
class AgentAccessibilityService : AccessibilityService() {

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Intentionally a no-op. We don't observe; we only dispatch + capture.
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

        /**
         * Capture a screenshot via the AccessibilityService API. Replaces
         * MediaProjection-based capture so support can view the screen
         * without the user tapping "Start now" on a system consent dialog.
         *
         * Requirements:
         *   - This service must be enabled (Settings -> Accessibility).
         *   - The accessibility-service config XML must have
         *     `canTakeScreenshot="true"`.
         *   - API 30 (Android 11) or higher. (Our minSdk is 26 but
         *     takeScreenshot is API 30+. Older devices won't get frames;
         *     [isScreenshotSupported] reports the runtime capability.)
         *
         * Android rate-limits this to roughly one call per 333ms. At our
         * default 1 fps capture loop we're well under the cap.
         *
         * @param scale 0.0 < scale <= 1.0; downscales the captured bitmap
         *     to save bandwidth. 0.5 halves both dimensions (1/4 area).
         * @param jpegQuality 0-100; standard JPEG quality.
         * @param callback Invoked with the encoded JPEG bytes on success,
         *     or null on any failure (rate limited, service not connected,
         *     hardware-buffer copy failed, etc.).
         */
        fun captureFrame(
            scale: Float,
            jpegQuality: Int,
            callback: (jpeg: ByteArray?) -> Unit,
        ) {
            val svc = instance ?: run {
                callback(null)
                return
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                Log.w(TAG, "captureFrame: takeScreenshot requires API 30+")
                callback(null)
                return
            }
            try {
                svc.takeScreenshot(
                    Display.DEFAULT_DISPLAY,
                    svc.mainExecutor,
                    object : AccessibilityService.TakeScreenshotCallback {
                        override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                            try {
                                val jpeg = encodeScreenshot(screenshot, scale, jpegQuality)
                                callback(jpeg)
                            } catch (e: Exception) {
                                Log.w(TAG, "captureFrame post-processing failed", e)
                                callback(null)
                            } finally {
                                try { screenshot.hardwareBuffer.close() } catch (_: Exception) { /* ignore */ }
                            }
                        }

                        override fun onFailure(errorCode: Int) {
                            // Common error codes:
                            //   ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY (-1)
                            //   ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR (-2)
                            //   ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT (-3) -- rate limited
                            //   ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS (-4)
                            // We don't bubble the code; the next frame attempt will retry.
                            Log.w(TAG, "takeScreenshot failed with errorCode=$errorCode")
                            callback(null)
                        }
                    },
                )
            } catch (e: Exception) {
                Log.w(TAG, "takeScreenshot threw", e)
                callback(null)
            }
        }

        /** Runtime check: is the device on a version that supports
         *  accessibility-based screen capture? */
        fun isScreenshotSupported(): Boolean =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

        /**
         * Paste [text] into the currently-focused editable field on the
         * device. Used by the v0.7.0+ clipboard-share feature: the
         * operator hits Ctrl+V on the remote screen view in the browser,
         * the browser sends an INPUT_PASTE WS message, ConnectionManager
         * routes it here.
         *
         * Implementation: write to the device's clipboard via
         * ClipboardManager, then dispatch ACTION_PASTE on the focused
         * node so the field receives the paste like a normal user paste.
         * Falls back to ACTION_SET_TEXT (which replaces the entire field
         * content) if the focused node doesn't expose ACTION_PASTE --
         * typically because it's a custom text input that didn't wire it
         * up.
         *
         * Returns true if a focused editable was found and the paste was
         * dispatched. Returns false on no focused field, no editable, or
         * dispatch failure -- the caller surfaces the failure as
         * INPUT_RESULT.ok=false so the operator sees an actionable error.
         *
         * Requires `canRetrieveWindowContent="true"` in the accessibility
         * config XML (added in v0.7.0).
         */
        fun pasteText(context: Context, text: String): Boolean {
            val svc = instance ?: return false
            return try {
                val root = svc.rootInActiveWindow ?: run {
                    Log.w(TAG, "pasteText: no active window root")
                    return false
                }
                val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: run {
                    Log.w(TAG, "pasteText: no focused input on screen")
                    return false
                }

                val supportsPaste = focused.actionList.any { it.id == AccessibilityNodeInfo.ACTION_PASTE }
                if (supportsPaste) {
                    // Standard paste path -- preserves cursor position, inserts at it.
                    val clip = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clip.setPrimaryClip(ClipData.newPlainText("paste", text))
                    return focused.performAction(AccessibilityNodeInfo.ACTION_PASTE)
                }

                // Fallback: replace the whole field. Less surgical but works for
                // most editable views including custom inputs.
                Log.d(TAG, "pasteText: ACTION_PASTE not exposed; falling back to ACTION_SET_TEXT")
                val args = Bundle().apply {
                    putCharSequence(
                        AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                        text,
                    )
                }
                focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            } catch (e: Exception) {
                Log.w(TAG, "pasteText failed", e)
                false
            }
        }

        @androidx.annotation.RequiresApi(Build.VERSION_CODES.R)
        private fun encodeScreenshot(
            screenshot: AccessibilityService.ScreenshotResult,
            scale: Float,
            jpegQuality: Int,
        ): ByteArray? {
            // wrapHardwareBuffer gives us a hardware-backed bitmap. We need a
            // software bitmap to compress JPEG, so copy into ARGB_8888 first.
            val hwBitmap = Bitmap.wrapHardwareBuffer(
                screenshot.hardwareBuffer,
                screenshot.colorSpace,
            ) ?: return null
            val software = hwBitmap.copy(Bitmap.Config.ARGB_8888, false)
            hwBitmap.recycle()
            if (software == null) return null

            val scaled = if (scale != 1.0f) {
                val w = (software.width * scale).toInt().coerceAtLeast(2)
                val h = (software.height * scale).toInt().coerceAtLeast(2)
                Bitmap.createScaledBitmap(software, w, h, true).also {
                    if (it !== software) software.recycle()
                }
            } else {
                software
            }

            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out)
            scaled.recycle()
            return out.toByteArray()
        }
    }
}
