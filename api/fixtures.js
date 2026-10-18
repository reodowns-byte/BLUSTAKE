
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const apiKey = process.env.APIFOOTBALL_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "APIFOOTBALL_KEY is missing from Vercel environment variables"
    });
  }

  const live = req.query.live;
  const date = req.query.date;

  const params = new URLSearchParams();

  if (live === "all") {
    params.set("live", "all");
  } else if (date) {
    params.set("date", String(date));
  } else {
    params.set("date", new Date().toISOString().slice(0, 10));
  }

  try {
    const response = await fetch(
      `https://v3.football.api-sports.io/fixtures?${params.toString()}`,
      {
        headers: {
          "x-apisports-key": apiKey
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Football provider request failed"
      });
    }

    if (data.errors && Object.keys(data.errors).length > 0) {
      return res.status(502).json({
        error: "Football provider returned an error",
        details: data.errors
      });
    }

    return res.status(200).json({
      response: Array.isArray(data.response) ? data.response : [],
      results: data.results ?? 0
    });
  } catch (error) {
    return res.status(502).json({
      error: "Unable to contact football provider"
    });
  }
}
