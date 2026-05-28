package com.newks.mdmagent

import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Snapshot of what the agent knows about its own configuration. Everything
 * here is observable via [AgentConfig.state] so the UI re-renders the moment
 * enrollment succeeds (or someone clears the device locally).
 *
 * Note: we deliberately do NOT persist the enrollment secret. It is only
 * needed once to prove to the backend that this device is authorized to
 * enroll. After that the deviceId returned by the server is what identifies
 * the device on subsequent calls.
 */
data class AgentState(
    val backendUrl: String = "",
    val deviceName: String = "",
    val locationId: String = "",
    val deviceId: String? = null,
)

class AgentConfig(context: Context) {
    private val prefs = context.applicationContext
        .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val _state = MutableStateFlow(loadState())
    val state: StateFlow<AgentState> = _state.asStateFlow()

    private fun loadState(): AgentState = AgentState(
        backendUrl = prefs.getString(KEY_BACKEND_URL, "") ?: "",
        deviceName = prefs.getString(KEY_DEVICE_NAME, "") ?: "",
        locationId = prefs.getString(KEY_LOCATION_ID, "") ?: "",
        deviceId = prefs.getString(KEY_DEVICE_ID, null),
    )

    fun saveEnrollment(
        backendUrl: String,
        deviceName: String,
        locationId: String,
        deviceId: String,
    ) {
        prefs.edit {
            putString(KEY_BACKEND_URL, backendUrl.trimEnd('/'))
            putString(KEY_DEVICE_NAME, deviceName)
            putString(KEY_LOCATION_ID, locationId)
            putString(KEY_DEVICE_ID, deviceId)
        }
        _state.value = loadState()
    }

    /**
     * Wipe local enrollment. The deviceId still exists on the server until
     * an admin retires the row -- this is purely a "forget on this device"
     * action useful during development and after a factory reset.
     */
    fun clearEnrollment() {
        prefs.edit { clear() }
        _state.value = loadState()
    }

    companion object {
        private const val PREFS_NAME = "agent_config"
        private const val KEY_BACKEND_URL = "backend_url"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_LOCATION_ID = "location_id"
        private const val KEY_DEVICE_ID = "device_id"
    }
}
