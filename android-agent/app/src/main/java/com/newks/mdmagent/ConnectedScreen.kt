package com.newks.mdmagent

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Post-enrollment screen. Shows live connection status pulled from the
 * singleton [ConnectionManager], the accessibility-service status (required
 * for remote control to work), and a rolling log of recent commands.
 */
@Composable
fun ConnectedScreen(state: AgentState, config: AgentConfig) {
    val context = LocalContext.current
    val manager = remember { ConnectionManager.getOrCreate(context.applicationContext, config) }

    val connectionState by manager.connectionState.collectAsState()
    val commandLog by manager.commandLog.collectAsState()

    // Re-check accessibility status periodically so the UI reflects the
    // user toggling the service in Settings without needing an app restart.
    var accessibilityEnabled by remember {
        mutableStateOf(AgentAccessibilityService.isEnabledInSettings(context))
    }
    LaunchedEffect(Unit) {
        while (true) {
            accessibilityEnabled = AgentAccessibilityService.isEnabledInSettings(context)
            delay(1500)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Newk's MDM Agent", style = MaterialTheme.typography.headlineSmall)

        // Connection status card
        Card {
            Column(
                modifier = Modifier
                    .padding(16.dp)
                    .fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(connectionState)
                    Spacer(Modifier.size(8.dp))
                    Text(
                        text = when (connectionState) {
                            ConnectionState.CONNECTED -> "Connected"
                            ConnectionState.CONNECTING -> "Connecting..."
                            ConnectionState.DISCONNECTED -> "Disconnected"
                        },
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
                Text("Device: ${state.deviceName}", style = MaterialTheme.typography.bodyMedium)
                Text("Location: ${state.locationId}", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "Backend: ${state.backendUrl}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "ID: ${state.deviceId}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // Remote control status card
        Card {
            Column(
                modifier = Modifier
                    .padding(16.dp)
                    .fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AccessibilityDot(accessibilityEnabled)
                    Spacer(Modifier.size(8.dp))
                    Text(
                        text = if (accessibilityEnabled)
                            "Remote control enabled"
                        else
                            "Remote control disabled",
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
                Text(
                    text = if (accessibilityEnabled)
                        "Support staff can remotely tap and swipe during an active screen session."
                    else
                        "To allow Newk's support to remotely tap and swipe, enable accessibility " +
                            "for this app in system Settings.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!accessibilityEnabled) {
                    TextButton(onClick = {
                        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        context.startActivity(intent)
                    }) {
                        Text("Open Accessibility settings")
                    }
                }
            }
        }

        Text("Recent commands", style = MaterialTheme.typography.titleMedium)
        if (commandLog.isEmpty()) {
            Text(
                "Nothing yet. Issue a command from the portal -- it should show up here within a second.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(commandLog, key = { it.commandId }) { entry ->
                    Card {
                        Column(
                            modifier = Modifier
                                .padding(12.dp)
                                .fillMaxWidth(),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            Text(entry.commandType, style = MaterialTheme.typography.titleSmall)
                            Text(
                                "${entry.status} - ${formatTime(entry.receivedAt)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            entry.resultSummary?.let {
                                Text(it, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.size(8.dp))
        OutlinedButton(onClick = { config.clearEnrollment() }) {
            Text("Forget this enrollment")
        }
    }
}

@Composable
private fun StatusDot(state: ConnectionState) {
    val color = when (state) {
        ConnectionState.CONNECTED -> Color(0xFF22C55E)
        ConnectionState.CONNECTING -> Color(0xFFEAB308)
        ConnectionState.DISCONNECTED -> Color(0xFFEF4444)
    }
    Surface(
        shape = CircleShape,
        color = color,
        modifier = Modifier.size(12.dp),
        content = {},
    )
}

@Composable
private fun AccessibilityDot(enabled: Boolean) {
    Surface(
        shape = CircleShape,
        color = if (enabled) Color(0xFF22C55E) else Color(0xFF6B7280),
        modifier = Modifier.size(12.dp),
        content = {},
    )
}

private val timeFmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
private fun formatTime(millis: Long): String = timeFmt.format(Date(millis))
