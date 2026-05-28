# Cloudways Deployment

Production deployment runbook for the Newk's Remote Device Management
backend + portal, hosted on a Cloudways VM with the database on Neon.

## Topology

```
                        Internet
                           │
                           ▼
                 Cloudways VM (NY3)
       ┌─────────────────────────────────┐
       │ nginx (TLS / 443)               │  ← Let's Encrypt cert, Cloudways-managed
       │      │                          │
       │      ▼                          │
       │ Node (pm2, ~/.nvm/bin/node)     │  ← single process serves API + WS + SPA
       │   ├─ /api/*    routes           │
       │   ├─ /ws       upgrade          │
       │   └─ /*        static SPA       │
       └─────────────────────────────────┘
                           │
                           ▼ (sslmode=require)
                   Neon Postgres 16
                  (managed, free tier)
```

Phase 1 target: 50–200 tablets across Newk's locations.

## Cloudways constraints to remember

This is a **managed Cloudways plan**. That means:

- ❌ **No `sudo`**, even on Master Credentials SSH. This is by design.
- ❌ Cannot `apt-get install` anything.
- ❌ Cannot edit `/etc/nginx/`, `/etc/systemd/` directly.
- ✅ User-space tools work fine (nvm, npm globals, pm2 in user mode).
- ✅ nginx and env-var changes go through Cloudways' **Application
  Settings → Custom Settings** (nginx snippets) and **Environment
  Variables** panels.
- ✅ Cloudways support can install system packages via ticket if we
  genuinely need them.

The architecture choices below all live within these guardrails.

## One-time setup

### A. Database (Neon)

1. Sign up at https://neon.tech (GitHub login, no credit card).
2. Create project: name `newks-mdm`, Postgres 16, region **AWS US East**
   (closest to NY3 droplet → lowest query latency), database name
   `remote_mdm`.
3. Copy the connection string from "Connection Details". Looks like:
   ```
   postgresql://newksuser:abcd1234@ep-cool-name-12345.us-east-2.aws.neon.tech/remote_mdm?sslmode=require
   ```
   Store it somewhere safe — you'll paste it into Cloudways env vars in
   step C. **The `?sslmode=require` is mandatory** (Neon enforces TLS).
4. Apply the schema. In Neon's **SQL Editor** tab, paste the entire
   contents of `docs/database-schema.sql` and click **Run**. Then verify:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema='public' ORDER BY table_name;
   ```
   Expected 5 rows: `audit_events`, `commands`, `devices`, `sessions`,
   `users`.

### B. Node runtime on the Cloudways VM

SSH in via Master Credentials (no sudo, that's expected). Most Cloudways
servers running other Node apps already have nvm installed for the
application user.

```bash
# Check what's already there
which node || echo "Node not installed"
node --version 2>/dev/null
which pm2 || echo "pm2 not installed"
ls ~/.nvm/versions/node/ 2>/dev/null
```

**If Node 20 is already there** (likely on a server running other Node
apps): nothing to do here.

**If nvm exists but no Node 20**, install it as the master user:
```bash
nvm install 20
nvm use 20
nvm alias default 20
```

**If nvm doesn't exist at all**:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# Re-source the shell so nvm is on PATH
source ~/.bashrc
nvm install 20
nvm alias default 20
```

**Install pm2 globally** (user-space):
```bash
npm install -g pm2
pm2 --version
```

### C. Application code on the VM

Easiest first deploy: **SFTP via Cloudways' built-in file manager.**
Path on the VM is typically:
```
/home/master/applications/<app-name>/public_html
```

Replace `<app-name>` with the application id Cloudways assigned (visible
under Applications → newks-mdm → Application URL).

Two options:

**Option 1 — Cloudways File Manager (no command line needed):**
1. Zip the entire `remote-device-management/` folder on your laptop,
   excluding `node_modules/` and `.git/`.
2. Cloudways panel → Applications → newks-mdm → Application Management →
   **File Manager**.
3. Navigate to `public_html`, upload the zip, right-click → Extract.

**Option 2 — SFTP (preferred for re-deploys):**
- Use Cloudways' Application SFTP credentials (Applications → newks-mdm →
  Application Credentials).
- Sync the project folder up. Recommended client: WinSCP on Windows.
- Exclude `node_modules/` and `.git/` from the sync.

Once uploaded, SSH in and build:
```bash
cd /home/master/applications/<app-name>/public_html/remote-device-management

cd frontend && npm ci && npm run build
cd ../backend && npm ci && npm run build
```

Frontend build outputs to `frontend/dist/`. Backend build outputs to
`backend/dist/`. Both are referenced by the production entry in
`backend/src/index.ts`.

### D. Environment variables (Cloudways panel)

Cloudways → Applications → newks-mdm → **Application Settings →
Environment Variables**. Add these:

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `DATABASE_URL` | (paste the Neon connection string from step A) |
| `JWT_SECRET` | (64+ random chars — `openssl rand -base64 48` on any Linux/Mac) |
| `ENROLLMENT_SECRET` | (32+ random chars — used by the Android agent at enrollment) |

First-boot bootstrap (remove these after your first successful admin
login — the bootstrap is idempotent and won't recreate the admin):

| Variable | Value |
|----------|-------|
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD` | (one-time strong password) |

Do NOT set `CORS_ORIGINS` — the backend serves the SPA same-origin in
production so CORS isn't needed.

Save. Cloudways will inject these into the application process at start.

### E. nginx — WebSocket pass-through

Cloudways → Applications → newks-mdm → **Application Settings → Custom
Settings**. Paste this nginx directive so WebSocket upgrades work and
all traffic forwards to our Node process on port 4000:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400s;     # WS is long-lived; default 60s kills it
    proxy_send_timeout 86400s;
}

location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Save → click the **Reload Nginx** button Cloudways exposes.

### F. Start the app

SSH in. Make sure your shell has nvm on PATH (`source ~/.bashrc` if
needed). From the project root:

```bash
cd /home/master/applications/<app-name>/public_html/remote-device-management
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup
# Run the command pm2 startup printed, exactly as printed.
# (Even without sudo, the user-level startup script gets registered.)
```

Verify:
```bash
pm2 status
pm2 logs newks-mdm-backend --lines 30 --nostream
```

You should see `[backend] listening on http://127.0.0.1:4000
(NODE_ENV=production)` and `[backend] serving frontend from
.../frontend/dist`.

### G. Smoke test

In a browser, hit `https://<app-name>.cloudwaysapps.com/`. Expected:
1. Redirected to `/login`
2. Log in with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` you set
3. Empty Devices page

Also verify the health endpoint:
```bash
curl -sS https://<app-name>.cloudwaysapps.com/health
# {"status":"ok","service":"remote-mdm-backend","time":"..."}
```

Then **remove `ADMIN_PASSWORD` (and optionally `ADMIN_USERNAME`) from the
Cloudways env vars panel** — plaintext credentials shouldn't linger after
bootstrap. The bootstrap is idempotent, so removing them won't break
anything; it just stops Cloudways from holding them.

## Re-deploys

After the initial setup, redeploys are:

```bash
# (1) Update code: SFTP up the new revision, OR git pull if you set up a
#     git remote. Skip node_modules/ either way.

# (2) Rebuild + reload
cd /home/master/applications/<app-name>/public_html/remote-device-management
cd frontend && npm ci && npm run build
cd ../backend && npm ci && npm run build
cd ..
pm2 reload ecosystem.config.cjs --env production
```

`pm2 reload` drains in-flight requests before swapping (vs `restart`
which is a hard kill). Tablets' WebSocket connections will see a close,
then reconnect within ~5 seconds via the agent's backoff.

## Things to do before going live

- [ ] Switch the Android agent to **HTTPS-only**: flip
      `android:usesCleartextTraffic` to false in `AndroidManifest.xml`
      (or gate it on the debug build type so dev still works over LAN).
- [ ] Replace MJPEG-over-WebSocket screen sharing with **WebRTC** for the
      production network where UDP/SRTP can route normally. The signaling
      protocol stays the same.
- [ ] Issue **per-device tokens** at enrollment, require them in
      `REGISTER_SOCKET` so any device that knows another's UUID can't
      impersonate it. (Tagged in `backend/src/ws/server.ts`.)
- [ ] Wire up a real Newk's-owned domain (Cloudways Domain Management +
      Let's Encrypt) once the cloudwaysapps.com subdomain is no longer
      desired.
- [ ] Set up Neon's branch-based dev DB so we can run migrations against
      a copy before applying to prod.
- [ ] Build a user-management UI in the portal so support staff can be
      added without poking the DB.
- [ ] Plan APK distribution: device-owner provisioning for the actual
      Newk's POS tablets so MediaProjection + Accessibility consent
      dialogs aren't needed.

## Troubleshooting

**`pm2: command not found`** — nvm's `npm install -g` may not have
been on PATH. Re-run `source ~/.bashrc` or restart the SSH session.

**`Error: connect ENETUNREACH ... neon.tech`** — outbound 5432 may be
blocked. Neon uses standard Postgres port 5432 over TLS, but on some
restrictive networks they offer port 443 as a fallback (see Neon docs).

**`server.listen ... EADDRINUSE`** — port 4000 already in use by
another app on the shared server. Check `pm2 list` for collisions; if
needed change `PORT` in Cloudways env vars + the nginx vhost to a free
port (e.g., 4001).

**WebSocket connections close immediately** — usually means the nginx
`location /ws` block isn't applied. Verify under Custom Settings, then
click Cloudways' Reload Nginx button.

**`relation "users" does not exist`** — Neon schema wasn't applied. Use
Neon SQL Editor to paste `docs/database-schema.sql` and run.

**"failed to bootstrap admin: invalid role"** — `ADMIN_USERNAME`/
`ADMIN_PASSWORD` env vars unset or empty. Set them in the Cloudways
panel, restart with `pm2 restart newks-mdm-backend`.
