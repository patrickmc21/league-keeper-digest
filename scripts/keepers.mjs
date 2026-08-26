/**
 * Keeper cost + eligibility rules.
 *
 * Everything in this file is a pure function over plain objects — no network,
 * no filesystem. That is deliberate: these are the rules the league argues
 * about, so they are the part that must be provable by `npm test`.
 *
 * League rules encoded here:
 *   - A keeper costs one round HIGHER than the round he was drafted in last
 *     season. A Rd 9 pick costs a Rd 8 pick.
 *   - A player who was NOT drafted last season (waiver/FA pickup) costs a
 *     16th-round pick.
 *   - A player may be kept for at most 2 seasons. The season he was originally
 *     drafted does not count against that.
 *   - If a keeper's cost would climb past Rd 1, he is ineligible and goes back
 *     into the draft pool.
 */

/** Keeper cost for a player who went undrafted last season. */
export const UNDRAFTED_KEEPER_COST_ROUND = 16;

/** How many seasons in a row a player may be kept. */
export const MAX_KEEPER_SEASONS = 2;

export const INELIGIBLE_KEEPER_LIMIT = 'keeper_limit_reached';
export const INELIGIBLE_COST_EXCEEDS_ROUND_1 = 'cost_exceeds_round_1';

export const INELIGIBLE_REASON_TEXT = {
  [INELIGIBLE_KEEPER_LIMIT]: `Already kept ${MAX_KEEPER_SEASONS} seasons`,
  [INELIGIBLE_COST_EXCEEDS_ROUND_1]: 'Cost would exceed Rd 1',
};

/**
 * Index raw draft picks by season and player for fast walk-back lookups.
 *
 * @param {Record<number, Array<object>>} picksBySeason - season -> array of picks,
 *   each `{ playerId, teamId, round, pick, overall, keeper }`.
 * @returns {Map<number, Map<number, object>>}
 */
export function indexDrafts(picksBySeason) {
  const index = new Map();
  for (const [season, picks] of Object.entries(picksBySeason)) {
    const bySeason = new Map();
    for (const pick of picks) bySeason.set(pick.playerId, pick);
    index.set(Number(season), bySeason);
  }
  return index;
}

/**
 * Walk backwards through the drafts to find how many seasons in a row this
 * player has already been kept, and the chain of picks that got him here.
 *
 * The walk stops at the first non-keeper pick (that is his original draft), or
 * when he simply isn't in that season's draft (he was a waiver pickup that
 * year). If we run out of pulled seasons while still on a keeper pick, the
 * chain is truncated and `historyIncomplete` is set so a human can verify
 * rather than the tool silently guessing.
 */
function traceDraftHistory(playerId, seasonCompleted, draftsBySeason) {
  const draftHistory = [];
  let seasonsKept = 0;
  let season = seasonCompleted;

  while (draftsBySeason.has(season)) {
    const pick = draftsBySeason.get(season).get(playerId);
    if (!pick) break;

    draftHistory.push({
      season,
      round: pick.round,
      pick: pick.pick ?? null,
      overall: pick.overall ?? null,
      teamId: pick.teamId ?? null,
      keeper: Boolean(pick.keeper),
    });

    if (!pick.keeper) break; // reached the original draft
    seasonsKept += 1;
    season -= 1;
  }

  // Truncated only if we ran out of SEASONS mid-chain. A player who is simply
  // absent from an earlier draft was a waiver pickup that year — that is a
  // complete, legitimate chain.
  const oldest = draftHistory.at(-1);
  const historyIncomplete = Boolean(oldest?.keeper) && !draftsBySeason.has(season);

  return { draftHistory, seasonsKept, historyIncomplete };
}

/**
 * Human-readable provenance, e.g.
 *   "Rd 9, Pick 4 (2024 draft) → kept Rd 8 (2025) → costs Rd 7 (2026)"
 */
export function describeDraftChain({
  draftHistory,
  drafted,
  keeperCostRound,
  eligible,
  seasonCompleted,
  keeperSeason,
  historyIncomplete,
}) {
  const parts = [];

  if (!drafted) {
    parts.push(`Not drafted in ${seasonCompleted} (waiver/FA pickup)`);
  } else {
    // Stored newest-first; read it oldest-first so it tells a story forwards.
    for (const entry of [...draftHistory].reverse()) {
      if (entry.keeper) {
        parts.push(`kept Rd ${entry.round} (${entry.season})`);
      } else {
        const pick = entry.pick ? `, Pick ${entry.pick}` : '';
        parts.push(`Rd ${entry.round}${pick} (${entry.season} draft)`);
      }
    }
    if (historyIncomplete) parts.unshift('…');
  }

  parts.push(
    eligible ? `costs Rd ${keeperCostRound} (${keeperSeason})` : `not keepable in ${keeperSeason}`,
  );

  return parts.join(' → ');
}

/**
 * Compute one player's keeper cost and remaining eligibility.
 *
 * @param {object} args
 * @param {number} args.playerId
 * @param {number} args.seasonCompleted - the season that just finished.
 * @param {Map<number, Map<number, object>>} args.draftsBySeason - from `indexDrafts`.
 * @returns {object} keeper status fields, merged into the player record.
 */
export function computeKeeperStatus({ playerId, seasonCompleted, draftsBySeason }) {
  const keeperSeason = seasonCompleted + 1;
  const lastSeasonPick = draftsBySeason.get(seasonCompleted)?.get(playerId);
  const drafted = Boolean(lastSeasonPick);

  // One round higher than where he went; undrafted players cost a 16th.
  const keeperCostRound = drafted ? lastSeasonPick.round - 1 : UNDRAFTED_KEEPER_COST_ROUND;

  const { draftHistory, seasonsKept, historyIncomplete } = traceDraftHistory(
    playerId,
    seasonCompleted,
    draftsBySeason,
  );

  const yearsRemaining = Math.max(0, MAX_KEEPER_SEASONS - seasonsKept);

  let eligible = true;
  let ineligibleReason = null;
  if (yearsRemaining <= 0) {
    eligible = false;
    ineligibleReason = INELIGIBLE_KEEPER_LIMIT;
  } else if (keeperCostRound < 1) {
    eligible = false;
    ineligibleReason = INELIGIBLE_COST_EXCEEDS_ROUND_1;
  }

  return {
    drafted,
    keeperCostRound: eligible ? keeperCostRound : null,
    yearsRemaining,
    seasonsKept,
    eligible,
    ineligibleReason,
    ineligibleReasonText: ineligibleReason ? INELIGIBLE_REASON_TEXT[ineligibleReason] : null,
    historyIncomplete,
    draftHistory,
    costChain: describeDraftChain({
      draftHistory,
      drafted,
      keeperCostRound,
      eligible,
      seasonCompleted,
      keeperSeason,
      historyIncomplete,
    }),
  };
}

/**
 * Two keepers on the same team can't both cost the same round. Flag every
 * player caught in such a clash so the roster view can warn about it.
 *
 * Mutates and returns the given players.
 */
export function flagCostConflicts(players) {
  const byRound = new Map();
  for (const player of players) {
    if (!player.eligible) continue;
    const group = byRound.get(player.keeperCostRound) ?? [];
    group.push(player);
    byRound.set(player.keeperCostRound, group);
  }
  for (const player of players) player.costConflict = false;
  for (const group of byRound.values()) {
    if (group.length > 1) for (const player of group) player.costConflict = true;
  }
  return players;
}
