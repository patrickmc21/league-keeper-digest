/**
 * Thin wrapper over ESPN's undocumented v3 fantasy API.
 *
 * Uses nothing but the global `fetch` that ships with Node 18+. No npm
 * packages, so there is nothing to install and nothing to keep up to date.
 *
 * NOTE: the field paths this module reads are taken from the documented shape
 * of the v3 responses. If ESPN has moved something, run the fetch script with
 * `--raw-dump ./raw` and compare against the saved JSON — that is much faster
 * than guessing.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HOST = 'https://lm-api-reads.fantasy.espn.com';

/** ESPN rejects some non-browser clients outright. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export class EspnAuthError extends Error {
  constructor(status) {
    super(
      `ESPN rejected the request (HTTP ${status}).\n\n` +
        'This almost always means your espn_s2 / SWID cookies have expired.\n' +
        'Log in to fantasy.espn.com in a browser, grab the two cookies again,\n' +
        'and update config.local.json. See the README for step-by-step help.',
    );
    this.name = 'EspnAuthError';
    this.status = status;
  }
}

export class EspnRequestError extends Error {
  constructor(status, url, body) {
    super(`ESPN request failed (HTTP ${status})\n  ${url}\n  ${String(body).slice(0, 300)}`);
    this.name = 'EspnRequestError';
    this.status = status;
  }
}

/** Build the `Cookie` header value ESPN expects for a private league. */
export function buildCookieHeader({ espnS2, swid }) {
  // The SWID is normally stored with surrounding braces; add them if missing so
  // a copy-paste without them still works.
  const braced = swid.startsWith('{') ? swid : `{${swid}}`;
  return `espn_s2=${espnS2}; SWID=${braced}`;
}

function buildUrl({ leagueId, season, views, scoringPeriodId, historical }) {
  const base = historical
    ? `${HOST}/apis/v3/games/ffl/leagueHistory/${leagueId}`
    : `${HOST}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;

  const params = new URLSearchParams();
  if (historical) params.set('seasonId', String(season));
  if (scoringPeriodId != null) params.set('scoringPeriodId', String(scoringPeriodId));
  for (const view of views) params.append('view', view);

  return `${base}?${params}`;
}

async function requestJson(url, cookie) {
  let response;
  try {
    response = await fetch(url, {
      headers: { Cookie: cookie, Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
  } catch (cause) {
    throw new Error(`Could not reach ESPN. Check your internet connection.\n  ${url}`, { cause });
  }

  if (response.status === 401 || response.status === 403) throw new EspnAuthError(response.status);
  if (response.status === 404) return null; // season not available — caller decides
  if (!response.ok) throw new EspnRequestError(response.status, url, await response.text());

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // ESPN occasionally answers with an HTML error page and a 200.
    throw new EspnRequestError(response.status, url, text);
  }
}

/**
 * Fetch one season of league data.
 *
 * Recent seasons live under `/seasons/{year}/...`; older ones only exist under
 * `/leagueHistory`, which answers with a single-element array. Try the former
 * and fall back to the latter, normalizing both to one object.
 *
 * @returns {Promise<object|null>} null when that season simply doesn't exist.
 */
export async function fetchSeason({
  leagueId,
  season,
  views,
  scoringPeriodId,
  cookie,
  rawDumpDir,
}) {
  let data = await requestJson(
    buildUrl({ leagueId, season, views, scoringPeriodId, historical: false }),
    cookie,
  );

  if (data == null) {
    data = await requestJson(
      buildUrl({ leagueId, season, views, scoringPeriodId, historical: true }),
      cookie,
    );
    if (Array.isArray(data)) data = data[0] ?? null;
  }

  if (data != null && rawDumpDir) {
    await mkdir(rawDumpDir, { recursive: true });
    const label = `${season}-${views.join('+')}${scoringPeriodId != null ? `-sp${scoringPeriodId}` : ''}`;
    await writeFile(
      path.join(rawDumpDir, `${label}.json`),
      JSON.stringify(data, null, 2),
      'utf8',
    );
  }

  return data;
}
