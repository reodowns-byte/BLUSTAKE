export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=300");
  res.setHeader("Vary", "Accept");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.APIFOOTBALL_KEY;
  if (!apiKey) return res.status(500).json({ error: "APIFOOTBALL_KEY is missing from Vercel environment variables" });

  const live = String(req.query.live || "").toLowerCase() === "all";
  const fixture = String(req.query.fixture || "").trim();
  const date = String(req.query.date || "").trim();
  const pageRaw = String(req.query.page || "1");
  const page = Number(pageRaw);
  if (!Number.isInteger(page) || page < 1 || page > 10) return res.status(400).json({ error: "page must be an integer from 1 to 10" });
  if (fixture && !/^\d+$/.test(fixture)) return res.status(400).json({ error: "fixture must be a numeric fixture ID" });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must use YYYY-MM-DD format" });
  if (live && (fixture || date)) return res.status(400).json({ error: "Use live=all on its own, or use fixture/date for pre-match odds" });

  const params = new URLSearchParams();
  let endpoint;
  if (live) {
    endpoint = "odds/live";
    if (fixture) params.set("fixture", fixture);
  } else {
    endpoint = "odds";
    if (fixture) params.set("fixture", fixture);
    if (date) params.set("date", date);
    if (!fixture && !date) params.set("date", new Date().toISOString().slice(0, 10));
    params.set("page", String(page));
  }

  try {
    const response = await fetch(`https://v3.football.api-sports.io/${endpoint}?${params.toString()}`, {
      method: "GET",
      headers: { "x-apisports-key": apiKey, "Accept": "application/json" }
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: "Football odds provider request failed", details: data.errors || data.message || null });
    if (data.errors && Object.keys(data.errors).length > 0) return res.status(502).json({ error: "Football provider returned an odds error", details: data.errors });
    return res.status(200).json({ response: Array.isArray(data.response) ? data.response : [], results: data.results ?? 0, paging: data.paging ?? null, endpoint });
  } catch (_) {
    return res.status(502).json({ error: "Unable to contact football odds provider" });
  }
}
