# Architecture

## Components

1. Admin Portal: React web app used by support staff.
2. Backend API: Handles auth, device registry, commands, audit logs, and WebRTC signaling later.
3. Android Agent: Installed on each POS device. Maintains heartbeat and executes allowed commands.
4. Database: PostgreSQL for devices, users, command queue, sessions, logs.
5. Realtime Channel: WebSocket initially; MQTT/NATS can be considered later.
6. Remote Session Layer: WebRTC for screen streaming and input events.

## Remote Control Design

The Android device should never accept raw unauthenticated remote input. Recommended model:

- Support user requests remote session.
- Backend creates one-time session token.
- Device agent receives command.
- Device displays consent prompt unless in approved unattended enterprise/device-owner mode.
- Screen stream starts through MediaProjection.
- Input events are sent over WebRTC data channel or secure WebSocket.
- Every event is logged.

## MVP Scope

- Device enrollment
- Heartbeat/status
- Diagnostics command
- App open/restart command
- Manual remote screen share
- Session audit logs
