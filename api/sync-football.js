/**
 * BLUSTAKE scheduled external fixture/odds sync.
 * Required Vercel environment variables:
 *   FIVE_DOLLAR_FOOTBALL_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   CRON_SECRET
 *
 * Invoke from Vercel Cron with Authorization: Bearer <CRON_SECRET>.
 * This endpoint only writes rows marked as external-provider rows; it does not
 * modify admin-created matches or existing bet/bet-selection snapshots.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const cronSecret = process.env.CRON_SECRET;
  const auth = String(req.headers.authorization || '');
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized scheduled sync' });
  }

  const providerKey = process.env.FIVE_DOLLAR_FOOTBALL_API_KEY;
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!providerKey || !supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Missing server environment variables' });
  }

  const provider = '5DollarFootballAPI';
  const providerBase = 'https://api.5dollarfootballapi.com/v1';
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };

  async function providerGet(path) {
    const response = await fetch(`${providerBase}${path}`, {
      headers: { Authorization: `Bearer ${providerKey}`, Accept: 'application/json' }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === 0) {
      const message = data?.error?.message || data?.error || data?.message || `Provider HTTP ${response.status}`;
      throw new Error(String(message));
    }
    return data;
  }

  async function supabaseUpsert(table, rows, onConflict) {
    if (!rows.length) return;
    const url = `${supabaseUrl}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Supabase ${table} upsert failed (${response.status}): ${detail.slice(0, 500)}`);
    }
  }

  async function supabaseRequest(path, options = {}) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Supabase request failed (${response.status}): ${detail.slice(0, 400)}`);
    }
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }

  async function closeExternalMarkets(matchId, exceptKeys = null) {
    const existing = await supabaseRequest(
      `bluestake_markets?select=id,external_market_key,external_selection_key&match_id=eq.${encodeURIComponent(matchId)}&external_market_key=not.is.null&external_selection_key=not.is.null`
    );
    if (!Array.isArray(existing) || !existing.length) return 0;
    const keep = exceptKeys ? new Set(exceptKeys) : new Set();
    const staleIds = existing
      .filter(row => !exceptKeys || !keep.has(`${row.external_market_key}|${row.external_selection_key}`))
      .map(row => row.id)
      .filter(id => /^[0-9a-f-]{36}$/i.test(String(id)));
    let changed = 0;
    for (const id of staleIds) {
      await supabaseRequest(`bluestake_markets?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ is_open: false, updated_at: new Date().toISOString() })
      });
      changed += 1;
    }
    return changed;
  }

  const validDate = value => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const statusMap = value => {
    const s = String(value || '').toLowerCase();
    if (['live', 'first_half', 'second_half', 'half_time', 'extra_time', 'penalties', 'inplay'].includes(s)) return 'live';
    if (['finished', 'ft', 'full_time', 'ended', 'complete'].includes(s)) return 'finished';
    if (['postponed'].includes(s)) return 'postponed';
    if (['cancelled', 'canceled', 'abandoned'].includes(s)) return 'cancelled';
    return 'upcoming';
  };
  const decimalOdd = value => {
    const n = Number(value);
    return Number.isFinite(n) && n > 1 && n <= 1000 ? n : null;
  };
  const latest = line => line && (line.inplay || line.closing || line.current || line.opening || line);

  function extractMarkets(oddsResponse) {
    const output = [];
    const roots = [];
    const rootData = oddsResponse?.data || oddsResponse || {};
    if (rootData.odds) roots.push(rootData.odds);
    if (Array.isArray(rootData.bookmakers)) {
      for (const book of rootData.bookmakers) if (book?.odds) roots.push(book.odds);
    }
    if (!roots.length && rootData && typeof rootData === 'object') roots.push(rootData);

    const add = (marketName, selections, marketKey) => {
      for (const selection of selections) {
        const odds = decimalOdd(selection.odds);
        if (!selection.name || !odds) continue;
        output.push({ market_name: marketName, selection_name: selection.name, odds, external_market_key: marketKey, external_selection_key: selection.key });
      }
    };

    for (const root of roots) {
      const winner = latest(root['1x2'] || root.match_result);
      if (winner) add('Match Winner', [
        { name: 'Home', key: 'home', odds: winner.home },
        { name: 'Draw', key: 'draw', odds: winner.draw },
        { name: 'Away', key: 'away', odds: winner.away }
      ], 'match_winner');

      const btts = latest(root.btts || root.both_teams_to_score);
      if (btts) add('Both Teams to Score', [
        { name: 'Yes', key: 'yes', odds: btts.yes },
        { name: 'No', key: 'no', odds: btts.no }
      ], 'btts');

      const goal = latest(root.goal_line || root.goalline);
      if (goal && goal.line !== undefined && goal.line !== null && String(goal.line) !== '') {
        const line = String(goal.line);
        add(`Total Goals ${line}`, [
          { name: `Over ${line}`, key: `over_${line}`, odds: goal.over },
          { name: `Under ${line}`, key: `under_${line}`, odds: goal.under }
        ], `total_goals_${line}`);
      }

      const fixed = root.goal_line_fixed;
      const fixedRows = Array.isArray(fixed) ? fixed : (fixed && typeof fixed === 'object'
        ? Object.entries(fixed).map(([line, row]) => ({ line: row?.line ?? line, ...(row || {}) })) : []);
      for (const row of fixedRows) {
        const quote = latest(row);
        const line = quote?.line ?? row?.line;
        if (line === undefined || line === null || String(line) === '') continue;
        const lineText = String(line);
        add(`Total Goals ${lineText}`, [
          { name: `Over ${lineText}`, key: `over_${lineText}`, odds: quote?.over },
          { name: `Under ${lineText}`, key: `under_${lineText}`, odds: quote?.under }
        ], `total_goals_${lineText}`);
      }

      const doubleChance = latest(root.double_chance || root.doublechance);
      if (doubleChance) add('Double Chance', [
        { name: 'Home or Draw', key: 'home_draw', odds: doubleChance.home_draw ?? doubleChance['1x'] },
        { name: 'Home or Away', key: 'home_away', odds: doubleChance.home_away ?? doubleChance['12'] },
        { name: 'Draw or Away', key: 'draw_away', odds: doubleChance.draw_away ?? doubleChance['x2'] }
      ], 'double_chance');
    }

    const unique = new Map();
    for (const item of output) unique.set(`${item.external_market_key}|${item.external_selection_key}`, item);
    return [...unique.values()];
  }

  try {
    // Limit each run to a small page to respect the provider's API quota.
    const fixtureResponse = await providerGet('/fixtures?per_page=100&page=1');
    const fixtures = Array.isArray(fixtureResponse.data) ? fixtureResponse.data : [];
    const fixtureRows = [];
    const usableFixtures = [];

    for (const fixture of fixtures) {
      const externalId = fixture?.id;
      const home = fixture?.teams?.home?.name;
      const away = fixture?.teams?.away?.name;
      if (externalId === undefined || externalId === null || !home || !away) continue;
      const kickoff = validDate(fixture.kickoff_utc || (fixture.kickoff_ts ? Number(fixture.kickoff_ts) * 1000 : null));
      if (!kickoff) continue;
      const status = statusMap(fixture.status);
      const goalsHome = Number.isInteger(fixture?.goals?.home) ? fixture.goals.home : null;
      const goalsAway = Number.isInteger(fixture?.goals?.away) ? fixture.goals.away : null;
      fixtureRows.push({
        home_team: String(home),
        away_team: String(away),
        competition: String(fixture?.league?.name || 'Football'),
        kickoff_at: kickoff,
        match_status: status,
        source_type: 'authorized_feed',
        is_published: true,
        is_simulated: false,
        external_provider: provider,
        external_fixture_id: String(externalId),
        external_last_synced_at: new Date().toISOString(),
        ...(goalsHome !== null ? { score_home: goalsHome } : {}),
        ...(goalsAway !== null ? { score_away: goalsAway } : {})
      });
      usableFixtures.push({ id: String(externalId), status });
    }

    // Unique index is provider+fixture ID; never touch admin-created rows.
    await supabaseUpsert('bluestake_matches', fixtureRows, 'external_provider,external_fixture_id');

    // Fetch odds only for a small number of upcoming/live fixtures per run.
    // Keep this low to respect provider rate limits. Existing bets are not updated.
    const oddsCandidates = usableFixtures.filter(f => f.status === 'upcoming' || f.status === 'live').slice(0, 5);
    let marketCount = 0;
    let staleSelectionsClosed = 0;
    let finishedMarketsClosed = 0;
    let oddsErrors = 0;

    // Finished/cancelled external matches must not keep their provider markets open.
    for (const fixture of usableFixtures.filter(f => ['finished', 'cancelled', 'postponed'].includes(f.status))) {
      try {
        const matchRows = await supabaseRequest(
          `bluestake_matches?select=id&external_provider=eq.${encodeURIComponent(provider)}&external_fixture_id=eq.${encodeURIComponent(fixture.id)}&limit=1`
        );
        if (Array.isArray(matchRows) && matchRows[0]?.id) {
          finishedMarketsClosed += await closeExternalMarkets(matchRows[0].id);
        }
      } catch (_) {
        oddsErrors += 1;
      }
    }

    for (const fixture of oddsCandidates) {
      try {
        // Only close stale selections after a successful provider response with at least
        // one recognized market. Empty/unrecognized responses are not proof that odds vanished.
        const oddsResponse = await providerGet(`/fixtures/${encodeURIComponent(fixture.id)}/odds`);
        const markets = extractMarkets(oddsResponse);
        if (!markets.length) continue;

        const matchRows = await supabaseRequest(
          `bluestake_matches?select=id&external_provider=eq.${encodeURIComponent(provider)}&external_fixture_id=eq.${encodeURIComponent(fixture.id)}&limit=1`
        );
        if (!Array.isArray(matchRows) || !matchRows[0]?.id) continue;
        const matchId = matchRows[0].id;
        const rows = markets.map(m => ({
          match_id: matchId,
          market_name: m.market_name,
          selection_name: m.selection_name,
          odds: m.odds,
          is_open: true,
          external_market_key: m.external_market_key,
          external_selection_key: m.external_selection_key,
          external_odds_updated_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }));
        await supabaseUpsert('bluestake_markets', rows, 'match_id,external_market_key,external_selection_key');
        const currentKeys = rows.map(row => `${row.external_market_key}|${row.external_selection_key}`);
        staleSelectionsClosed += await closeExternalMarkets(matchId, currentKeys);
        marketCount += rows.length;
      } catch (_) {
        oddsErrors += 1;
      }
    }

    return res.status(200).json({
      success: true,
      provider,
      fixturesReceived: fixtures.length,
      fixturesUpserted: fixtureRows.length,
      oddsFixturesAttempted: oddsCandidates.length,
      marketSelectionsUpserted: marketCount,
      staleSelectionsClosed,
      finishedMarketsClosed,
      oddsFixtureErrors: oddsErrors,
      note: 'Only external-provider match rows and external market selections are synchronized. Existing bet records and odds snapshots are not modified.'
    });
    } catch (error) {
    console.error('[BLUSTAKE football sync failed]', {
      message: String(error?.message || error),
      stack: error?.stack || null
    });

    return res.status(502).json({
      error: 'Football synchronization failed',
      details: String(error?.message || error).slice(0, 700)
    });
  }
