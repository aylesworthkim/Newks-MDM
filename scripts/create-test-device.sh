#!/usr/bin/env bash
curl -X POST http://localhost:4000/api/devices/enroll \
  -H "Content-Type: application/json" \
  -d '{
    "enrollmentSecret":"replace_me",
    "serialNumber":"TEST-ANDROID-001",
    "deviceName":"Test POS Tablet",
    "model":"Android Tablet",
    "androidVersion":"14",
    "locationId":"demo-store"
  }'
