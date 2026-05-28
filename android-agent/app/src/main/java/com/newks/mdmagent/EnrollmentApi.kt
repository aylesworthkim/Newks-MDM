package com.newks.mdmagent

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Network call against POST /api/devices/enroll. Field names match exactly
 * what the backend's zod schema expects (see backend/src/routes/devices.ts).
 */
@Serializable
data class EnrollmentRequest(
    val enrollmentSecret: String,
    val serialNumber: String,
    val deviceName: String,
    val locationId: String,
    val model: String? = null,
    val androidVersion: String? = null,
    val agentVersion: String? = null,
)

@Serializable
private data class EnrollmentSuccessBody(val deviceId: String)

@Serializable
private data class ErrorBody(val error: String? = null)

sealed class EnrollmentResult {
    data class Success(val deviceId: String) : EnrollmentResult()
    data class Failure(val message: String) : EnrollmentResult()
}

object EnrollmentApi {
    private val client = OkHttpClient()
    private val json = Json { ignoreUnknownKeys = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    suspend fun enroll(backendUrl: String, request: EnrollmentRequest): EnrollmentResult =
        withContext(Dispatchers.IO) {
            try {
                val body = json
                    .encodeToString(EnrollmentRequest.serializer(), request)
                    .toRequestBody(jsonMedia)
                val httpReq = Request.Builder()
                    .url("${backendUrl.trimEnd('/')}/api/devices/enroll")
                    .post(body)
                    .build()

                client.newCall(httpReq).execute().use { response ->
                    val raw = response.body?.string().orEmpty()
                    if (response.isSuccessful) {
                        val parsed = json.decodeFromString(
                            EnrollmentSuccessBody.serializer(),
                            raw,
                        )
                        EnrollmentResult.Success(parsed.deviceId)
                    } else {
                        // Try to surface the backend's structured error.
                        val message = try {
                            json.decodeFromString(ErrorBody.serializer(), raw).error
                        } catch (_: Exception) {
                            null
                        } ?: "HTTP ${response.code}"
                        EnrollmentResult.Failure(message)
                    }
                }
            } catch (e: Exception) {
                EnrollmentResult.Failure(e.message ?: "network error")
            }
        }
}
