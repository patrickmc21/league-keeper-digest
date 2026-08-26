#!/usr/bin/env node
/**
 * Pull the league's end-of-season rosters and draft history out of ESPN and
 * write the digest data file the static site reads.
 *
 *   node scripts/fetch-league.mjs                 # write docs/data/league.json
 *   node scripts/fetch-league.mjs --dry-run       # print a table, write nothing
 *   node scripts/fetch-league.mjs --raw-dump ./raw
 *   node scripts/fetch-league.mjs --sample        # fake data, no network, no cookies
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCookieHeader, EspnAuthError, fetchSeason } from './espn-client.mjs';
import { acquisitionName, positionName, proTeamName } from './constants.mjs';
import { computeKeeperStatus, flagCostConflicts, indexDrafts } from './keepers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'docs', 'data', 'league.json');
const DEFAULT_CONFIG = path.join(ROOT, 'config.local.json');

/** How many prior seasons to pull for the keeper walk-back. */
const DEFAULT_HISTORY_SEASONS = 6;

const MIN_NODE_MAJOR = 18;

const HELP = `
Fantasy Keeper Digest — pull league data from ESPN

Usage: node scripts/fetch-league.mjs [options]

Options:
  --season <year>   Season that just finished. Default: last completed season.
  --history <n>     Prior seasons to pull for eligibility. Default: ${DEFAULT_HISTORY_SEASONS}.
  --out <path>      Where to write the digest. Default: docs/data/league.json
  --config <path>   Config file. Default: config.local.json
  --raw-dump <dir>  Also save ESPN's untouched responses here (for debugging).
  --dry-run         Print a summary table instead of writing the file.
  --sample          Generate fake data offline, to preview the site layout.
  --help            Show this message.
`;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_HELP = `
Missing or incomplete config.

Copy config.example.json to config.local.json and fill in three values:

  leagueId  The number in your ESPN league URL (…?leagueId=123456)
  espnS2    The "espn_s2" cookie from fantasy.espn.com
  swid      The "SWID" cookie from fantasy.espn.com

To get the cookies: sign in at fantasy.espn.com in Chrome, press F12, open the
Application tab, expand Cookies -> https://fantasy.espn.com, and copy the
values of "espn_s2" and "SWID".

config.local.json is gitignored. Never commit it — those cookies are live
credentials for your ESPN account.
`;

async function loadConfig(configPath) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    throw new Error(`${CONFIG_HELP}\nLooked for: ${configPath}`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${configPath} is not valid JSON.\n${cause.message}`);
  }

  const missing = ['leagueId', 'espnS2', 'swid'].filter((key) => !config[key]);
  if (missing.length) throw new Error(`${CONFIG_HELP}\nMissing: ${missing.join(', ')}`);

  return config;
}

/**
 * An NFL season spills into January, and the season named for the current year
 * isn't finished until then either — so the last completed season is always the
 * previous calendar year. Override with --season if you need something else.
 */
function defaultCompletedSeason(now = new Date()) {
  return now.getFullYear() - 1;
}

// ---------------------------------------------------------------------------
// Normalizing ESPN's payloads
// ---------------------------------------------------------------------------

/** ESPN flags keepers on the pick itself; older payloads use `reservedForKeeper`. */
function normalizePicks(seasonData) {
  const picks = seasonData?.draftDetail?.picks ?? [];
  return picks.map((pick) => ({
    playerId: pick.playerId,
    teamId: pick.teamId,
    round: pick.roundId,
    pick: pick.roundPickNumber ?? null,
    overall: pick.overallPickNumber ?? null,
    keeper: Boolean(pick.keeper || pick.reservedForKeeper),
  }));
}

/** Team names moved from location+nickname to a single `name` field. */
function teamName(team) {
  if (team.name) return team.name.trim();
  return [team.location, team.nickname].filter(Boolean).join(' ').trim() || `Team ${team.id}`;
}

function ownerName(team, membersById) {
  const ids = team.owners ?? (team.primaryOwner ? [team.primaryOwner] : []);
  const names = ids
    .map((id) => membersById.get(id))
    .filter(Boolean)
    .map((m) => m.displayName || [m.firstName, m.lastName].filter(Boolean).join(' '))
    .filter(Boolean);
  return names.join(', ') || '—';
}

/** Season-long fantasy points, which ESPN buries in a stats array. */
function seasonPoints(entry, season) {
  const stats = entry?.playerPoolEntry?.player?.stats ?? [];
  const total = stats.find(
    (s) => s.statSourceId === 0 && s.statSplitTypeId === 0 && Number(s.seasonId) === Number(season),
  );
  const points = total?.appliedTotal ?? entry?.playerPoolEntry?.appliedStatTotal;
  return typeof points === 'number' ? Math.round(points * 10) / 10 : null;
}

function normalizePlayer(entry, season) {
  const player = entry?.playerPoolEntry?.player ?? {};
  return {
    playerId: entry.playerId ?? player.id,
    name: player.fullName ?? `Player ${entry.playerId}`,
    position: positionName(player.defaultPositionId),
    proTeam: proTeamName(player.proTeamId),
    pointsLastSeason: seasonPoints(entry, season),
    acquisition: acquisitionName(entry.acquisitionType),
  };
}

/** Cheapest keeper cost first; ineligible players sink to the bottom. */
function byKeeperValue(a, b) {
  if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
  if (a.eligible && a.keeperCostRound !== b.keeperCostRound) {
    return a.keeperCostRound - b.keeperCostRound;
  }
  return (b.pointsLastSeason ?? 0) - (a.pointsLastSeason ?? 0);
}

// ---------------------------------------------------------------------------
// Building the digest
// ---------------------------------------------------------------------------

function buildDigest({ seasonData, rosterData, draftsBySeason, seasonCompleted, seasonsAvailable }) {
  const membersById = new Map((seasonData.members ?? []).map((m) => [m.id, m]));
  const rosterTeams = new Map((rosterData.teams ?? []).map((t) => [t.id, t]));
  const teamNamesById = new Map((seasonData.teams ?? []).map((t) => [t.id, teamName(t)]));

  const teams = (seasonData.teams ?? []).map((team) => {
    const entries = rosterTeams.get(team.id)?.roster?.entries ?? [];

    const players = entries.map((entry) => {
      const base = normalizePlayer(entry, seasonCompleted);
      const status = computeKeeperStatus({
        playerId: base.playerId,
        seasonCompleted,
        draftsBySeason,
      });
      // Name the team that made each pick so the provenance line reads plainly.
      const draftHistory = status.draftHistory.map((pick) => ({
        ...pick,
        team: teamNamesById.get(pick.teamId) ?? null,
      }));
      return { ...base, ...status, draftHistory };
    });

    flagCostConflicts(players);
    players.sort(byKeeperValue);

    return {
      id: team.id,
      name: teamNamesById.get(team.id),
      abbrev: team.abbrev ?? '',
      owner: ownerName(team, membersById),
      logo: team.logo ?? null,
      players,
    };
  });

  teams.sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    league: {
      id: seasonData.id,
      name: seasonData.settings?.name ?? `League ${seasonData.id}`,
      seasonCompleted,
      keeperSeason: seasonCompleted + 1,
      undraftedCostRound: 16,
      maxKeeperSeasons: 2,
      seasonsAvailable,
    },
    teams,
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchDigest({ leagueId, cookie, seasonCompleted, historySeasons, rawDumpDir }) {
  const log = (msg) => process.stderr.write(`${msg}\n`);

  log(`Fetching ${seasonCompleted} league settings, teams and draft…`);
  const seasonData = await fetchSeason({
    leagueId,
    season: seasonCompleted,
    views: ['mSettings', 'mTeam', 'mDraftDetail'],
    cookie,
    rawDumpDir,
  });

  if (!seasonData) {
    throw new Error(
      `ESPN has no data for league ${leagueId} in ${seasonCompleted}. ` +
        'Check the league id, or pass a different --season.',
    );
  }

  // Rosters must be requested for a specific week; the last one of the season
  // is the end-of-year snapshot the mobile app refuses to show.
  const finalWeek =
    seasonData.status?.finalScoringPeriod ?? seasonData.scoringPeriodId ?? 17;
  log(`Fetching end-of-season rosters (week ${finalWeek})…`);
  const rosterData = await fetchSeason({
    leagueId,
    season: seasonCompleted,
    views: ['mRoster'],
    scoringPeriodId: finalWeek,
    cookie,
    rawDumpDir,
  });

  if (!rosterData) throw new Error(`Could not load rosters for week ${finalWeek}.`);

  // Walk back through prior drafts so eligibility can be traced.
  const picksBySeason = { [seasonCompleted]: normalizePicks(seasonData) };
  const seasonsAvailable = [seasonCompleted];

  for (let i = 1; i <= historySeasons; i += 1) {
    const season = seasonCompleted - i;
    log(`Fetching ${season} draft for keeper history…`);
    const prior = await fetchSeason({
      leagueId,
      season,
      views: ['mDraftDetail'],
      cookie,
      rawDumpDir,
    });
    if (!prior) {
      log(`  no ${season} season found — stopping history walk-back.`);
      break;
    }
    picksBySeason[season] = normalizePicks(prior);
    seasonsAvailable.unshift(season);
  }

  return buildDigest({
    seasonData,
    rosterData,
    draftsBySeason: indexDrafts(picksBySeason),
    seasonCompleted,
    seasonsAvailable,
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printSummary(digest) {
  const { league, teams } = digest;
  const lines = [];
  lines.push('');
  lines.push(`${league.name} — keeper digest for ${league.keeperSeason}`);
  lines.push(`Rosters as of the end of ${league.seasonCompleted}.`);
  lines.push(`Draft history pulled: ${league.seasonsAvailable.join(', ')}`);

  for (const team of teams) {
    lines.push('');
    lines.push(`${team.name}  (${team.owner})`);
    for (const player of team.players) {
      const cost = player.eligible ? `Rd ${String(player.keeperCostRound).padStart(2)}` : '  —   ';
      const years = player.eligible ? `${player.yearsRemaining}yr left` : player.ineligibleReasonText;
      const flags = [
        player.costConflict ? 'COST CLASH' : null,
        player.historyIncomplete ? 'VERIFY' : null,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(
        `  ${cost}  ${player.name.padEnd(24)} ${player.position.padEnd(4)} ` +
          `${String(player.pointsLastSeason ?? '-').padStart(6)} pts  ${years}  ${flags}`,
      );
    }
  }

  const total = teams.reduce((n, t) => n + t.players.length, 0);
  lines.push('');
  lines.push(`${teams.length} teams, ${total} players.`);
  lines.push('');
  process.stdout.write(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Sample data (offline preview)
// ---------------------------------------------------------------------------

function buildSampleDigest(seasonCompleted) {
  const roster = [
    ['Bijan Robinson', 'RB', 'ATL', 291.4, 3, 4],
    ['Puka Nacua', 'WR', 'LAR', 244.8, 9, 7],
    ['Sam LaPorta', 'TE', 'DET', 178.2, 11, 3],
    ['Jayden Daniels', 'QB', 'WSH', 388.6, 1, 9],
    ['Jordan Mason', 'RB', 'MIN', 132.5, null, null],
    ['Tucker Kraft', 'TE', 'GB', 121.0, 14, 2],
  ];

  const picksBySeason = { [seasonCompleted]: [], [seasonCompleted - 1]: [] };
  const players = roster.map(([name, position, proTeam, points, round, pick], i) => {
    const playerId = 1000 + i;
    if (round != null) {
      // Give the first two a prior keeper season so the badges are visible.
      const kept = i < 2;
      picksBySeason[seasonCompleted].push({
        playerId, teamId: 1, round, pick, overall: round * 10 + pick, keeper: kept,
      });
      if (kept) {
        picksBySeason[seasonCompleted - 1].push({
          playerId, teamId: 1, round: round + 1, pick, overall: (round + 1) * 10 + pick,
          keeper: i === 0,
        });
      }
    }
    return { playerId, name, position, proTeam, pointsLastSeason: points, acquisition: round == null ? 'Waivers / FA' : 'Drafted' };
  });

  const draftsBySeason = indexDrafts(picksBySeason);
  const enriched = players.map((p) => ({
    ...p,
    ...computeKeeperStatus({ playerId: p.playerId, seasonCompleted, draftsBySeason }),
  }));
  flagCostConflicts(enriched);
  enriched.sort(byKeeperValue);

  const teams = ['Sample Team A', 'Sample Team B', 'Sample Team C'].map((name, i) => ({
    id: i + 1,
    name,
    abbrev: `S${i + 1}`,
    owner: `Manager ${i + 1}`,
    logo: null,
    players: i === 0 ? enriched : enriched.slice(i).map((p) => ({ ...p })),
  }));

  return {
    generatedAt: new Date().toISOString(),
    league: {
      id: 0,
      name: 'SAMPLE DATA — run "npm run fetch" for real numbers',
      seasonCompleted,
      keeperSeason: seasonCompleted + 1,
      undraftedCostRound: 16,
      maxKeeperSeasons: 2,
      seasonsAvailable: [seasonCompleted - 1, seasonCompleted],
    },
    teams,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < MIN_NODE_MAJOR) {
    throw new Error(
      `This script needs Node ${MIN_NODE_MAJOR} or newer (you have ${process.versions.node}).\n` +
        'Install the current LTS from https://nodejs.org and try again.',
    );
  }

  const { values } = parseArgs({
    options: {
      season: { type: 'string' },
      history: { type: 'string' },
      out: { type: 'string' },
      config: { type: 'string' },
      'raw-dump': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      sample: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const seasonCompleted = values.season ? Number(values.season) : defaultCompletedSeason();
  if (!Number.isInteger(seasonCompleted)) throw new Error(`--season must be a year, got "${values.season}"`);

  const outPath = values.out ? path.resolve(values.out) : DEFAULT_OUT;

  let digest;
  if (values.sample) {
    process.stderr.write('Building sample data (no network, no cookies)…\n');
    digest = buildSampleDigest(seasonCompleted);
  } else {
    const config = await loadConfig(values.config ? path.resolve(values.config) : DEFAULT_CONFIG);
    digest = await fetchDigest({
      leagueId: config.leagueId,
      cookie: buildCookieHeader(config),
      seasonCompleted,
      historySeasons: values.history ? Number(values.history) : DEFAULT_HISTORY_SEASONS,
      rawDumpDir: values['raw-dump'] ? path.resolve(values['raw-dump']) : null,
    });
  }

  if (values['dry-run']) {
    printSummary(digest);
    process.stderr.write('\nDry run — nothing written.\n');
    return;
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(digest, null, 2)}\n`, 'utf8');

  const total = digest.teams.reduce((n, t) => n + t.players.length, 0);
  process.stderr.write(
    `\nWrote ${path.relative(ROOT, outPath)} — ${digest.teams.length} teams, ${total} players.\n` +
      'Commit and push it to update the site.\n',
  );
}

main().catch((error) => {
  // Expected failures (bad config, expired cookies) get a clean message; only
  // genuine bugs get a stack trace.
  const expected = error instanceof EspnAuthError || error.message.includes('config.local.json');
  process.stderr.write(`\n${expected ? error.message : (error.stack ?? error.message)}\n`);
  process.exitCode = 1;
});
