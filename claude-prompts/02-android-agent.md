# Claude Code Prompt: Android Agent

Expand the Android agent into a basic working MDM agent.

## Goals

1. Add an enrollment screen with backend URL, device name, location ID, and enrollment secret.
2. POST to /api/devices/enroll.
3. Store returned device ID securely.
4. Create a foreground heartbeat service.
5. Connect to backend WebSocket at /ws.
6. Send REGISTER_SOCKET and HEARTBEAT messages.
7. Receive PING and FETCH_DIAGNOSTICS commands.
8. Display command status in the app.

## Important

Do not implement hidden or stealth behavior. This is for owned/managed POS devices only.
