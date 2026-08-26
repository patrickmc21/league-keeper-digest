/**
 * Keeper Digest — renders docs/data/league.json.
 *
 * All the keeper math already happened in scripts/keepers.mjs; this file only
 * displays what the data file says. Keep it that way, so the rules live in
 * exactly one place and stay unit-tested.
 */

const DATA_URL = './data/league.json';
const STORE_KEY = 'keeper-digest.prefs';

const el = {
  leagueName: document.getElementById('league-name'),
  headline: document.getElementById('headline'),
  subhead: document.getElementById('subhead'),
  controls: document.getElementById('controls'),
  app: document.getElementById('app'),
  search: document.getElementById('search'),
  teamFilter: document.getElementById('team-filter'),
  keepersOnly: document.getElementById('keepers-only'),
  generated: document.getElementById('generated'),
};

const state = {
  digest: null,
  view: 'teams',
  query: '',
  teamId: 'all',
  keepersOnly: false,
  sort: { key: 'cost', dir: 'asc' },
};

// ---------------------------------------------------------------------------
// Preferences (best-effort — private browsing can throw on access)
// ---------------------------------------------------------------------------

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ view: state.view, teamId: state.teamId, keepersOnly: state.keepersOnly }),
    );
  } catch {
    /* not important enough to bother the user about */
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const h = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
};

const costLabel = (player) => (player.eligible ? `Rd ${player.keeperCostRound}` : '—');

const pointsLabel = (player) =>
  player.pointsLastSeason == null ? '—' : player.pointsLastSeason.toFixed(1);

function playerClasses(player) {
  if (!player.eligible) return 'is-out';
  return player.yearsRemaining === 1 ? 'is-final' : '';
}

function badgesFor(player) {
  const badges = [];
  if (!player.eligible) {
    badges.push(['badge-out', player.ineligibleReasonText ?? 'Ineligible']);
  } else if (player.yearsRemaining === 1) {
    badges.push(['badge-final', 'Final year']);
  }
  if (player.costConflict) badges.push(['badge-warn', 'Cost clash']);
  if (player.historyIncomplete) badges.push(['badge-verify', 'Verify']);
  return badges.map(([cls, text]) => h('span', { className: `badge ${cls}`, textContent: text }));
}

/** Every player, tagged with the team that rosters him. */
function allPlayers(digest) {
  return digest.teams.flatMap((team) =>
    team.players.map((player) => ({ ...player, teamId: team.id, teamName: team.name })),
  );
}

function matchesFilters(player) {
  if (state.keepersOnly && !player.eligible) return false;
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return (
    player.name.toLowerCase().includes(q) ||
    player.position.toLowerCase().includes(q) ||
    player.proTeam.toLowerCase().includes(q)
  );
}

// ---------------------------------------------------------------------------
// Rendering — team cards
// ---------------------------------------------------------------------------

function renderChain(player) {
  const rows = [h('dt', { textContent: 'How this cost was worked out' }), h('dd', { textContent: player.costChain })];

  if (player.historyIncomplete) {
    rows.push(
      h('dt', { textContent: 'Worth double-checking' }),
      h('dd', {
        textContent:
          "He was already a keeper in the earliest season we pulled, so the count may start earlier than shown.",
      }),
    );
  }
  if (player.costConflict) {
    rows.push(
      h('dt', { textContent: 'Cost clash' }),
      h('dd', {
        textContent: `Another keeper on this roster also costs ${costLabel(player)} — only one of them can be kept at that price.`,
      }),
    );
  }
  rows.push(
    h('dt', { textContent: 'Acquired' }),
    h('dd', { textContent: player.acquisition ?? 'Unknown' }),
  );

  return h('dl', { className: 'chain' }, rows);
}

function renderPlayer(player) {
  const meta = [
    player.position,
    player.proTeam,
    `${pointsLabel(player)} pts`,
    player.eligible ? `${player.yearsRemaining} yr left` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const badges = badgesFor(player);

  return h(
    'details',
    { className: `player ${playerClasses(player)}` },
    h(
      'summary',
      {},
      h('span', { className: 'cost', textContent: costLabel(player) }),
      h(
        'span',
        { className: 'player-id' },
        h('span', { className: 'player-name', textContent: player.name }),
        h('span', { className: 'player-meta', textContent: meta }),
        badges.length ? h('span', { className: 'badges' }, badges) : null,
      ),
    ),
    renderChain(player),
  );
}

function renderTeams(digest) {
  const teams = digest.teams
    .filter((team) => state.teamId === 'all' || String(team.id) === state.teamId)
    .map((team) => {
      const players = team.players.filter(matchesFilters);
      if (!players.length) return null;

      const keepable = players.filter((p) => p.eligible).length;
      // Open the card when the league is filtered down to one team or a search
      // is running — otherwise browsing twelve open rosters is a lot of scroll.
      const open = state.teamId !== 'all' || Boolean(state.query) || digest.teams.length <= 2;

      return h(
        'details',
        { className: 'team', open },
        h(
          'summary',
          {},
          h(
            'span',
            { className: 'team-name' },
            team.name,
            h('span', { className: 'team-owner', textContent: team.owner }),
          ),
          h('span', {
            className: 'team-count',
            textContent: `${keepable} keepable / ${players.length}`,
          }),
        ),
        players.map(renderPlayer),
      );
    })
    .filter(Boolean);

  if (!teams.length) return [h('p', { className: 'empty', textContent: 'Nobody matches that.' })];
  return teams;
}

// ---------------------------------------------------------------------------
// Rendering — league table
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: 'cost', label: 'Cost', numeric: true },
  { key: 'name', label: 'Player' },
  { key: 'position', label: 'Pos' },
  { key: 'proTeam', label: 'NFL' },
  { key: 'points', label: 'Pts', numeric: true },
  { key: 'years', label: 'Yrs left', numeric: true },
  { key: 'teamName', label: 'Roster' },
];

function sortValue(player, key) {
  switch (key) {
    // Ineligible players have no cost; park them after every real one.
    case 'cost':
      return player.eligible ? player.keeperCostRound : Number.MAX_SAFE_INTEGER;
    case 'points':
      return player.pointsLastSeason ?? -1;
    case 'years':
      return player.eligible ? player.yearsRemaining : -1;
    default:
      return player[key] ?? '';
  }
}

function renderTable(digest) {
  const players = allPlayers(digest)
    .filter(matchesFilters)
    .filter((p) => state.teamId === 'all' || String(p.teamId) === state.teamId);

  const { key, dir } = state.sort;
  players.sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return dir === 'asc' ? cmp : -cmp;
  });

  if (!players.length) return [h('p', { className: 'empty', textContent: 'Nobody matches that.' })];

  const head = h(
    'tr',
    {},
    COLUMNS.map((col) => {
      const th = h('th', { textContent: col.label, scope: 'col' });
      th.setAttribute('aria-sort', key === col.key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
      th.addEventListener('click', () => {
        state.sort =
          key === col.key
            ? { key, dir: dir === 'asc' ? 'desc' : 'asc' }
            : { key: col.key, dir: col.numeric ? 'asc' : 'asc' };
        render();
      });
      return th;
    }),
  );

  const rows = players.map((player) =>
    h(
      'tr',
      { className: playerClasses(player) },
      h('td', {}, h('span', { className: 'cost-inline', textContent: costLabel(player) })),
      h('td', { textContent: player.name, title: player.costChain }),
      h('td', { textContent: player.position }),
      h('td', { textContent: player.proTeam }),
      h('td', { className: 'num', textContent: pointsLabel(player) }),
      h('td', { className: 'num', textContent: player.eligible ? String(player.yearsRemaining) : '—' }),
      h('td', { textContent: player.teamName }),
    ),
  );

  return [
    h('div', { className: 'table-scroll' }, h('table', {}, h('thead', {}, head), h('tbody', {}, rows))),
  ];
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function render() {
  el.app.replaceChildren(
    ...(state.view === 'teams' ? renderTeams(state.digest) : renderTable(state.digest)),
  );
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === state.view));
  }
}

function renderShell(digest) {
  const { league } = digest;
  document.title = `${league.name} — Keeper Digest`;
  el.leagueName.textContent = league.name;
  el.headline.textContent = `${league.keeperSeason} Keeper Digest`;
  el.subhead.textContent = `Rosters as they stood at the end of the ${league.seasonCompleted} season.`;

  el.teamFilter.replaceChildren(
    h('option', { value: 'all', textContent: 'All teams' }),
    ...digest.teams.map((team) => h('option', { value: String(team.id), textContent: team.name })),
  );

  const when = new Date(digest.generatedAt);
  const stamp = Number.isNaN(when.valueOf()) ? digest.generatedAt : when.toLocaleString();
  el.generated.textContent =
    `Data pulled from ESPN on ${stamp}. ` +
    `Draft history checked back to ${league.seasonsAvailable[0]}.`;
  el.controls.hidden = false;
}

function wireControls() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.view = tab.dataset.view;
      savePrefs();
      render();
    });
  }

  el.search.addEventListener('input', () => {
    state.query = el.search.value.trim();
    render();
  });

  el.teamFilter.addEventListener('change', () => {
    state.teamId = el.teamFilter.value;
    savePrefs();
    render();
  });

  el.keepersOnly.addEventListener('change', () => {
    state.keepersOnly = el.keepersOnly.checked;
    savePrefs();
    render();
  });
}

function renderSetupHelp() {
  el.leagueName.textContent = 'Not published yet';
  el.app.replaceChildren(
    h(
      'div',
      { className: 'setup' },
      h('h2', { textContent: 'No league data yet' }),
      h('p', {
        textContent:
          'This page is live, but nobody has published the league data yet. The commissioner needs to run the fetch script once and commit the result.',
      }),
      h('p', {}, h('code', { textContent: 'node scripts/fetch-league.mjs' })),
      h('p', {
        textContent: 'That writes docs/data/league.json. Commit and push it, and this page fills in.',
      }),
    ),
  );
}

async function main() {
  const prefs = loadPrefs();
  state.view = prefs.view === 'table' ? 'table' : 'teams';
  state.teamId = prefs.teamId ?? 'all';
  state.keepersOnly = Boolean(prefs.keepersOnly);
  el.keepersOnly.checked = state.keepersOnly;

  let response;
  try {
    response = await fetch(DATA_URL, { cache: 'no-cache' });
  } catch {
    el.app.replaceChildren(
      h('p', { className: 'status', textContent: 'Could not load the league data.' }),
    );
    return;
  }

  if (!response.ok) {
    renderSetupHelp();
    return;
  }

  state.digest = await response.json();
  renderShell(state.digest);

  // A saved team filter is only valid if that team still exists.
  if (!state.digest.teams.some((t) => String(t.id) === state.teamId)) state.teamId = 'all';
  el.teamFilter.value = state.teamId;

  wireControls();
  render();
}

main();
