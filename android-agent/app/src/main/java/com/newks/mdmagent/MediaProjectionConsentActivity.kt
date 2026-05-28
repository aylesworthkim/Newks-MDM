package com.newks.mdmagent

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/**
 * Invisible activity whose only job is to surface Android's screen-capture
 * consent dialog and forward the result to [ScreenCaptureService].
 *
 * Why an activity at all: createScreenCaptureIntent() returns an Intent that
 * must be launched via startActivityForResult. Service / background
 * contexts can't show that dialog directly. So when START_SESSION arrives
 * we launch this transparent activity, it shows the consent, gets the
 * result, starts the capture service, and finishes itself.
 */
class MediaProjectionConsentActivity : ComponentActivity() {

    private val launcher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
        val preArm = intent.getBooleanExtra(EXTRA_PRE_ARM, false)

        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            // Permission granted -- hand the token to ScreenCaptureService.
            // If we have a sessionId, the service starts capture immediately.
            // If we're in pre-arm mode (post-boot prompt), the service just
            // caches the projection and stays idle until the next START_SESSION
            // arrives from the backend -- which will then skip the dialog
            // because the projection is already armed.
            val svcIntent = Intent(this, ScreenCaptureService::class.java).apply {
                putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(ScreenCaptureService.EXTRA_DATA, result.data)
                if (sessionId != null) putExtra(ScreenCaptureService.EXTRA_SESSION_ID, sessionId)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(svcIntent)
            } else {
                startService(svcIntent)
            }
        } else {
            // User declined or the system canceled. Only the per-session path
            // needs to tell the backend; pre-arm denials are silent (the user
            // can still grant later when IT initiates a session).
            if (sessionId != null) {
                SessionCoordinator.notifyDenied(applicationContext, sessionId, "user declined")
            } else if (preArm) {
                Log.d(TAG, "pre-arm consent denied or cancelled; no backend signal needed")
            }
        }
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // If the projection is already armed (cached from a previous prompt),
        // there's no consent to ask for. Useful when the pre-arm notification
        // is tapped twice or the user retriggers via some future UI button.
        if (ScreenCaptureService.hasActiveProjection) {
            Log.d(TAG, "projection already armed; nothing to do")
            finish()
            return
        }

        val mpm = getSystemService(MediaProjectionManager::class.java)
        if (mpm == null) {
            Log.w(TAG, "MediaProjectionManager unavailable; finishing")
            val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
            if (sessionId != null) {
                SessionCoordinator.notifyDenied(applicationContext, sessionId, "no projection manager")
            }
            finish()
            return
        }
        launcher.launch(mpm.createScreenCaptureIntent())
    }

    companion object {
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_PRE_ARM = "pre_arm"
        private const val TAG = "NewksMdm"

        /** Per-session launch -- called from [SessionCoordinator.requestStart]
         *  when a START_SESSION arrives and we don't yet have a cached
         *  projection. Surfaces the system "Start now" dialog. */
        fun launch(context: android.content.Context, sessionId: String) {
            val intent = Intent(context, MediaProjectionConsentActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
                putExtra(EXTRA_SESSION_ID, sessionId)
            }
            context.startActivity(intent)
        }

        /** Pre-arm intent -- used as the PendingIntent on the "Tap to enable
         *  remote support" notification posted by HeartbeatService after boot.
         *  Surfaces the same system consent dialog, but on grant the resulting
         *  MediaProjection is cached without starting capture. The next
         *  IT-initiated session reuses the cached token silently. */
        fun preArmIntent(context: android.content.Context): Intent {
            return Intent(context, MediaProjectionConsentActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
                putExtra(EXTRA_PRE_ARM, true)
            }
        }
    }
}
