package com.newks.mdmagent

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * Carries out the allowlisted command types we accept. NEW COMMAND TYPES
 * MUST BE ADDED HERE, in the backend zod schema, AND in the database CHECK
 * constraint -- all three layers must agree (see commands.ts).
 *
 * Returns a [CommandResult] regardless of outcome; the caller forwards
 * `ok` + `detail` back to the server as a COMMAND_RESULT message.
 */
data class CommandResult(
    val ok: Boolean,
    val detail: JsonObject,
    val summary: String,
)

class CommandExecutor(private val context: Context) {

    /**
     * Suspending because CHECK_FOR_UPDATE has to do a network round-trip
     * to the backend's /agent-version.json endpoint before it can answer.
     * The other commands are synchronous but the whole entry point is
     * suspend to keep the call site uniform.
     */
    suspend fun execute(commandType: String, payload: JsonObject): CommandResult {
        return try {
            when (commandType) {
                "PING" -> ping()
                "FETCH_DIAGNOSTICS" -> diagnostics()
                "OPEN_APP" -> openApp(payload)
                "RESTART_APP" -> restartApp(payload)
                "CHECK_FOR_UPDATE" -> checkForUpdate()
                else -> failure("unknown command type: $commandType")
            }
        } catch (e: Exception) {
            failure(e.message ?: "execution error")
        }
    }

    private fun ping(): CommandResult = CommandResult(
        ok = true,
        detail = buildJsonObject {
            put("ping", "pong")
            put("ts", System.currentTimeMillis())
        },
        summary = "pong",
    )

    private fun diagnostics(): CommandResult {
        val runtime = Runtime.getRuntime()
        val battery = collectBattery()
        val storage = collectStorage()
        val network = collectNetwork()
        val packages = collectUserInstalledPackages()
        val agentVersion = try {
            context.packageManager
                .getPackageInfo(context.packageName, 0)
                .versionName ?: "?"
        } catch (_: Exception) {
            "?"
        }
        // v0.7.2+: ship recent agent log lines as part of diagnostics so
        // support staff can see why the updater or session subsystem is
        // misbehaving without having to plug in adb. Capped at 80 entries
        // to keep the payload reasonable; AgentLog holds up to 200 in
        // memory if we ever raise the cap.
        val recentLogs = AgentLog.snapshot(limit = 80)

        return CommandResult(
            ok = true,
            detail = buildJsonObject {
                put("manufacturer", Build.MANUFACTURER)
                put("model", Build.MODEL)
                put("device", Build.DEVICE)
                put("androidVersion", Build.VERSION.RELEASE)
                put("sdkInt", Build.VERSION.SDK_INT)
                put("agentVersion", agentVersion)
                put("uptimeMillis", SystemClock.uptimeMillis())
                put(
                    "accessibilityEnabled",
                    AgentAccessibilityService.isEnabled() ||
                        AgentAccessibilityService.isEnabledInSettings(context),
                )
                put("freeMemBytes", runtime.freeMemory())
                put("totalMemBytes", runtime.totalMemory())
                put("maxMemBytes", runtime.maxMemory())
                putJsonObject("battery") {
                    put("levelPercent", battery.levelPercent)
                    put("isCharging", battery.isCharging)
                }
                putJsonObject("storage") {
                    put("freeBytes", storage.freeBytes)
                    put("totalBytes", storage.totalBytes)
                }
                putJsonObject("network") {
                    put("connected", network.connected)
                    put("transport", network.transport)
                }
                putJsonArray("installedPackages") {
                    packages.forEach { add(it) }
                }
                putJsonArray("recentLogs") {
                    recentLogs.forEach { add(it) }
                }
            },
            summary = "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}, ${packages.size} user apps, ${recentLogs.size} log lines",
        )
    }

    /**
     * Force an immediate update check against /agent-version.json and
     * report the result. Lets support staff trigger and observe the
     * updater on demand instead of relying on the periodic check that
     * runs on every HeartbeatService start.
     */
    private suspend fun checkForUpdate(): CommandResult {
        val config = AgentConfig(context)
        val backendUrl = config.state.value.backendUrl
        if (backendUrl.isBlank()) {
            return failure("agent not enrolled; no backend URL configured")
        }
        val result = AgentUpdater(context).checkAndPrompt(backendUrl)
        val currentCode = AgentUpdater(context).currentVersionCode()
        return when (result) {
            is AgentUpdater.UpdateCheckResult.UpToDate -> CommandResult(
                ok = true,
                detail = buildJsonObject {
                    put("status", "up_to_date")
                    put("currentVersionCode", result.currentVersionCode)
                    put("latestVersionCode", result.latestVersionCode)
                },
                summary = "up to date (code ${result.currentVersionCode})",
            )
            is AgentUpdater.UpdateCheckResult.NewerAvailable -> CommandResult(
                ok = true,
                detail = buildJsonObject {
                    put("status", "newer_available")
                    put("currentVersionCode", currentCode)
                    put("latestVersionCode", result.info.versionCode)
                    put("latestVersionName", result.info.versionName)
                    put("notificationPosted", result.notificationPosted)
                    result.info.releaseNotes?.let { put("releaseNotes", it) }
                },
                summary = if (result.notificationPosted)
                    "newer version ${result.info.versionName} ready: notification posted"
                else
                    "newer version ${result.info.versionName} found but download/notify failed",
            )
            is AgentUpdater.UpdateCheckResult.Failed -> failure("update check failed: ${result.reason}")
        }
    }

    private fun openApp(payload: JsonObject): CommandResult {
        val packageName = payload["package"]?.jsonPrimitive?.contentOrNull
            ?: return failure("missing 'package' field")
        val intent = context.packageManager.getLaunchIntentForPackage(packageName)
            ?: return failure(
                "package not installed: $packageName " +
                "(run FETCH_DIAGNOSTICS to see installed package names)",
            )
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        return CommandResult(
            ok = true,
            detail = buildJsonObject {
                put("package", packageName)
                put("launched", true)
            },
            summary = "launched $packageName",
        )
    }

    private fun restartApp(payload: JsonObject): CommandResult {
        // A true "restart" needs system-level permission to kill the target
        // process. We don't have that, and granting it would also let us kill
        // anything else -- a non-starter for a POS fleet agent. As a best
        // effort we re-launch the package, which brings it back to the
        // foreground if it was already running and starts it if it wasn't.
        val launched = openApp(payload)
        if (!launched.ok) return launched
        val packageName = payload["package"]?.jsonPrimitive?.contentOrNull ?: "?"
        return launched.copy(summary = "relaunched $packageName")
    }

    private fun failure(message: String) = CommandResult(
        ok = false,
        detail = buildJsonObject { put("error", message) },
        summary = message,
    )

    // ------------------------- Diagnostics helpers -------------------------

    private data class BatteryStats(val levelPercent: Int, val isCharging: Boolean)
    private data class StorageStats(val freeBytes: Long, val totalBytes: Long)
    private data class NetworkStats(val connected: Boolean, val transport: String)

    private fun collectBattery(): BatteryStats {
        return try {
            val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            BatteryStats(
                levelPercent = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY),
                isCharging = bm.isCharging,
            )
        } catch (_: Exception) {
            BatteryStats(-1, false)
        }
    }

    private fun collectStorage(): StorageStats {
        return try {
            val dir = Environment.getDataDirectory()
            StorageStats(freeBytes = dir.freeSpace, totalBytes = dir.totalSpace)
        } catch (_: Exception) {
            StorageStats(-1, -1)
        }
    }

    private fun collectNetwork(): NetworkStats {
        return try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val active = cm.activeNetwork ?: return NetworkStats(false, "none")
            val caps = cm.getNetworkCapabilities(active) ?: return NetworkStats(false, "none")
            val transport = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
                else -> "other"
            }
            NetworkStats(connected = true, transport = transport)
        } catch (_: Exception) {
            NetworkStats(false, "unknown")
        }
    }

    /**
     * List the user-installed (non-system) packages, sorted alphabetically.
     * Useful for OPEN_APP/RESTART_APP -- the operator can run
     * FETCH_DIAGNOSTICS once to learn the exact package name of Toast POS
     * or whatever they want to act on, then send the right command.
     *
     * Requires QUERY_ALL_PACKAGES permission on Android 11+ (in manifest).
     * Returns an empty list on failure rather than throwing -- diagnostics
     * is best-effort.
     */
    private fun collectUserInstalledPackages(): List<String> {
        return try {
            val pm = context.packageManager
            @Suppress("DEPRECATION")
            val apps = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getInstalledApplications(
                    PackageManager.ApplicationInfoFlags.of(0L),
                )
            } else {
                pm.getInstalledApplications(0)
            }
            apps.asSequence()
                .filter { (it.flags and ApplicationInfo.FLAG_SYSTEM) == 0 }
                .map { it.packageName }
                .sorted()
                .toList()
        } catch (_: Exception) {
            emptyList()
        }
    }
}
