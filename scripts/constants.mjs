/** ESPN numeric id -> label lookups. */

export const POSITIONS = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  7: 'P',
  9: 'DT',
  10: 'DE',
  11: 'LB',
  12: 'CB',
  13: 'S',
  16: 'D/ST',
};

export const PRO_TEAMS = {
  0: 'FA',
  1: 'ATL',
  2: 'BUF',
  3: 'CHI',
  4: 'CIN',
  5: 'CLE',
  6: 'DAL',
  7: 'DEN',
  8: 'DET',
  9: 'GB',
  10: 'TEN',
  11: 'IND',
  12: 'KC',
  13: 'LV',
  14: 'LAR',
  15: 'MIA',
  16: 'MIN',
  17: 'NE',
  18: 'NO',
  19: 'NYG',
  20: 'NYJ',
  21: 'PHI',
  22: 'ARI',
  23: 'PIT',
  24: 'LAC',
  25: 'SF',
  26: 'SEA',
  27: 'TB',
  28: 'WSH',
  29: 'CAR',
  30: 'JAX',
  33: 'BAL',
  34: 'HOU',
};

export const ACQUISITION_TYPES = {
  DRAFT: 'Drafted',
  ADD: 'Waivers / FA',
  WAIVER: 'Waivers',
  TRADE: 'Trade',
};

/** Bench and injured-reserve lineup slots — still on the roster, still keepable. */
export const LINEUP_SLOT_BENCH = 20;
export const LINEUP_SLOT_IR = 21;

export const positionName = (id) => POSITIONS[id] ?? 'FLEX';
export const proTeamName = (id) => PRO_TEAMS[id] ?? 'FA';
export const acquisitionName = (type) => ACQUISITION_TYPES[type] ?? (type ?? 'Unknown');
