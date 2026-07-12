# Training Command Center

Fully automated personal training dashboard at **fitness.bradleyblock.com** — COROS training
status + Oura recovery, no manual refresh, no buttons.

```
COROS ──┐
        ├──► GitHub Actions (every 3h) ──► site/data.json ──► GitHub Pages
Oura ───┘        sync/sync.mjs
```

## How it works

- **`sync/coros.mjs`** — client for the unofficial COROS Training Hub API (the same endpoints
  the web app uses; login with MD5-hashed password, then `accessToken` header).
  Key endpoint: `/analyse/dayDetail/query` returns daily `ati`/`cti` — COROS's internal names
  for **Load Impact** (7-day) and **Base Fitness** (42-day weighted rolling average of daily
  training load). **Intensity Trend** is their ratio; zones per COROS docs
  (>150% Excessive · 100–149% Optimized · 80–99% Maintaining · 50–79% Resuming/Performance · <50% Decreasing).
- **`sync/oura.mjs`** — official Oura API v2 (readiness, sleep score, overnight HRV) with a
  personal access token.
- **`sync/metrics.mjs`** — emulates the Training Status math from raw daily load, for
  gap-filling and validated against COROS's own series on every live sync.
- **`sync/sync.mjs`** — orchestrator. Merges each pull into `site/data.json` by date, so
  history accumulates beyond the API windows (~24 weeks) forever.
- **`site/index.html`** — static dashboard, reads `data.json`. No secrets in the browser.

## Modes

```sh
node sync/sync.mjs               # live (needs env vars, see .env.example)
node sync/sync.mjs --fixtures    # rebuild data.json from sync/fixtures (dev)
node sync/sync.mjs --probe      # dump raw COROS responses to sync/probe-output/
```

Local preview: `python3 -m http.server 8477 --directory site`

## One-time setup

1. **Repo secrets** (Settings → Secrets and variables → Actions): `COROS_EMAIL`,
   `COROS_PASSWORD`, `OURA_TOKEN` (from <https://cloud.ouraring.com/personal-access-tokens>).
   Optional repo *variable* `COROS_REGION` (`us` default).
2. **DNS**: CNAME record `fitness` → `bradleyblockedyou.github.io`.
3. Pages custom domain is configured to `fitness.bradleyblock.com` with HTTPS enforced.

Until secrets are added, the workflow deploys the last committed `data.json` and logs a warning.

## Roadmap

- **V2**: individual activity browser — every run stored and viewable (splits, HR, map).
