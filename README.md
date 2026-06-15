# YugiTube

This reset replaces the previous app with a minimal DuelingBook login client.

The current scope is only the browserless login flow:

- submit the same multipart login form used by the site
- capture and persist cookies
- verify that the resulting session works on a follow-up request

## Setup

```bash
npm install
```

Required environment variables:

```bash
DUELINGBOOK_USERNAME=your-username
DUELINGBOOK_PASSWORD=your-password
```

Put them in `.env`. The CLI loads that file automatically.

## Run

```bash
npm run login
```

Websocket probe:

```bash
npm run probe:ws
```

Watch-mode websocket client:

```bash
npm run watch:ws
```

Autonomous duel recorder:

```bash
npm run record:duel -- --log-file .runtime/logs/duel-plays.ndjson
```

This mode:

- stays in the lobby until a new qualifying duel starts
- only attempts fresh duels where the returned `Watch duel` score is `(0-0-0)`
- exits stale in-progress matches with `Exit duel` and returns to `Load watching`
- records only raw `Duel` packets that contain a `play` field
- stops automatically on the first recorded play packet where `over` is `true`

24/7 supervisor:

```bash
npm run scrape:supervisor -- --db-path .runtime/yugitube.sqlite
```

This mode:

- starts one long-running supervisor process
- manages multiple watcher accounts in parallel
- keeps qualifying duel assignment centralized so only one account records a duel
- stores completed duel raw play logs and parsed analytics in SQLite
- refreshes the DuelingBook card catalog on startup and periodically afterward

Duel log parser:

```bash
npm run parse:duel -- --input-file .runtime/logs/duel-plays.ndjson
```

This produces structured JSON with:

- players, winner, loser, and final score
- number of duels in the match
- observed turn count
- total packet count and filtered real-play count
- per-game summaries
- unique cards seen per player
- top repeated cards per player
- a few derived insights for later presentation

One-off duel log ingest into SQLite:

```bash
npm run ingest:duel-log -- --input-file .runtime/logs/duel-plays.ndjson --db-path .runtime/yugitube.sqlite --duel-id 82726446
```

One-off card sync:

```bash
npm run sync:cards -- --db-path .runtime/yugitube.sqlite
```

Minimal local website:

```bash
npm run web -- --db-path .runtime/yugitube.sqlite --port 3000
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000).

Passive lobby capture:

```bash
npm run watch:ws -- --lobby-only --log-file .runtime/logs/lobby.ndjson --no-heartbeat-log
```

Default interesting-duel filter:

- `type=m`
- `format=ar`
- `rules=TCG`
- both player ratings `>= 300`

Supervisor account and filter config come from `.env`:

```bash
DUELINGBOOK_WATCHER_ACCOUNTS=billyburger1,billyburger2,billyburger3,billyburger4,billyburger5
DUELINGBOOK_WATCHER_PASSWORD=billy123
SCRAPER_DUEL_TYPE=m
SCRAPER_DUEL_FORMAT=ar
SCRAPER_DUEL_RULES=TCG
SCRAPER_MIN_RATING=300
```

Change the filter with flags like:

```bash
npm run watch:ws -- --lobby-only --log-file .runtime/logs/lobby.ndjson --min-rating 500
npm run record:duel -- --log-file .runtime/logs/duel-plays.ndjson --min-rating 500
npm run watch:ws -- --lobby-only --log-file .runtime/logs/lobby.ndjson --type m --format ar --rules TCG --min-rating 300
npm run watch:ws -- --lobby-only --log-file .runtime/logs/lobby.ndjson --no-interesting-only
```

Useful options:

```bash
npm run watch:ws -- --card "Mulcharmy Fuwalos"
npm run watch:ws -- --duel-id 12345678
npm run watch:ws -- --no-auto-watch
npm run watch:ws -- --lobby-only --log-file .runtime/logs/lobby.ndjson
npm run watch:ws -- --all-packets
npm run watch:ws -- --no-heartbeat-log
npm run watch:ws -- --min-rating 500
```

Default watch flow:

1. Login through `login-user.php`
2. Open `wss://duel.duelingbook.com:8443/`
3. Send `Connect`
4. Send `Heartbeat` every 30 seconds
5. Send `Load watching`
6. Log `Load duels`
7. Auto-send `Watch duel` for the first watchable duel unless `--no-auto-watch` is used
8. Print relevant incoming packets such as `Connected`, `Heartbeat`, `Load duels`, `Watch duel`, `Duel`, `Duel over`, `Rejected`, and connection-state packets
9. If `--log-file` is set, append every parsed websocket packet to newline-delimited JSON for later analysis

Default ignored noise:

- `Load statuses`
- `Load videos`
- `Load official tourneys`
- `Online user`
- `Offline user`
- `Back`
- `Away`
- `Like status`
- chat-loading packets

Optional flags:

```bash
npm run login -- --cookie-file .runtime/duelingbook-session.json
npm run login -- --username your-username --password your-password
npm run login -- --no-remember-me
```

The command:

1. posts to `https://www.duelingbook.com/php-scripts/login-user.php`
2. stores the returned cookies in a local JSON session file
3. requests the DuelingBook homepage with those cookies
4. confirms the session appears authenticated

## Current files

- `src/duelingbook/client.ts`: HTTP client and cookie jar
- `src/duelingbook/session-store.ts`: session persistence helpers
- `src/login.ts`: CLI entrypoint
- `src/probe-websocket.ts`: login + websocket activity probe
- `src/watch-websocket.ts`: persistent watch-mode websocket client
