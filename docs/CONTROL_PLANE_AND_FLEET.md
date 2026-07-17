# Control Plane + Fleet Hub

This server hosts more than file transfer and electron-updater feeds.

## Capabilities (2026-07-17)

| Area | Routes / modules | Notes |
|------|------------------|--------|
| Updates | `/updates/*` | full `latest.yml` + hot `latest-hot.json` |
| Download portal | `/download/*` | password gate; full installers only |
| Fleet hub | `/api/fleet/*` | probe loop + external `report` |
| Control plane | `/api/v1/auth/*`, `/api/v1/config/*` | multi-device config + secrets |

## Environment

`/etc/pc-utility-tool-electron-server.env` (deploy host):

| Variable | Purpose |
|----------|---------|
| `DOWNLOAD_SITE_PASSWORD` | Human download portal |
| `DATABASE_URL` | PostgreSQL `utility_tool_control` for auth + config docs |
| `UPDATES_DIR` | On-disk update artifacts (often `/var/lib/.../updates`) |

Do **not** commit production secrets.

## SQL bootstrap

```bash
psql "$DATABASE_URL" -f sql/001_control_plane.sql
```

## Source map

- `src/routes/fleet.ts` + `src/services/fleetMonitorService.ts` + `fleetReportNormalize.ts`
- `src/routes/controlPlane.ts` + `controlPlaneAuth.ts` + `configDocumentService.ts`
- `src/routes/downloadPortal.ts` + `public/download*.html`
- `src/db/pool.ts`

Doc types include: `app_prefs`, `service_endpoints`, `integrations`, `automation`, `fleet_catalog`, **`secrets`**.

## Health

```bash
curl -fsS http://127.0.0.1:3000/health
# controlPlane.database.ok should be true when DATABASE_URL is set
curl -fsS http://127.0.0.1:3000/api/v1/control/health
curl -fsS http://127.0.0.1:3000/api/fleet/status
```

## Client docs (parent repo)

- `docs/deployment/cloud-config-sync.md`
- `docs/deployment/fleet-hub.md`
- `docs/deployment/download-update-server.md`
