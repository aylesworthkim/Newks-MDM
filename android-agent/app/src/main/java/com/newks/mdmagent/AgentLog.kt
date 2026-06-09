package com.newks.mdmagent

import android.util.Log
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

/**
 * Thread-safe in-memory ring buffer of recent agent log lines.
 *
 * Why this exists:
 *   Most of the fleet is deployed in stores where IT has no adb access. When
 *   the in-app updater (or any other subsystem) silently fails, we have no
 *   way to read logcat. AgentLog records the same lines we send to logcat
 *   into a bounded in-memory buffer, and CommandExecutor.diagnostics()
 *   surfaces them via FETCH_DIAGNOSTICS so support staff can see what the
 *   agent is doing without touching the tablet.
 *
 * Usage:
 *   Call [AgentLog.d], [AgentLog.w], [AgentLog.e] instead of android.util.Log
 *   in agent code paths whose behavior we may need to debug remotely
 *   (network calls, update checks, command handling, session lifecycle).
 *   These delegate to android.util.Log AND append to the ring buffer.
 *
 * Bounded at [MAX_ENTRIES] lines (~200) to cap memory; oldest lines drop off
 * the back as new ones come in.
 */
object AgentLog {
    private const val MAX_ENTRIES = 200
    private val buffer = ArrayDeque<String>(MAX_ENTRIES)
    private val tsFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    fun d(tag: String, message: String) {
        Log.d(tag, message)
        append('D', tag, message)
    }

    fun w(tag: String, message: String, t: Throwable? = null) {
        if (t != null) Log.w(tag, message, t) else Log.w(tag, message)
        append('W', tag, message + (t?.let { " :: ${it.javaClass.simpleName}: ${it.message}" } ?: ""))
    }

    fun e(tag: String, message: String, t: Throwable? = null) {
        if (t != null) Log.e(tag, message, t) else Log.e(tag, message)
        append('E', tag, message + (t?.let { " :: ${it.javaClass.simpleName}: ${it.message}" } ?: ""))
    }

    private fun append(level: Char, tag: String, message: String) {
        val line = "${tsFormat.format(Date())} $level/$tag $message"
        synchronized(buffer) {
            if (buffer.size >= MAX_ENTRIES) buffer.pollFirst()
            buffer.addLast(line)
        }
    }

    /**
     * Returns a snapshot of the most recent log lines (newest last), capped
     * at [limit]. Caller gets a copy so concurrent appends from other threads
     * don't mutate the returned list.
     */
    fun snapshot(limit: Int = MAX_ENTRIES): List<String> {
        synchronized(buffer) {
            if (buffer.size <= limit) return buffer.toList()
            // Take the last [limit] entries.
            val drop = buffer.size - limit
            return buffer.drop(drop).toList()
        }
    }
}
