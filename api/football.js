export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  res.setHeader("Vary", "Accept");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.FIVE_DOLLAR_FOOTBALL_API_KEY;
  if (!key) return res.status(500).json({ error: "FIVE_DOLLAR_FOOTBALL_API_KEY is missing from Vercel environment variables" });
  const type = String(req.query.type || "fixtures").toLowerCase();
  const id = String(req.query.id || "").trim();
  const date = String(req.query.date || "").trim();
  const status = String(req.query.status || "").toLowerCase();
  const page = Math.max(1, Math.min(20, Number(req.query.page) || 1));
  if (type === "details" && !/^\d+$/.test(id)) return res.status(400).json({ error: "A numeric fixture id is required" });
  if (type !== "fixtures" && type !== "details") return res.status(400).json({ error: "type must be fixtures or details" });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must use YYYY-MM-DD format" });

  const base = "https://api.5dollarfootballapi.com/v1";
  const request = async path => {
    const response = await fetch(base + path, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === 0) {
      const error = data?.error?.message || data?.error || data?.message || `Football provider returned HTTP ${response.status}`;
      const e = new Error(String(error)); e.status = response.status; throw e;
    }
    return data;
  };
  const toLegacyFixture = x => ({
    fixture: { id: x.id, date: x.kickoff_utc || (x.kickoff_ts ? new Date(x.kickoff_ts * 1000).toISOString() : null), status: { short: ({ live: "LIVE", scheduled: "NS", finished: "FT", half_time: "HT" })[String(x.status || "").toLowerCase()] || String(x.status || "NS").toUpperCase(), long: String(x.status_reason || x.status || "Scheduled"), elapsed: x.elapsed ?? x.minute ?? null } },
    league: { id: x.league?.id, name: x.league?.name || "Football", country: x.league?.country || "" },
    teams: { home: { id: x.teams?.home?.id, name: x.teams?.home?.name || "Home", logo: x.teams?.home?.logo || x.teams?.home?.image || "" }, away: { id: x.teams?.away?.id, name: x.teams?.away?.name || "Away", logo: x.teams?.away?.logo || x.teams?.away?.image || "" } },
    goals: { home: x.goals?.home ?? null, away: x.goals?.away ?? null },
    _provider: "5DollarFootballAPI"
  });
  try {
    if (type === "fixtures") {
      let path = "/fixtures?per_page=100&page=" + page;
      if (status === "live") path = "/fixtures?status=live&per_page=500&page=1";
      else if (date) {
        const start = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000);
        const end = start + 86400;
        path = `/fixtures?start_time=${start}&end_time=${end}&per_page=100&page=${page}`;
      }
      const data = await request(path);
      const rows = Array.isArray(data.data) ? data.data : [];
      return res.status(200).json({ response: rows.map(toLegacyFixture), results: rows.length, pagination: data.pagination || null, source: "5DollarFootballAPI" });
    }
    const [fixtureData, oddsData] = await Promise.all([
      request(`/fixtures/${encodeURIComponent(id)}`),
      request(`/fixtures/${encodeURIComponent(id)}/odds?market=1x2`).catch(() => null)
    ]);
    const raw = fixtureData.data || fixtureData.fixture || fixtureData;
    const normalized = toLegacyFixture(raw);
    const marketRows = [];
    const addMarket = (name, vals) => {
      if (!Array.isArray(vals)) return;
      const values = vals.map(v => ({ value: String(v.value ?? v.name ?? v.selection ?? ""), odd: Number(v.odd ?? v.odds ?? v.price) })).filter(v => v.value && Number.isFinite(v.odd) && v.odd > 1);
      if (values.length) marketRows.push({ name, values });
    };
    const inspect = obj => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) { obj.forEach(inspect); return; }
      for (const [k, v] of Object.entries(obj)) {
        const keyName = k.toLowerCase();
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const names = Object.keys(v).map(z => z.toLowerCase());
          if (names.includes("home") && names.includes("draw") && names.includes("away")) {
            const values = ["home", "draw", "away"].map(n => ({ value: n[0].toUpperCase() + n.slice(1), odd: Number(v[n]?.price ?? v[n]?.odd ?? v[n]) })).filter(x => Number.isFinite(x.odd) && x.odd > 1);
            if (values.length) addMarket("Match Winner", values);
          }
          if (Array.isArray(v)) addMarket(k.replace(/_/g, " "), v);
          inspect(v);
        }
      }
    };
    inspect(raw.odds || raw.markets || raw);
    if (oddsData) inspect(oddsData.data || oddsData.odds || oddsData);
    const seen = new Set();
    const markets = marketRows.filter(m => { const sig = m.name + JSON.stringify(m.values); if (seen.has(sig)) return false; seen.add(sig); return true; });
    return res.status(200).json({ response: { ...normalized, markets, raw: { oddsAvailable: markets.length > 0 } }, source: "5DollarFootballAPI" });
  } catch (error) {
    return res.status(error.status && error.status >= 400 && error.status < 600 ? error.status : 502).json({ error: error.message || "Unable to contact football provider" });
  }
}
