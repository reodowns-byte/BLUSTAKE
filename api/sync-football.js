/**
 * BLUSTAKE football fixture + odds sync for Vercel Pages Functions.
 * Required Vercel Production environment variables:
 * FIVE_DOLLAR_FOOTBALL_API_KEY, SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
 *
 * Secure invocation: GET /api/sync-football with
 * Authorization: Bearer <CRON_SECRET>
 *
 * Only external-provider rows are upserted. Admin-created matches, existing
 * bets, bet selections, wallets, and ledger entries are not modified.
 * Provider "unknown" statuses are skipped; only explicit "finished" statuses
 * with valid scores are marked finished.
 * Docs: https://5dollarfootballapi.com/docs
 */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = String(process.env.CRON_SECRET || '');
  const authorization = String(req.headers.authorization || '');
  if (!cronSecret || authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized scheduled sync' });
  }

  const providerKey = String(process.env.FIVE_DOLLAR_FOOTBALL_API_KEY || '');
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');

  const missing = [];
  if (!providerKey) missing.push('FIVE_DOLLAR_FOOTBALL_API_KEY');
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    console.error('[BLUSTAKE sync] Missing environment variables:', missing.join(', '));
    return res.status(500).json({ error: 'Missing server environment variables', missing });
  }

  const providerName = '5DollarFootballAPI';
  const providerBase = 'https://api.5dollarfootballapi.com/v1';
  const supabaseHeaders = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };

  async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function providerGet(path) {
    let response;
    try {
      response = await fetchWithTimeout(`${providerBase}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${providerKey}`,
          Accept: 'application/json'
        }
      });
    } catch (error) {
      const reason = error?.name === 'AbortError'
        ? 'Football API request timed out'
        : `Could not reach Football API: ${String(error?.message || error)}`;
      throw new Error(`${reason} (${path})`);
    }

    const raw = await response.text().catch(() => '');
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { raw };
    }

    if (!response.ok || payload?.success === 0) {
      const providerMessage =
        payload?.error?.message ||
        payload?.error?.detail ||
        payload?.error ||
        payload?.message ||
        (typeof payload?.raw === 'string' ? payload.raw.slice(0, 300) : '') ||
        `HTTP ${response.status}`;
      throw new Error(
        `Football API ${response.status} on ${path}: ${String(providerMessage).slice(0, 450)}`
      );
    }
    if (payload?.success !== undefined && payload.success !== 1) {
      throw new Error(`Unexpected Football API response on ${path}`);
    }
    return payload;
  }

  async function supabaseRequest(path, options = {}) {
    let response;
    try {
      response = await fetchWithTimeout(`${supabaseUrl}/rest/v1/${path}`, {
        ...options,
        headers: { ...supabaseHeaders, ...(options.headers || {}) }
      });
    } catch (error) {
      const reason = error?.name === 'AbortError'
        ? 'Supabase request timed out'
        : `Could not reach Supabase: ${String(error?.message || error)}`;
      throw new Error(`${reason} (${path.split('?')[0]})`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Supabase HTTP ${response.status} on ${path.split('?')[0]}: ${detail.slice(0, 450)}`
      );
    }
    if (response.status === 204) return null;
    const text = await response.text().catch(() => '');
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function supabaseUpsert(table, rows, onConflict) {
    if (!rows.length) return;
    await supabaseRequest(
      `${table}?on_conflict=${encodeURIComponent(onConflict)}`,
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows)
      }
    );
  }

  async function closeExternalMarkets(matchId, keepKeys = null) {
    const existing = await supabaseRequest(
      `bluestake_markets?select=id,external_market_key,external_selection_key&match_id=eq.${encodeURIComponent(matchId)}&external_market_key=not.is.null&external_selection_key=not.is.null`
    );
    if (!Array.isArray(existing) || !existing.length) return 0;

    const keep = keepKeys ? new Set(keepKeys) : null;
    const staleIds = existing
      .filter(row => !keep || !keep.has(`${row.external_market_key}|${row.external_selection_key}`))
      .map(row => String(row.id || ''))
      .filter(id => /^[0-9a-f-]{36}$/i.test(id));

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

  function validDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function mapStatus(value) {
    const status = String(value || '').toLowerCase().trim();
    if (['live', 'in_play', 'in-play', 'inplay', 'first_half', 'second_half',
      'half_time', 'extra_time', 'penalties'].includes(status)) return 'live';
    if (['finished', 'ft', 'full_time', 'ended', 'complete'].includes(status)) return 'finished';
    if (status === 'postponed') return 'postponed';
    if (['cancelled', 'canceled', 'abandoned'].includes(status)) return 'cancelled';
    if (status === 'unknown') return 'unknown';
    if (['scheduled', 'upcoming', 'not_started', 'not-started'].includes(status)) return 'upcoming';
    return 'unknown';
  }

  function decimalOdd(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 1 && number <= 1000 ? number : null;
  }

  function latest(line) {
    if (!line || typeof line !== 'object') return null;
    return line.inplay || line.closing || line.current || line.opening || line;
  }

  function extractMarkets(oddsResponse) {
    const output = [];
    const data = oddsResponse?.data || oddsResponse || {};
    const roots = [];

    if (data?.odds && typeof data.odds === 'object') roots.push(data.odds);
    if (Array.isArray(data?.bookmakers)) {
      for (const bookmaker of data.bookmakers) {
        if (bookmaker?.slug && bookmaker.slug !== 'bet365') continue;
        if (bookmaker?.odds && typeof bookmaker.odds === 'object') roots.push(bookmaker.odds);
      }
    }
    if (!roots.length && data && typeof data === 'object') roots.push(data);

    const add = (marketName, selections, marketKey) => {
      for (const selection of selections) {
        const odds = decimalOdd(selection.odds);
        if (!selection.name || !selection.key || odds === null) continue;
        output.push({
          market_name: marketName,
          selection_name: selection.name,
          odds,
          external_market_key: marketKey,
          external_selection_key: selection.key
        });
      }
    };

    for (const root of roots) {
      const winner = latest(root['1x2'] || root.match_result);
      if (winner) {
        add('Match Winner', [
          { name: 'Home', key: 'home', odds: winner.home },
          { name: 'Draw', key: 'draw', odds: winner.draw },
          { name: 'Away', key: 'away', odds: winner.away }
        ], 'match_winner');
      }

      const btts = latest(root.btts || root.both_teams_to_score);
      if (btts) {
        add('Both Teams to Score', [
          { name: 'Yes', key: 'yes', odds: btts.yes },
          { name: 'No', key: 'no', odds: btts.no }
        ], 'btts');
      }

      const goalLine = latest(root.goal_line || root.goalline);
      if (goalLine && goalLine.line !== undefined && goalLine.line !== null) {
        const line = String(goalLine.line);
        add(`Total Goals ${line}`, [
          { name: `Over ${line}`, key: `over_${line}`, odds: goalLine.over },
          { name: `Under ${line}`, key: `under_${line}`, odds: goalLine.under }
        ], `total_goals_${line}`);
      }

      const fixed = root.goal_line_fixed || root.goalline_fixed;
      const fixedRows = Array.isArray(fixed)
        ? fixed
        : (fixed && typeof fixed === 'object'
          ? Object.entries(fixed).map(([line, row]) => ({ ...(row || {}), line: row?.line ?? line }))
          : []);

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
      if (doubleChance) {
        add('Double Chance', [
          { name: 'Home or Draw', key: 'home_draw', odds: doubleChance.home_draw ?? doubleChance['1x'] },
          { name: 'Home or Away', key: 'home_away', odds: doubleChance.home_away ?? doubleChance['12'] },
          { name: 'Draw or Away', key: 'draw_away', odds: doubleChance.draw_away ?? doubleChance['x2'] }
        ], 'double_chance');
      }
    }

    const unique = new Map();
    for (const market of output) {
      unique.set(`${market.external_market_key}|${market.external_selection_key}`, market);
    }
    return [...unique.values()];
  }

  function fixtureToRow(fixture, nowIso) {
    const externalId = fixture?.id;
    const home = fixture?.teams?.home?.name;
    const away = fixture?.teams?.away?.name;
    if (externalId === undefined || externalId === null || !home || !away) return null;

    const kickoff = validDate(
      fixture?.kickoff_utc ||
      (fixture?.kickoff_ts ? Number(fixture.kickoff_ts) * 1000 : null)
    );
    if (!kickoff) return null;

    const status = mapStatus(fixture?.status);
    // Provider "unknown" means the feed lost the row; do not make it bettable.
    if (status === 'unknown') return null;

    const homeGoals = Number.isInteger(fixture?.goals?.home) ? fixture.goals.home : null;
    const awayGoals = Number.isInteger(fixture?.goals?.away) ? fixture.goals.away : null;
    const confirmedFinished = status === 'finished' && homeGoals !== null && awayGoals !== null;

    return {
      row: {
        home_team: String(home),
        away_team: String(away),
        competition: String(fixture?.league?.name || 'Football'),
        kickoff_at: kickoff,
        match_status: status,
        source_type: 'authorized_feed',
        is_published: true,
        is_simulated: false,
        external_provider: providerName,
        external_fixture_id: String(externalId),
        external_last_synced_at: nowIso,
        // Every row in a PostgREST bulk upsert must have identical keys.
        // Use nulls for score fields when the provider has not confirmed them.
        score_home: homeGoals,
        score_away: awayGoals,
        final_home: confirmedFinished ? homeGoals : null,
        final_away: confirmedFinished ? awayGoals : null,
        match_finished_at: confirmedFinished ? nowIso : null
      },
      fixture: { id: String(externalId), status }
    };
  }

  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const midnightUtc = Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0
    );
    const daySeconds = 24 * 60 * 60;
    const windows = [
      { start: Math.floor(midnightUtc / 1000), end: Math.floor(midnightUtc / 1000) + daySeconds },
      { start: Math.floor(midnightUtc / 1000) + daySeconds, end: Math.floor(midnightUtc / 1000) + 2 * daySeconds }
    ];

    const fixtureMap = new Map();
    const providerWarnings = [];

    // The documented /fixtures endpoint accepts a maximum 24-hour window.
    for (const window of windows) {
      const path = `/fixtures?start_time=${window.start}&end_time=${window.end}&status=all&per_page=100&page=1`;
      try {
        const response = await providerGet(path);
        const rows = Array.isArray(response?.data) ? response.data : [];
        for (const fixture of rows) {
          if (fixture?.id !== undefined && fixture?.id !== null) fixtureMap.set(String(fixture.id), fixture);
        }
      } catch (error) {
        providerWarnings.push(String(error?.message || error));
      }
    }

    // The documented live endpoint returns in-play fixtures regardless of date.
    try {
      const liveResponse = await providerGet('/fixtures?status=live&per_page=500&page=1');
      const liveRows = Array.isArray(liveResponse?.data) ? liveResponse.data : [];
      for (const fixture of liveRows) {
        if (fixture?.id !== undefined && fixture?.id !== null) fixtureMap.set(String(fixture.id), fixture);
      }
    } catch (error) {
      providerWarnings.push(String(error?.message || error));
    }

    if (!fixtureMap.size && providerWarnings.length) {
      throw new Error(providerWarnings.join(' | ').slice(0, 650));
    }

    const fixtures = [...fixtureMap.values()];
    const fixtureRows = [];
    const usableFixtures = [];

    for (const fixture of fixtures) {
      const parsed = fixtureToRow(fixture, nowIso);
      if (!parsed) continue;
      fixtureRows.push(parsed.row);
      usableFixtures.push(parsed.fixture);
    }

    await supabaseUpsert(
      'bluestake_matches',
      fixtureRows,
      'external_provider,external_fixture_id'
    );

    const oddsCandidates = usableFixtures
      .filter(fixture => ['upcoming', 'live'].includes(fixture.status))
      .slice(0, 5);

    let marketSelectionsUpserted = 0;
    let staleSelectionsClosed = 0;
    let finishedMarketsClosed = 0;
    let oddsErrors = 0;
    const oddsErrorDetails = [];

    for (const fixture of usableFixtures.filter(item =>
      ['finished', 'cancelled', 'postponed'].includes(item.status)
    )) {
      try {
        const matches = await supabaseRequest(
          `bluestake_matches?select=id&external_provider=eq.${encodeURIComponent(providerName)}&external_fixture_id=eq.${encodeURIComponent(fixture.id)}&limit=1`
        );
        if (Array.isArray(matches) && matches[0]?.id) {
          finishedMarketsClosed += await closeExternalMarkets(matches[0].id);
        }
      } catch (error) {
        oddsErrors += 1;
        oddsErrorDetails.push(String(error?.message || error).slice(0, 250));
      }
    }

    for (const fixture of oddsCandidates) {
      try {
        const oddsResponse = await providerGet(`/fixtures/${encodeURIComponent(fixture.id)}/odds`);
        const markets = extractMarkets(oddsResponse);
        // An empty/unrecognized response is not proof that old odds disappeared.
        if (!markets.length) continue;

        const matches = await supabaseRequest(
          `bluestake_matches?select=id&external_provider=eq.${encodeURIComponent(providerName)}&external_fixture_id=eq.${encodeURIComponent(fixture.id)}&limit=1`
        );
        if (!Array.isArray(matches) || !matches[0]?.id) continue;

        const matchId = matches[0].id;
        const updatedAt = new Date().toISOString();
        const marketRows = markets.map(market => ({
          match_id: matchId,
          market_name: market.market_name,
          selection_name: market.selection_name,
          odds: market.odds,
          is_open: true,
          external_market_key: market.external_market_key,
          external_selection_key: market.external_selection_key,
          external_odds_updated_at: updatedAt,
          updated_at: updatedAt
        }));

        await supabaseUpsert(
          'bluestake_markets',
          marketRows,
          'match_id,external_market_key,external_selection_key'
        );
        const currentKeys = marketRows.map(
          row => `${row.external_market_key}|${row.external_selection_key}`
        );
        staleSelectionsClosed += await closeExternalMarkets(matchId, currentKeys);
        marketSelectionsUpserted += marketRows.length;
      } catch (error) {
        oddsErrors += 1;
        oddsErrorDetails.push(String(error?.message || error).slice(0, 250));
      }
    }

    const result = {
      success: true,
      provider: providerName,
      fixtureApiRowsReceived: fixtures.length,
      fixturesUpserted: fixtureRows.length,
      upcomingOrLiveFixturesConsideredForOdds: oddsCandidates.length,
      marketSelectionsUpserted,
      staleSelectionsClosed,
      finishedMarketsClosed,
      oddsErrors,
      providerWarnings: providerWarnings.slice(0, 3),
      oddsErrorDetails: oddsErrorDetails.slice(0, 3),
      note: 'Only external-provider matches and external markets are synchronized. Admin-created matches and existing bet/wallet/ledger records are not modified.'
    };

    console.log('[BLUSTAKE sync] Completed', JSON.stringify(result));
    return res.status(200).json(result);
  } catch (error) {
    const message = String(error?.message || error);
    console.error('[BLUSTAKE football sync failed]', {
      message,
      stack: error?.stack || null
    });
    return res.status(502).json({
      error: 'Football synchronization failed',
      details: message.slice(0, 700)
    });
  }
}
