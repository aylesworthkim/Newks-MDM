package com.newks.mdmagent

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Carries out the four allowlisted command types we accept. NEW COMMAND
 * TYPES MUST BE ADDED HERE, in the backend zod schema, AND in the database
 * CHECK constraint -- all three layers must agree (see commands.ts).
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

    fun execute(commandType: String, payload: JsonObject): CommandResult {
        return try {
            when (commandType) {
                "PING" -> ping()
                "FETCH_DIAGNOSTICS" -> diagnostics()
                "OPEN_APP" -> openApp(payload)
                "RESTART_APP" -> restartApp(payload)
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
        return CommandResult(
            ok = true,
            detail = buildJsonObject {
                put("manufacturer", Build.MANUFACTURER)
                put("model", Build.MODEL)
                put("device", Build.DEVICE)
                put("androidVersion", Build.VERSION.RELEASE)
                put("sdkInt", Build.VERSION.SDK_INT)
                put("uptimeMillis", SystemClock.uptimeMillis())
                put("freeMemBytes", runtime.freeMemory())
                put("totalMemBytes", runtime.totalMemory())
                put("maxMemBytes", runtime.maxMemory())
            },
            summary = "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}",
        )
    }

    private fun openApp(payload: JsonObject): CommandResult {
        val packageName = payload["package"]?.jsonPrimitive?.contentOrNull
            ?: return failure("missing 'package' field")
        val intent = context.packageManager.getLaunchIntentForPackage(packageName)
            ?: return failure("package not installed: $packageName")
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
}
