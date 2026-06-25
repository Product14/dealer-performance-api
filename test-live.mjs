// Local smoke test for api/dealer-live.js — runs the real queries against Metabase.
import handler from "./api/dealer-live.js";
const req = { method: "GET", query: {} }; // defaults to Lucki (97e494b63), 60 days
const res = {
  _s: 200,
  setHeader() {},
  status(c) { this._s = c; return this; },
  json(o) {
    console.log("HTTP", this._s);
    console.log("dealer:", o.dealer, "| asOf:", o.asOf);
    console.log("kpi:", JSON.stringify(o.kpi));
    const sum = (a, i) => (a || []).reduce((s, r) => s + (+r[i] || 0), 0);
    console.log("conversations:", sum(o.daily, 1), "leads:", sum(o.daily, 2));
    console.log("testDrives:", sum(o.dailyAppts, 1), "service:", sum(o.dailyAppts, 2), "completed:", sum(o.dailyAppts, 3));
    console.log("sources:", (o.sources || []).length, "| vehicles:", (o.vehicles || []).length, "| transcripts:", (o.conversations || []).length);
    console.log("top vehicle:", JSON.stringify((o.vehicles || [])[0]));
    console.log("top source:", JSON.stringify((o.sources || [])[0]));
    if (o.error) console.log("ERROR:", o.error);
    return this;
  },
  end() { console.log("HTTP", this._s, "(end)"); return this; },
};
await handler(req, res);
