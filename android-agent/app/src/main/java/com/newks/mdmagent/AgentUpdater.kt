package com.newks.mdmagent

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * In-app updater. Fetches `${backendUrl}/agent-version.json`, compares the
 * `versionCode` against our own. If the server advertises a newer version,
 * downloads the APK to our cache dir and posts a high-priority notification
 * that opens Android's Package Installer when tapped.
 *
 * Workflow when shipping a new agent version:
 *   1. Build APK in Android Studio, bump build.gradle versionCode/versionName.
 *   2. Update frontend/public/agent-version.json with the new versionCode +
 *      versionName + (optional) sha256 + releaseNotes.
 *   3. git push, server pulls + rebuilds Vite.
 *   4. Every tablet's next HeartbeatService start picks up the new version
 *      and prompts the store manager to tap to install. No SureMDM
 *      involvement once tablets are running v0.7.0+.
 *
 * Updates are user-tap to install. Android refuses silent installs for
 * regular apps -- only Device Owner apps can do that, which our agent
 * deliberately isn't. The notification is just the prompt.
 */
class AgentUpdater(private val context: Context) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Result of a single update-check attempt. Returned from [checkAndPrompt]
     * so callers (notably the CHECK_FOR_UPDATE command handler) can surface
     * the outcome back to the portal instead of guessing.
     */
    sealed class UpdateCheckResult {
        data class UpToDate(val currentVersionCode: Int, val latestVersionCode: Int) : UpdateCheckResult()
        data class NewerAvailable(val info: AgentVersionInfo, val notificationPosted: Boolean) : UpdateCheckResult()
        data class Failed(val reason: String) : UpdateCheckResult()
    }

    /**
     * Hits the version endpoint, compares, downloads + prompts if newer.
     * Safe to call from a coroutine; runs the network calls on IO. Always
     * returns an [UpdateCheckResult] so callers can report status; AgentLog
     * also captures the same information for retrieval via FETCH_DIAGNOSTICS.
     */
    suspend fun checkAndPrompt(backendUrl: String): UpdateCheckResult {
        if (backendUrl.isBlank()) {
            return UpdateCheckResult.Failed("backendUrl is blank")
        }
        return withContext(Dispatchers.IO) {
            val infoUrl = backendUrl.trimEnd('/') + VERSION_PATH
            AgentLog.d(TAG, "checking for update at $infoUrl")
            try {
                val infoReq = Request.Builder().url(infoUrl).build()
                client.newCall(infoReq).execute().use { r ->
                    if (!r.isSuccessful) {
                        val msg = "version check failed: HTTP ${r.code}"
                        AgentLog.w(TAG, msg)
                        return@withContext UpdateCheckResult.Failed(msg)
                    }
                    val body = r.body?.string()
                    if (body.isNullOrEmpty()) {
                        AgentLog.w(TAG, "version check returned empty body")
                        return@withContext UpdateCheckResult.Failed("empty body from $infoUrl")
                    }
                    val info = json.decodeFromString(AgentVersionInfo.serializer(), body)

                    val current = currentVersionCode()
                    if (info.versionCode <= current) {
                        AgentLog.d(TAG, "agent up to date (current=$current, latest=${info.versionCode})")
                        return@withContext UpdateCheckResult.UpToDate(current, info.versionCode)
                    }

                    AgentLog.d(TAG, "newer agent available: ${info.versionName} (code ${info.versionCode})")
                    val posted = downloadAndPrompt(backendUrl, info)
                    return@withContext UpdateCheckResult.NewerAvailable(info, posted)
                }
            } catch (e: Exception) {
                AgentLog.w(TAG, "update check failed", e)
                return@withContext UpdateCheckResult.Failed(
                    "${e.javaClass.simpleName}: ${e.message ?: "no message"}",
                )
            }
        }
    }

    fun currentVersionCode(): Int {
        return try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            @Suppress("DEPRECATION")
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                info.longVersionCode.toInt()
            } else {
                info.versionCode
            }
        } catch (e: Exception) {
            AgentLog.w(TAG, "currentVersionCode failed", e)
            0
        }
    }

    /**
     * Downloads the APK (if not already cached) and posts the install-prompt
     * notification. Returns true if a notification was posted, false on any
     * failure along the way.
     */
    private fun downloadAndPrompt(backendUrl: String, info: AgentVersionInfo): Boolean {
        val absUrl = if (info.downloadUrl.startsWith("http")) info.downloadUrl
        else backendUrl.trimEnd('/') + info.downloadUrl

        val apkFile = File(context.cacheDir, "newks-mdm-agent-${info.versionCode}.apk")
        // Skip the download if we already have this exact version cached
        // (e.g., the user dismissed the notification last time without installing).
        if (!apkFile.exists() || apkFile.length() == 0L) {
            AgentLog.d(TAG, "downloading APK from $absUrl")
            val dlReq = Request.Builder().url(absUrl).build()
            client.newCall(dlReq).execute().use { resp ->
                if (!resp.isSuccessful) {
                    AgentLog.w(TAG, "APK download failed: HTTP ${resp.code}")
                    return false
                }
                val body = resp.body
                if (body == null) {
                    AgentLog.w(TAG, "APK download response had no body")
                    return false
                }
                body.byteStream().use { input ->
                    apkFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
            }
            AgentLog.d(TAG, "downloaded ${apkFile.length()} bytes to ${apkFile.path}")
        } else {
            AgentLog.d(TAG, "APK for v${info.versionCode} already cached at ${apkFile.path}")
        }

        postUpdateNotification(info, apkFile)
        return true
    }

    private fun postUpdateNotification(info: AgentVersionInfo, apkFile: File) {
        ensureNotificationChannel()

        // FileProvider URI so the Package Installer (a different app) can read
        // our cache file. Granting via FLAG_GRANT_READ_URI_PERMISSION on the
        // Intent below.
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            apkFile,
        )
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val pendingIntent = PendingIntent.getActivity(
            context, 0, installIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val bigText = buildString {
            append("Tap to install Newk's MDM Agent v${info.versionName}.")
            info.releaseNotes?.let { notes ->
                append("\n\nWhat's new: ")
                append(notes)
            }
            append("\n\nAndroid will ask once for permission to install from this source.")
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle("Newk's MDM Agent update")
            .setContentText("v${info.versionName} is ready to install")
            .setStyle(NotificationCompat.BigTextStyle().bigText(bigText))
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, notification)
        AgentLog.d(TAG, "posted update notification for v${info.versionName}")
    }

    private fun ensureNotificationChannel() {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Agent updates",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "Notifies when a new version of Newk's MDM Agent is ready to install"
                    setShowBadge(true)
                },
            )
        }
    }

    @Serializable
    data class AgentVersionInfo(
        val versionCode: Int,
        val versionName: String,
        val downloadUrl: String,
        val sha256: String? = null,
        val releaseNotes: String? = null,
    )

    companion object {
        private const val TAG = "NewksMdm"
        private const val CHANNEL_ID = "mdm_agent_updates"
        private const val NOTIFICATION_ID = 1004
        private const val VERSION_PATH = "/agent-version.json"
    }
}
