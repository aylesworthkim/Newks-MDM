# Claude Code Prompt: Remote Screen POC

Design and implement a safe proof-of-concept for remote screen viewing.

## Goals

1. Add backend remote session endpoints.
2. Add WebRTC signaling messages over WebSocket.
3. Add frontend remote session page.
4. Add Android MediaProjection permission prompt.
5. Stream screen from Android agent to web portal.
6. Log session start, stop, requester, and device.

## Guardrails

- Require explicit permission on Android unless device-owner mode is later implemented.
- Show a visible notification during remote sessions.
- Do not add remote input control yet. Viewing only.
