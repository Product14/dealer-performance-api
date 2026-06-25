# Dealer Performance — live data backend

Makes `dealer-performance.html` pull **live** instead of showing the baked snapshot.
The canonical endpoint is **`api/dealer-live.js`**. It runs the validated queries against
Prod-ClickHouse **via Metabase's `/api/dataset`**, so the only secret needed is your
Metabase API key (kept server-side — never in the browser).

```
Browser (dealer-performance.html)
   │  GET /api/dealer-live?enterprise=97e494b63
   ▼
api/dealer-live.js  ──X-API-Key──►  Metabase /api/dataset ──►  ClickHouse (dealer_leads, chat_service, inventory)
   │  reshapes to the dashboard JSON
   ▼
{ kpi, daily, dailyAppts, sources, vehicles, conversations }
```

It returns exactly what the dashboard's `applyLive()` consumes, and reproduces the verified
numbers (Lucki Mazda: 66 conv · 7 leads · 4 test drives · 4 service).

## What it computes (the agreed, consistent logic)
- **Conversations / Leads** — `chat_service.chatConversations` (lead = `leadId IS NOT NULL`)
- **Test Drives / Service / Completed** — `dealer_leads.meetings` where `lead_id` ∈ the chat-captured leads (so the funnel is consistent)
- **Human Handoffs / AI Resolution** — `dealer_leads.conversations` (`humanTakenOverAt`)
- **Lead Source** — `dealer_leads.leads.source`
- **Most Viewed Vehicles** — `chat_service.chatBrowsingHistory` ⋈ `inventory.dealerVinMapping` (names) + chat `vdp_opened` opens
- **Transcripts** — `chat_service.chatCompletions` ⋈ `chatConversations`

Scoped by `?enterprise=<id>` (default `97e494b63` = Lucki Mazda), window `?days=<n>` (default 60).

## Deploy (Vercel, ~5 min)
```bash
cd metabase-dealer-api
npm install
npx vercel            # first deploy
npx vercel --prod     # production
```
Set env vars (Vercel → Project → Settings → Environment Variables, then redeploy):

| Variable | Value |
|---|---|
| `METABASE_URL` | `https://metabase.spyne.ai` |
| `METABASE_API_KEY` | your admin API key (**secret**) |
| `METABASE_DB_ID` | `350` (Prod-ClickHouse) |

## Point the dashboard at it
In `dealer-performance.html`, near the top of `<script>`:
```js
const DATA_URL = "https://<your-project>.vercel.app/api/dealer-live";
const ENTERPRISE_ID = "97e494b63"; // Lucki Mazda
```
Reload — it shows the baked snapshot instantly, then overlays live data (status pill → "Live"),
and the **Refresh** button re-pulls live. To serve a different dealer, change `ENTERPRISE_ID`.

## Verify
- `GET /api/dealer-live` → JSON with `daily`, `dailyAppts`, `sources`, `vehicles`, `conversations`, `kpi`.
- Local smoke test (uses your env key): `node test-live.mjs`

## Notes
- `api/dealer.js` (Metabase signed-embedding) and `api/dealer-clickhouse.js` (raw ClickHouse client)
  are earlier scaffolds and are **superseded** by `dealer-live.js` — use this one.
- API keys can read all dashboards/data; keep the key in Vercel env only, and rotate the one that
  was shared in chat earlier.
