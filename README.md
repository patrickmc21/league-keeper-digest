# League Keeper Digest

A phone-friendly keeper cheat sheet for our fantasy league, published as a static
GitHub Pages site.

The ESPN mobile app won't show you last season's final rosters, and it has no idea
how many keeper years anyone has left. This fixes both. The commissioner runs one
command locally, commits the result, and everyone in the league gets a URL showing:

- every player on every roster at the **end of last season**
- what each one **costs to keep**
- how many **keeper years** he has left
- **how that cost was worked out**, pick by pick, back to his original draft

---

## Keeper rules this encodes

| Rule | Behavior |
| --- | --- |
| Keeper cost | One round **higher** than where he was drafted last season — a Rd 9 pick costs your Rd 8 pick. |
| Undrafted players | Cost a **16th-round** pick. |
| Eligibility | A player can be kept **two seasons**. The year you originally drafted him doesn't count. |
| Past Rd 1 | If a keeper's cost would climb past Rd 1, he's ineligible and goes back in the draft pool. |
| Trades | Cost and eligibility follow the **player**, so trading him doesn't reset anything. |

Keeper status comes straight from ESPN's own keeper flag on each draft pick, so
nothing is tracked by hand.

If your league ever changes these rules, they live in one place:
[`scripts/keepers.mjs`](scripts/keepers.mjs). Change the constants at the top,
run `npm test`, and the site follows.

---

## Requirements

**Node 18 or newer. That's it.** There are no npm dependencies — no `npm install`,
no `node_modules`, nothing to keep up to date. Everything uses Node's built-ins.

Check what you have:

```sh
node --version
```

If that errors or prints something below v18, install the current LTS from
[nodejs.org](https://nodejs.org).

---

## Quick start

### 1. See the site before touching any credentials

```sh
npm run sample     # writes fake data so you can look at the layout
npm run preview    # serves it at http://localhost:8080
```

The preview also prints a `http://192.168.x.x:8080` address — open that on your
phone (same Wi-Fi) to see what the league will actually see.

### 2. Set up your ESPN credentials

Copy the example config:

```sh
cp config.example.json config.local.json
```

Then fill in three values:

| Field | Where to find it |
| --- | --- |
| `leagueId` | The number in your league URL: `fantasy.espn.com/football/league?leagueId=`**`123456`** |
| `espnS2` | A browser cookie (below) |
| `swid` | A browser cookie (below) |

**Getting the two cookies (Chrome):**

1. Sign in at [fantasy.espn.com](https://fantasy.espn.com) and open your league.
2. Press `F12` to open developer tools.
3. Click the **Application** tab.
4. In the left sidebar, expand **Cookies** → `https://fantasy.espn.com`.
5. Find `espn_s2` and `SWID`, and copy each **Value** into `config.local.json`.

The `SWID` value normally includes curly braces — paste it either way, the script
handles both.

> ⚠️ **`config.local.json` is gitignored. Never commit it.** Those cookies are live
> credentials for your ESPN account — anyone who has them can act as you. If you
> ever paste them somewhere public, sign out of ESPN everywhere to invalidate them.
>
> They also expire every so often. When the script says ESPN rejected the request,
> just repeat the steps above to grab fresh ones.

### 3. Pull the real data

Do a dry run first — it prints a summary and writes nothing:

```sh
node scripts/fetch-league.mjs --dry-run
```

Sanity-check the output against the ESPN desktop site: right team names, right
roster sizes, and a couple of keeper costs you already know. When it looks right:

```sh
npm run fetch
```

That writes `docs/data/league.json`.

### 4. Publish

```sh
git add docs/data/league.json
git commit -m "Update keeper digest"
git push
```

Then, one time only, turn on Pages: **Settings → Pages → Source: Deploy from a
branch → Branch: `main`, folder: `/docs` → Save.**

A minute later the league can use the URL GitHub gives you. Every future update is
just steps 3 and 4 again.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run fetch` | Pull from ESPN, write `docs/data/league.json` |
| `npm run sample` | Write fake data offline — no cookies, no network |
| `npm run preview` | Serve `docs/` at `localhost:8080` (and on your LAN) |
| `npm test` | Run the keeper-rules tests |

`fetch-league.mjs` also takes:

| Flag | What it does |
| --- | --- |
| `--season 2025` | Which completed season to read. Defaults to last year. |
| `--dry-run` | Print a summary table, write nothing |
| `--raw-dump ./raw` | Also save ESPN's untouched responses, for debugging |
| `--history 6` | How many prior seasons to check for keeper history |
| `--help` | Full usage |

---

## Reading the site

Players are listed cheapest keeper cost first, since that's roughly "best value
first." Tap any player to see how his cost was worked out.

| Badge | Meaning |
| --- | --- |
| **Final year** | This is the last season you can keep him. |
| **Ineligible** | He's back in the draft pool — either kept twice already, or his cost would pass Rd 1. |
| **Cost clash** | Two keepers on that roster cost the same round. Only one of them can be kept at that price. |
| **Verify** | He was already a keeper in the earliest season we pulled, so his count may have started earlier. Worth a manual check. |

If **Verify** shows up a lot, pull more history: `node scripts/fetch-league.mjs --history 8`.

---

## Troubleshooting

**"ESPN rejected the request (HTTP 401)"** — your cookies expired. Grab fresh ones
(step 2) and rerun.

**"ESPN has no data for league … "** — check `leagueId`, or try an explicit
`--season`.

**A player's cost looks wrong** — open his row on the site; the chain shows exactly
which picks the cost was derived from. If a pick looks wrong there, it's wrong in
ESPN's draft data.

**Something else looks off** — run with `--raw-dump ./raw` and look at the saved
JSON. ESPN's API is undocumented and does move fields around occasionally; the raw
dump shows what actually came back. (`raw/` is gitignored — it contains league and
member details.)

---

## How it fits together

```
scripts/fetch-league.mjs   CLI: pull, compute, write
├── espn-client.mjs        talks to ESPN's v3 API (fetch only)
├── keepers.mjs            the keeper rules — pure functions, unit-tested
└── constants.mjs          ESPN id → name lookups

docs/                      the site GitHub Pages serves
├── index.html
├── app.js                 renders league.json — contains no keeper logic
├── styles.css
└── data/league.json       generated, committed
```

The keeper math lives only in `keepers.mjs`, and the site just displays what the
data file says. That's deliberate: the rules the league argues about are in one
file, covered by `npm test`.
