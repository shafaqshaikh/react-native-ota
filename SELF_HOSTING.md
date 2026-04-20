# Self-hosting guide

This guide walks you end-to-end through running your own production OTA server. Pick whichever deployment target matches your setup.

## 1. Choose your storage

The server uses **any S3-compatible bucket** for bundle storage. Bandwidth is the dominant cost at scale, so pick a provider with cheap (or free) egress.

| Provider | Egress price | Best for |
|---|---|---|
| **Cloudflare R2** | **Free** | Production at any scale — recommended |
| AWS S3 | $0.09/GB | If you're already on AWS |
| Backblaze B2 | $0.01/GB (free via Bandwidth Alliance for Cloudflare) | Smaller hobby use |
| MinIO self-hosted | Whatever your VPS charges | Fully on-prem, no external deps |

The recommended combo is **Cloudflare R2 + MongoDB Atlas**.

### Cloudflare R2 setup

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) and create a bucket, e.g. `ota-bundles`.
2. In `R2 → Manage R2 API tokens → Create API token`, scope `Object Read & Write` to just that bucket. Save the Access Key ID, Secret, and endpoint URL — they look like:
   ```
   S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   ```
3. Enable public access for the bucket (for MVP). In `Bucket settings → Public Access`, either:
   - **Option A**: enable `Public r2.dev bucket URL` (gives you `https://pub-<hash>.r2.dev`) — fastest path, works immediately.
   - **Option B** (recommended): add a custom domain like `bundles.yourdomain.com`. Requires pointing a CNAME at `<bucket>.<account>.r2.cloudflarestorage.com`. Gives you Cloudflare CDN caching for free.

Set `S3_PUBLIC_BASE_URL` in your `.env` to whichever you chose.

### MongoDB Atlas setup

1. Create a free account at [cloud.mongodb.com](https://cloud.mongodb.com) and a **M0 cluster** (free, 512 MB) for MVP. Upgrade to M10 ($57/mo) when you need dedicated RAM (~50k+ MAU).
2. Database access → Add user, password auth.
3. Network access → Add IP allowlist entry for your server's egress IP (or `0.0.0.0/0` temporarily during setup).
4. Click "Connect" → "Drivers" → copy the SRV connection string, insert your password, put it in `MONGO_URL`.

Or just run Mongo yourself in the docker-compose stack described below.

## 2. Deploy the server

### Option A — Docker (recommended for both self-hosters and production)

```bash
git clone https://github.com/your-org/react-native-ota-updates
cd react-native-ota-updates/server
cp .env.example .env
$EDITOR .env   # fill in S3_* and admin password
docker compose up -d --build
```

If you set real R2 credentials in `.env`, you can remove the `minio` and `minio-init` services from `docker-compose.yml`. If you set a real Mongo Atlas URL, remove the `mongo` service too. The server container is the only one you need in production.

Behind a reverse proxy (Caddy, Nginx, Traefik) for TLS:

```caddy
ota.yourdomain.com {
  reverse_proxy ota-server:4000
}
```

### Option B — Fly.io

```bash
cd server
fly launch --dockerfile Dockerfile --now --name your-ota-server
fly secrets set \
  MONGO_URL="mongodb+srv://..." \
  S3_ENDPOINT="https://<acct>.r2.cloudflarestorage.com" \
  S3_REGION=auto \
  S3_BUCKET=ota-bundles \
  S3_ACCESS_KEY_ID=... \
  S3_SECRET_ACCESS_KEY=... \
  S3_PUBLIC_BASE_URL="https://bundles.yourdomain.com" \
  ADMIN_USER=admin \
  ADMIN_PASSWORD="<strong-password>"
fly deploy
```

### Option C — any VPS (Hetzner, DigitalOcean, EC2)

```bash
# On the server
sudo apt-get install -y docker.io docker-compose-plugin
git clone https://github.com/your-org/react-native-ota-updates
cd react-native-ota-updates/server
cp .env.example .env
$EDITOR .env
docker compose up -d --build
```

Put Caddy or Nginx in front for HTTPS (free with Let's Encrypt).

## 3. Create a project + API key

Once the server is up:

1. Open `https://ota.yourdomain.com/admin` and log in with the admin Basic Auth creds from your `.env`.
2. Click "Projects → Create project" and choose a slug (e.g. `liquide`) and display name.
3. The next screen shows you a freshly minted API key like `ota_live_xxxxxxxxxxxxxxxxxxxx`. **Save it now** — it is never shown again.

## 4. Publish your first OTA

From your React Native app directory:

```bash
export OTA_UPDATES_TOKEN=ota_live_xxxxxxxxxxxxxxxxxxxx
export OTA_UPDATES_SERVER=https://ota.yourdomain.com

npx react-native-ota-updates publish \
  -p android \
  --app-version 1.4.9 \
  --runtime-version 1.4.9
```

This will:
1. Build a Hermes bundle via `expo export:embed` (or `react-native bundle` if you're not on Expo).
2. Zip the assets folder (Android only — iOS uses a main-bundle symlink trick).
3. POST everything to `/v1/publish` with your bearer token.
4. Stream uploads to R2/S3.

You should see `✓ Published!` with an update ID.

## 5. Staged rollouts

Instead of `--rollout 100`, pass a schedule:

```bash
npx react-native-ota-updates publish -p android --app-version 1.4.9 \
  --rollout-schedule '[
    {"atMinutes":0,"pct":5},
    {"atMinutes":30,"pct":25},
    {"atMinutes":120,"pct":50},
    {"atMinutes":360,"pct":100}
  ]'
```

Devices calling `/check` see the pct for the current time step. You can monitor ramping from `/admin` — each update shows its effective pct with a "staged" badge.

## 6. Rollback

- **Via dashboard**: `/admin → Dashboard → Rollback` next to any update. Marks it as `rolledback` so `/check` stops serving it; devices fall through to the previous active update (or the embedded bundle if none).
- **Via crash loop**: the native module automatically reverts if the OTA bundle causes 2 launch crashes in a row. No manual action needed.
- **Via hard delete**: `/admin → Dashboard → Delete` removes the bundle from S3/R2 and marks the record deleted. Use when you want to reclaim storage.

## 7. Monitoring

- `GET /health` — JSON probe including Mongo connection state. Wire into your uptime monitor.
- `GET /admin/audit` — human-readable event log of publishes, rollbacks, deletes.
- R2/S3 metrics in your cloud provider dashboard show bandwidth usage per update.

## Environment variable reference

See `server/.env.example` for the authoritative list. Required:

| Var | Meaning |
|---|---|
| `MONGO_URL` | MongoDB connection string |
| `S3_ENDPOINT` | S3-compatible API endpoint (empty for AWS S3) |
| `S3_REGION` | Bucket region (`auto` for R2) |
| `S3_BUCKET` | Bucket name |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Bucket credentials |
| `S3_PUBLIC_BASE_URL` | URL prefix devices use to download bundles |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Basic Auth for `/admin` |

Optional:

| Var | Default |
|---|---|
| `PORT` | `4000` |
| `S3_FORCE_PATH_STYLE` | `false` (set `true` for MinIO) |
| `MAX_BUNDLE_SIZE_MB` | `200` |
