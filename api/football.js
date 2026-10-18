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
  if ((type === "details" || type === "odds") && !/^\d+$/.test(id)) return res.status(400).json({ error: "A numeric fixture id is required" });
  if (type !== "fixtures" && type !== "details" && type !== "odds") return res.status(400).json({ error: "type must be fixtures, details or odds" });
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
    fixture: { id: x.id, date: x.kickoff_utc || (x.kickoff_ts ? new Date(x.kickoff_ts * 1000).toISOString() : null), status: { short: ({ live: "LIVE", scheduled: "NS", finished: "FT", half_time: "HT", first_half: "1H", second_half: "2H", extra_time: "ET", penalties: "PEN" })[String(x.status || "").toLowerCase()] || String(x.status || "NS").toUpperCase(), long: String(x.status_reason || x.status || "Scheduled"), elapsed: x.elapsed ?? x.minute ?? null } },
    league: { id: x.league?.id, name: x.league?.name || "Football", country: x.league?.country || "" },
    teams: { home: { id: x.teams?.home?.id, name: x.teams?.home?.name || "Home", logo: x.teams?.home?.logo || x.teams?.home?.image || "" }, away: { id: x.teams?.away?.id, name: x.teams?.away?.name || "Away", logo: x.teams?.away?.logo || x.teams?.away?.image || "" } },
    goals: { home: x.goals?.home ?? null, away: x.goals?.away ?? null },
    _provider: "5DollarFootballAPI"
  });
  const number = value => { const n = Number(value); return Number.isFinite(n) && n > 1 ? n : null; };
  const latest = line => line && (line.inplay || line.closing || line.current || line.opening || line);
  const makeMarkets = (fixture, oddsResponse) => {
    const markets = [];
    const add = (name, values) => {
      const clean = values.map(v => ({ value: String(v.value || ""), odd: number(v.odd) })).filter(v => v.value && v.odd);
      if (clean.length) markets.push({ name, values: clean });
    };
    const roots = [];
    const responseData = oddsResponse?.data || oddsResponse || {};
    if (responseData.odds) roots.push(responseData.odds);
    if (Array.isArray(responseData.bookmakers)) for (const book of responseData.bookmakers) if (book?.odds) roots.push(book.odds);
    if (fixture?.odds) roots.push(fixture.odds);
    if (fixture?.odds_full) roots.push(fixture.odds_full);
    for (const root of roots) {
      const one = latest(root["1x2"] || root.match_result);
      if (one) add("Match Winner", [{ value: "Home", odd: one.home }, { value: "Draw", odd: one.draw }, { value: "Away", odd: one.away }]);
      const goal = latest(root.goal_line || root.goalline);
      if (goal) {
        const line = goal.line ?? "";
        add(line !== "" ? `Total Goals ${line}` : "Total Goals", [{ value: line !== "" ? `Over ${line}` : "Over", odd: goal.over }, { value: line !== "" ? `Under ${line}` : "Under", odd: goal.under }]);
      }
      const btts = latest(root.btts || root.both_teams_to_score);
      if (btts) add("Both Teams to Score", [{ value: "Yes", odd: btts.yes }, { value: "No", odd: btts.no }]);
      for (const [key, label] of [["asian_handicap", "Asian Handicap"], ["corner_line", "Corners"], ["card_line", "Cards"], ["asian_handicap_half", "Half Time Asian Handicap"], ["goal_line_half", "Half Time Goals"], ["corner_line_half", "Half Time Corners"]]) {
        const market = latest(root[key]);
        if (market) {
          const line = market.line ?? "";
          const vals = [];
          if (market.home != null) vals.push({ value: line !== "" ? `Home (${line})` : "Home", odd: market.home });
          if (market.away != null) vals.push({ value: line !== "" ? `Away (${line})` : "Away", odd: market.away });
          if (market.over != null) vals.push({ value: line !== "" ? `Over ${line}` : "Over", odd: market.over });
          if (market.under != null) vals.push({ value: line !== "" ? `Under ${line}` : "Under", odd: market.under });
          add(label, vals);
        }
      }
    }
    // Avoid duplicates when both the fixture detail and odds endpoint carry the same snapshot.
    const seen = new Set();
    return markets.filter(m => { const sig = m.name + JSON.stringify(m.values); if (seen.has(sig)) return false; seen.add(sig); return true; });
  };

  try {
    if (type === "odds") {
      const oddsData = await request(`/fixtures/${encodeURIComponent(id)}/odds`);
      const markets = makeMarkets({}, oddsData);
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
      return res.status(200).json({ markets, source: "5DollarFootballAPI" });
    }
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
      request(`/fixtures/${encodeURIComponent(id)}/odds`).catch(() => null)
    ]);
    const raw = fixtureData.data || fixtureData.fixture || fixtureData;
    const normalized = toLegacyFixture(raw);
    const markets = makeMarkets(raw, oddsData);
    return res.status(200).json({ response: { ...normalized, markets, raw: { oddsAvailable: markets.length > 0 } }, source: "5DollarFootballAPI" });
  } catch (error) {
    return res.status(error.status && error.status >= 400 && error.status < 600 ? error.status : 502).json({ error: error.message || "Unable to contact football provider" });
  }
}
