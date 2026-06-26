/**
 * LIVE Dealer Performance endpoint — canonical backend for dealer-performance.html.
 *
 * Scoped by TEAM (one dealership = one team_id). A dealer opens their own dashboard via:
 *   https://<project>.vercel.app/api/dealer-live?team=<team_id>
 * and the dashboard page itself takes ?team_id=<id> in its URL.
 *
 * Runs validated queries against Prod-ClickHouse via Metabase /api/dataset.
 * Env: METABASE_URL, METABASE_API_KEY, METABASE_DB_ID (default 350).
 */
const SITE = (process.env.METABASE_URL || "https://metabase.spyne.ai").replace(/\/$/, "");
const KEY = process.env.METABASE_API_KEY;
const DB = Number(process.env.METABASE_DB_ID || 350);
const DEFAULT_TEAM = "b60b1bb221"; // Lucki Mazda of Woodbridge
const PALETTE = ["#2563eb", "#22c55e", "#6366f1", "#f59e0b", "#7c3aed", "#0891b2", "#ef4444", "#60a5fa", "#94a3b8", "#14b8a6"];

async function q(sql) {
  const r = await fetch(`${SITE}/api/dataset`, {
    method: "POST",
    headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ database: DB, type: "native", native: { query: sql } }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Metabase ${r.status}: ${t.slice(0, 200)}`);
  const j = JSON.parse(t);
  if (j.error) throw new Error(String(j.error).slice(0, 200));
  return { cols: (j.data.cols || []).map((c) => c.name), rows: j.data.rows || [] };
}
const day = (x) => String(x).slice(0, 10);
const num = (x) => (x == null ? 0 : +x || 0);
function assistantText(m) {
  if (m._text) return m._text;
  try { const p = JSON.parse(m.content); if (p && p.text) return p.text; } catch {}
  return typeof m.content === "string" ? m.content : "";
}
const VDP = /opened the VDP for (.+?) \(price \$?([\d,]+)\)/i;
function classify(bot) {
  const t = bot.toLowerCase();
  if (/available slots|select a time|test drive (is )?(booked|scheduled|confirmed|reserved)|set up a test drive for the/.test(t)) return ["Test Drive Booked", "committed"];
  if (/best number to reach you|have someone.*call you|connect (you )?(to|with) (our|the) (store|team|service)/.test(t)) return ["Callback Requested", "warm"];
  return ["Engaged", "neutral"];
}
function fmtPhone(p) { const d = String(p || ""); const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(d); return m ? `+1 ${m[1]}-${m[2]}-${m[3]}` : d; }
function visitorName(identityStr) {
  try { const o = JSON.parse(identityStr || "{}"); const nm = [o.firstName, o.lastName].filter(Boolean).join(" ").trim(); if (nm) return nm; if (o.phone) return fmtPhone(o.phone); if (o.email) return o.email; } catch {}
  return "Web Shopper";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!KEY) return res.status(500).json({ error: "Set METABASE_API_KEY env var." });

  const team = (req.query.team || req.query.team_id || DEFAULT_TEAM).replace(/'/g, "");
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 60));
  const since = `now() - INTERVAL ${days} DAY`;
  const leadSub = `SELECT leadId FROM chat_service.chatConversations WHERE leadId IS NOT NULL AND teamId='${team}' AND createdAt >= ${since}`;
  const out = { team, teamName: "", asOf: new Date().toISOString().slice(0, 10), kpi: {}, daily: [], dailyAppts: [], sources: [], vehicles: [], conversations: [] };

  try {
    try { const tn = await q(`SELECT team_name FROM eventila.enterprise_team_details WHERE team_id='${team}' LIMIT 1`); out.teamName = (tn.rows[0] && tn.rows[0][0]) || team; } catch { out.teamName = team; }

    const cd = await q(`SELECT toDate(createdAt) d, count() conv, countIf(leadId IS NOT NULL) leads FROM chat_service.chatConversations WHERE teamId='${team}' AND createdAt >= ${since} GROUP BY d ORDER BY d`);
    out.daily = cd.rows.map((r) => [day(r[0]), num(r[1]), num(r[2])]);

    const md = await q(`SELECT toDate(m.created_at) d, countIf(lower(m.intent) LIKE '%test%') td, countIf(m.service_type='service') svc, countIf(m.status='completed') comp FROM dealer_leads.meetings m WHERE m.lead_id IN (${leadSub}) GROUP BY d ORDER BY d`);
    out.dailyAppts = md.rows.map((r) => [day(r[0]), num(r[1]), num(r[2]), num(r[3])]);

    const hd = await q(`SELECT count() total, countIf(humanTakenOverAt IS NOT NULL) handoffs FROM dealer_leads.conversations WHERE teamId='${team}' AND type='chat' AND __deleted=0 AND createdAt >= ${since}`);
    const total = num(hd.rows[0] && hd.rows[0][0]), handoffs = num(hd.rows[0] && hd.rows[0][1]);
    out.kpi.handoffs = handoffs;
    out.kpi.aiResolution = total ? +(((total - handoffs) / total) * 100).toFixed(1) : 100;

    const ls = await q(`SELECT source, count() c FROM dealer_leads.leads WHERE team_id='${team}' AND is_deleted=0 AND created_at >= ${since} AND source != '' GROUP BY source ORDER BY c DESC LIMIT 10`);
    out.sources = ls.rows.map((r, i) => [String(r[0]).replace(/_/g, " "), num(r[1]), PALETTE[i % PALETTE.length]]);

    out.vehicles = await buildVehicles(team, since);
    out.conversations = await buildTranscripts(team, since);
    return res.status(200).json(out);
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err), partial: out });
  }
}

async function buildVehicles(team, since) {
  const bh = await q(`SELECT sessionId, vins FROM chat_service.chatBrowsingHistory WHERE teamId='${team}' AND createdAt >= ${since} AND vins != ''`);
  const vinSessions = {};
  for (const [sid, vins] of bh.rows) {
    let arr; try { arr = JSON.parse(vins); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const seen = new Set();
    for (const o of arr) if (o && o.vin) seen.add(o.vin);
    for (const v of seen) (vinSessions[v] = vinSessions[v] || new Set()).add(sid);
  }
  const counts = Object.entries(vinSessions).map(([v, s]) => [v, s.size]).sort((a, b) => b[1] - a[1]);
  const vins = counts.map((x) => x[0]);
  const info = {};
  if (vins.length) {
    const inList = vins.map((v) => `'${String(v).replace(/'/g, "")}'`).join(",");
    const dm = await q(`SELECT vin, year, make, model, trim, sellingPrice, price FROM inventory.dealerVinMapping WHERE vin IN (${inList})`);
    for (const [vin, year, make, model, trim, sp, price] of dm.rows) {
      const name = [year, make, model, trim].map((x) => (x == null ? "" : String(x))).filter(Boolean).join(" ").trim();
      let pr = +sp || 0; const MAX = 1000000;
      if (pr <= 0 || pr > MAX) pr = parseInt(String(price).replace(/[^0-9]/g, "")) || 0;
      if (pr <= 0 || pr > MAX) pr = 0;
      info[vin] = { name, price: pr };
    }
  }
  const cc = await q(`SELECT cmp.messages AS messages FROM chat_service.chatCompletions cmp INNER JOIN chat_service.chatConversations cc ON cmp.conversationId = cc.conversationId WHERE cc.teamId='${team}' AND cmp.__deleted=0 AND cmp.messages != '' AND cmp.createdAt >= ${since} ORDER BY cmp.createdAt DESC LIMIT 300`);
  const opens = {};
  for (const [messages] of cc.rows) {
    let arr; try { arr = JSON.parse(messages); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const m of arr) if (m.role === "user" && m.content) { const v = VDP.exec(String(m.content)); if (v) { const n = v[1].trim().replace(/\bMazda Mazda/i, "Mazda"); opens[n] = (opens[n] || 0) + 1; } }
  }
  return counts.map(([vin, viewers]) => {
    const it = info[vin] || { name: "", price: 0 };
    const name = it.name || vin;
    return [name, viewers, opens[name] || 0, it.price ? "$" + it.price.toLocaleString() : ""];
  }).slice(0, 10);
}

async function buildTranscripts(team, since) {
  const res = await q(`SELECT cmp.id AS id, cmp.createdAt AS createdAt, cmp.messages AS messages, cs.activeAgentType AS agent, cs.leadId AS leadId, cs.identity AS identity
    FROM chat_service.chatCompletions cmp
    INNER JOIN chat_service.chatSessions cs ON cmp.sessionId = cs.sessionId
    WHERE cs.teamId='${team}' AND cmp.__deleted=0 AND cmp.messages != '' AND cmp.createdAt >= ${since}
    ORDER BY cmp.createdAt DESC LIMIT 250`);
  const out = [];
  for (const [id, createdAt, messages, agentRaw, leadId, identity] of res.rows) {
    let arr; try { arr = JSON.parse(messages); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const msgs = []; let realUser = 0; let lastVdp = ""; const ts = [];
    for (const m of arr) {
      if (typeof m._ts === "number") ts.push(m._ts);
      if (m.role === "user") {
        const c = String(m.content || ""); const v = VDP.exec(c);
        if (c.includes("SystemEvent") || v) { if (v) { const name = v[1].trim().replace(/\bMazda Mazda/i, "Mazda"); if (name !== lastVdp) { msgs.push({ r: "user", t: `👁 Opened VDP — ${name} ($${v[2]})` }); lastVdp = name; } } continue; }
        msgs.push({ r: "user", t: c.slice(0, 500) }); realUser++; lastVdp = "";
      } else if (m.role === "assistant") { const t = assistantText(m); if (t) msgs.push({ r: "bot", t: String(t).slice(0, 500) }); lastVdp = ""; }
    }
    if (realUser < 1 || msgs.length < 2) continue;
    const bot = msgs.filter((x) => x.r === "bot").map((x) => x.t).join(" ");
    const [outcome, cls] = classify(bot);
    const startTs = ts.length ? Math.min(...ts) : null, endTs = ts.length ? Math.max(...ts) : null;
    const agent = agentRaw === "service" ? "service" : "sales";
    out.push({
      id: String(id).slice(0, 8).toUpperCase(),
      visitor: visitorName(identity),
      agent, intent: agent === "service" ? "Service" : "Sales", channel: "Web Chat",
      outcome, cls,
      hasLead: !!(leadId && String(leadId).trim()),
      date: String(createdAt).slice(0, 16).replace("T", " "),
      startTs, endTs,
      durationMin: (startTs != null && endTs != null) ? Math.max(0, Math.round((endTs - startTs) / 60000)) : null,
      msgs,
    });
    if (out.length >= 200) break;
  }
  return out;
}
