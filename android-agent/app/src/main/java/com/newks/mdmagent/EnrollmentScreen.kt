package com.newks.mdmagent

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Enrollment form. The user fills in:
 *   - Backend URL (e.g. http://172.16.0.125:4000) -- the laptop's LAN IP.
 *   - Device name (friendly name shown in the portal).
 *   - Location ID (Newk's store identifier).
 *   - Enrollment secret (the shared secret from backend/.env).
 *
 * Serial number is derived from ANDROID_ID by [MainActivity] and shown
 * read-only so the user can verify it matches what they expect.
 */
@Composable
fun EnrollmentScreen(serialNumber: String, config: AgentConfig) {
    val scope = rememberCoroutineScope()

    // Production defaults. Backend URL points at the live Cloudways
    // deployment so store managers don't have to retype it during fleet
    // enrollment. Device name + location are intentionally blank so they
    // have to fill in something (per the Newk's naming convention:
    // POS = "<site-id> - Terminal <#>", KDS = "<site-id> - KDS - <station>").
    var backendUrl by remember {
        mutableStateOf("https://phpstack-1474989-6419445.cloudwaysapps.com")
    }
    var deviceName by remember { mutableStateOf("") }
    var locationId by remember { mutableStateOf("") }
    var enrollmentSecret by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Enroll this tablet", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Register this device with the Newk's Remote Device Management portal.",
            style = MaterialTheme.typography.bodyMedium,
        )

        OutlinedTextField(
            value = backendUrl,
            onValueChange = { backendUrl = it },
            label = { Text("Backend URL") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = deviceName,
            onValueChange = { deviceName = it },
            label = { Text("Device name") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = locationId,
            onValueChange = { locationId = it },
            label = { Text("Location ID") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = enrollmentSecret,
            onValueChange = { enrollmentSecret = it },
            label = { Text("Enrollment secret") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )

        Text(
            "Serial: $serialNumber",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Button(
            onClick = {
                errorMessage = null
                submitting = true
                scope.launch {
                    val result = EnrollmentApi.enroll(
                        backendUrl = backendUrl,
                        request = EnrollmentRequest(
                            enrollmentSecret = enrollmentSecret,
                            serialNumber = serialNumber,
                            deviceName = deviceName,
                            locationId = locationId,
                            model = "${Build.MANUFACTURER} ${Build.MODEL}",
                            androidVersion = Build.VERSION.RELEASE,
                            agentVersion = "0.1.0",
                        ),
                    )
                    when (result) {
                        is EnrollmentResult.Success -> {
                            config.saveEnrollment(
                                backendUrl = backendUrl,
                                deviceName = deviceName,
                                locationId = locationId,
                                deviceId = result.deviceId,
                            )
                        }
                        is EnrollmentResult.Failure -> {
                            errorMessage = result.message
                        }
                    }
                    submitting = false
                }
            },
            enabled = !submitting
                && backendUrl.isNotBlank()
                && deviceName.isNotBlank()
                && enrollmentSecret.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (submitting) "Enrolling..." else "Enroll")
        }

        errorMessage?.let {
            Text(it, color = MaterialTheme.colorScheme.error)
        }
    }
}
