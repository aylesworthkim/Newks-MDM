package com.newks.mdmagent

import android.content.Context
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier

/**
 * Top-level Compose root.
 *
 * Two screens for now:
 *   - EnrollmentScreen: shown when AgentConfig has no stored deviceId.
 *   - ConnectedScreen: shown once we have a deviceId.
 *
 * Side effect: whenever a deviceId becomes present, start the foreground
 * heartbeat service. Whenever it goes back to null (user cleared
 * enrollment), stop the service and tear down the connection.
 */
@Composable
fun AgentApp(appContext: Context, serialNumber: String) {
    val config = remember { AgentConfig(appContext) }
    val state by config.state.collectAsState()

    LaunchedEffect(state.deviceId) {
        if (state.deviceId != null) {
            HeartbeatService.start(appContext)
        } else {
            HeartbeatService.stop(appContext)
            ConnectionManager.getOrCreate(appContext, config).stop()
        }
    }

    MaterialTheme {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background,
        ) {
            if (state.deviceId == null) {
                EnrollmentScreen(serialNumber = serialNumber, config = config)
            } else {
                ConnectedScreen(state = state, config = config)
            }
        }
    }
}
