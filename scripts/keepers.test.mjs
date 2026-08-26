import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeKeeperStatus,
  flagCostConflicts,
  indexDrafts,
  INELIGIBLE_COST_EXCEEDS_ROUND_1,
  INELIGIBLE_KEEPER_LIMIT,
  MAX_KEEPER_SEASONS,
  UNDRAFTED_KEEPER_COST_ROUND,
} from './keepers.mjs';

const SEASON = 2025; // the season that just finished
const PLAYER = 3139477;

/** Build a pick with sensible defaults so tests only state what matters. */
function pick(overrides = {}) {
  return { playerId: PLAYER, teamId: 1, round: 9, pick: 4, overall: 100, keeper: false, ...overrides };
}

/** Run the rules against a `{ season: [picks] }` literal. */
function statusFor(picksBySeason, playerId = PLAYER) {
  return computeKeeperStatus({
    playerId,
    seasonCompleted: SEASON,
    draftsBySeason: indexDrafts(picksBySeason),
  });
}

test('a drafted player costs one round higher than where he went', () => {
  const status = statusFor({ 2025: [pick({ round: 9 })] });
  assert.equal(status.keeperCostRound, 8);
  assert.equal(status.eligible, true);
  assert.equal(status.yearsRemaining, MAX_KEEPER_SEASONS);
  assert.equal(status.drafted, true);
});

test('an undrafted player costs a 16th-round pick', () => {
  // Somebody else was drafted that season; our guy came off waivers.
  const status = statusFor({ 2025: [pick({ playerId: 999 })] });
  assert.equal(status.keeperCostRound, UNDRAFTED_KEEPER_COST_ROUND);
  assert.equal(status.keeperCostRound, 16);
  assert.equal(status.drafted, false);
  assert.equal(status.eligible, true);
  assert.equal(status.yearsRemaining, 2);
});

test('a 2nd-round pick costs a 1st, which is still legal', () => {
  const status = statusFor({ 2025: [pick({ round: 2 })] });
  assert.equal(status.keeperCostRound, 1);
  assert.equal(status.eligible, true);
});

test('a 1st-round pick cannot go higher and is ineligible', () => {
  const status = statusFor({ 2025: [pick({ round: 1 })] });
  assert.equal(status.eligible, false);
  assert.equal(status.ineligibleReason, INELIGIBLE_COST_EXCEEDS_ROUND_1);
  assert.equal(status.keeperCostRound, null);
});

test('one keeper season already used leaves one year remaining', () => {
  const status = statusFor({
    2025: [pick({ round: 8, keeper: true })], // kept last year
    2024: [pick({ round: 9, keeper: false })], // originally drafted here
  });
  assert.equal(status.seasonsKept, 1);
  assert.equal(status.yearsRemaining, 1);
  assert.equal(status.eligible, true);
  assert.equal(status.keeperCostRound, 7);
});

test('two keeper seasons used means ineligible regardless of cost', () => {
  const status = statusFor({
    2025: [pick({ round: 7, keeper: true })],
    2024: [pick({ round: 8, keeper: true })],
    2023: [pick({ round: 9, keeper: false })],
  });
  assert.equal(status.seasonsKept, 2);
  assert.equal(status.yearsRemaining, 0);
  assert.equal(status.eligible, false);
  assert.equal(status.ineligibleReason, INELIGIBLE_KEEPER_LIMIT);
});

test('the keeper clock follows the player through a trade', () => {
  // Drafted by team 1, kept by team 1, now rostered by team 5. The pick
  // history is unchanged, so cost and eligibility are unchanged.
  const status = statusFor({
    2025: [pick({ round: 8, keeper: true, teamId: 1 })],
    2024: [pick({ round: 9, keeper: false, teamId: 1 })],
  });
  assert.equal(status.keeperCostRound, 7);
  assert.equal(status.yearsRemaining, 1);
});

test('a keeper picked up off waivers the prior year has a complete chain', () => {
  // Kept in 2025 at Rd 15, but absent from the 2024 draft because he was a
  // waiver add that season. That is a legitimate end of the chain, not a gap.
  const status = statusFor({
    2025: [pick({ round: 15, keeper: true })],
    2024: [pick({ playerId: 999 })],
  });
  assert.equal(status.seasonsKept, 1);
  assert.equal(status.historyIncomplete, false);
  assert.equal(status.keeperCostRound, 14);
});

test('running out of pulled seasons mid-chain flags history as incomplete', () => {
  // Kept in 2025 and we have no 2024 draft to check against.
  const status = statusFor({ 2025: [pick({ round: 8, keeper: true })] });
  assert.equal(status.seasonsKept, 1);
  assert.equal(status.historyIncomplete, true);
});

test('a complete chain is not flagged as incomplete', () => {
  const status = statusFor({
    2025: [pick({ round: 8, keeper: true })],
    2024: [pick({ round: 9, keeper: false })],
  });
  assert.equal(status.historyIncomplete, false);
});

test('the cost chain reads forwards from the original draft', () => {
  const status = statusFor({
    2025: [pick({ round: 8, pick: 4, keeper: true })],
    2024: [pick({ round: 9, pick: 4, keeper: false })],
  });
  assert.equal(status.costChain, 'Rd 9, Pick 4 (2024 draft) → kept Rd 8 (2025) → costs Rd 7 (2026)');
});

test('the cost chain says so when a player is not keepable', () => {
  const status = statusFor({ 2025: [pick({ round: 1, pick: 1 })] });
  assert.match(status.costChain, /not keepable in 2026$/);
});

test('the cost chain calls out an undrafted pickup', () => {
  const status = statusFor({ 2025: [pick({ playerId: 999 })] });
  assert.equal(
    status.costChain,
    'Not drafted in 2025 (waiver/FA pickup) → costs Rd 16 (2026)',
  );
});

test('two eligible keepers costing the same round are both flagged', () => {
  const players = flagCostConflicts([
    { name: 'A', eligible: true, keeperCostRound: 8 },
    { name: 'B', eligible: true, keeperCostRound: 8 },
    { name: 'C', eligible: true, keeperCostRound: 5 },
    { name: 'D', eligible: false, keeperCostRound: null },
  ]);
  assert.deepEqual(
    players.map((p) => p.costConflict),
    [true, true, false, false],
  );
});

test('ineligible players never trigger a cost conflict', () => {
  const players = flagCostConflicts([
    { name: 'A', eligible: false, keeperCostRound: null },
    { name: 'B', eligible: false, keeperCostRound: null },
  ]);
  assert.deepEqual(
    players.map((p) => p.costConflict),
    [false, false],
  );
});
