import http from "node:http";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { ScraperDatabase, type DuelDetail, type DuelListItem, type DuelPacketRow } from "./storage/database.js";
import { YgoProDeckImageCache } from "./cards/ygoprodeck-image-cache.js";

type ServerOptions = {
  dbPath: string;
  port: number;
  host: string;
};

type CardTile = {
  name: string;
  imagePath: string | null;
};

function parseArgs(argv: string[]): ServerOptions {
  let dbPath = ".runtime/yugitube.sqlite";
  let port = 3000;
  let host = "127.0.0.1";

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--db-path" && next) {
      dbPath = next;
      index += 1;
      continue;
    }
    if (current === "--port" && next) {
      port = Number(next);
      index += 1;
      continue;
    }
    if (current === "--host" && next) {
      host = next;
      index += 1;
    }
  }

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid --port value: ${port}`);
  }

  return { dbPath, port, host };
}

function escapeHtml(input: unknown) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value: string | null) {
  if (!value) {
    return "n/a";
  }
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatDuration(startedAt: string | null, completedAt: string | null) {
  if (!startedAt || !completedAt) {
    return "n/a";
  }

  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return "n/a";
  }

  const totalSeconds = Math.round((end - start) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function renderLayout(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f5f5;
      --panel: #ffffff;
      --text: #111111;
      --muted: #666666;
      --line: #dddddd;
      --link: #0b57d0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 Menlo, Monaco, Consolas, monospace;
    }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1, h2, h3 { margin: 0 0 12px; line-height: 1.2; }
    .wrap { max-width: 1200px; margin: 0 auto; display: grid; gap: 16px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      overflow: auto;
    }
    .muted { color: var(--muted); }
    .grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    }
    .stats {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
    }
    .stat strong {
      display: block;
      font-size: 22px;
      margin-top: 6px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      text-align: left;
      vertical-align: top;
      border-top: 1px solid var(--line);
      padding: 8px 10px;
    }
    th { background: #fafafa; }
    .cards {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    }
    .card img,
    .card .placeholder {
      width: 100%;
      height: 140px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fafafa;
      object-fit: cover;
      display: block;
    }
    .card .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px;
      font-size: 11px;
      color: var(--muted);
      text-align: center;
    }
    .card-name {
      margin-top: 6px;
      font-size: 11px;
      line-height: 1.3;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="wrap">
    ${body}
  </div>
</body>
</html>`;
}

function renderDuelTable(duels: DuelListItem[]) {
  if (duels.length === 0) {
    return `<p class="muted">No duels stored yet.</p>`;
  }

  const rows = duels
    .map((duel) => {
      const archetypes = Array.from(new Set(Object.values(duel.probableArchetypes).filter(Boolean))).join(", ");
      return `<tr>
        <td><a href="/duels/${duel.duelId}">${duel.duelId}</a></td>
        <td>${duel.winner ? escapeHtml(duel.winner) : ""}</td>
        <td>${duel.loser ? escapeHtml(duel.loser) : ""}</td>
        <td>${duel.finalScore ? escapeHtml(duel.finalScore) : ""}</td>
        <td>${duel.gamesPlayed}</td>
        <td>${duel.realPlays ?? ""}</td>
        <td>${escapeHtml(formatDuration(duel.startedAt, duel.completedAt))}</td>
        <td>${escapeHtml(archetypes || "")}</td>
        <td>${duel.replayUrl ? `<a href="${escapeHtml(duel.replayUrl)}" target="_blank" rel="noreferrer">Replay</a>` : ""}</td>
      </tr>`;
    })
    .join("");

  return `<table>
    <thead>
      <tr>
        <th>Duel</th>
        <th>Winner</th>
        <th>Loser</th>
        <th>Score</th>
        <th>Games</th>
        <th>Plays</th>
        <th>Duration</th>
        <th>Archetypes</th>
        <th>Replay</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderIndexPage(db: ScraperDatabase) {
  const stats = db.getDashboardStats();
  const duels = db.listRecentDuels(100);

  return renderLayout(
    "YugiTube Duel Viewer",
    `
    <div class="panel">
      <h1>YugiTube Duel Viewer</h1>
      <p class="muted">Stored replay browser.</p>
    </div>

    <div class="panel">
      <div class="stats">
        <div class="stat">Total duels<strong>${stats.totalDuels}</strong></div>
        <div class="stat">Completed<strong>${stats.completedDuels}</strong></div>
        <div class="stat">Replays shown<strong>${duels.length}</strong></div>
      </div>
    </div>

    <div class="panel">
      <h2>Recent duels</h2>
      ${renderDuelTable(duels)}
    </div>
  `,
  );
}

function derivePlayerRatings(packets: DuelPacketRow[], players: string[]) {
  let player1Name: string | null = null;
  let player2Name: string | null = null;
  const ratings: Record<string, number | null> = Object.fromEntries(players.map((player) => [player, null]));

  for (const row of packets) {
    let packet: Record<string, unknown>;
    try {
      packet = JSON.parse(row.packetJson) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof packet.player1 === "string" && typeof packet.player2 === "string") {
      player1Name = packet.player1;
      player2Name = packet.player2;
    }

    if (packet.player1 && typeof packet.player1 === "object") {
      const username = (packet.player1 as { username?: unknown }).username;
      if (typeof username === "string" && username) {
        player1Name = username;
      }
    }

    if (packet.player2 && typeof packet.player2 === "object") {
      const username = (packet.player2 as { username?: unknown }).username;
      if (typeof username === "string" && username) {
        player2Name = username;
      }
    }

    if (!player1Name || !player2Name) {
      continue;
    }

    const player1Rating = packet.player1 && typeof packet.player1 === "object" ? (packet.player1 as { rating?: unknown }).rating : undefined;
    const player2Rating = packet.player2 && typeof packet.player2 === "object" ? (packet.player2 as { rating?: unknown }).rating : undefined;

    if (typeof player1Rating === "number") {
      ratings[player1Name] = player1Rating;
    }
    if (typeof player2Rating === "number") {
      ratings[player2Name] = player2Rating;
    }
  }

  return ratings;
}

function renderCardGallery(cards: CardTile[]) {
  if (cards.length === 0) {
    return `<p class="muted">No cards recorded.</p>`;
  }

  return `<div class="cards">
    ${cards
      .map((card) => {
        const visual = card.imagePath
          ? `<img src="${escapeHtml(card.imagePath)}" alt="${escapeHtml(card.name)}" title="${escapeHtml(card.name)}">`
          : `<div class="placeholder">No image</div>`;

        return `<div class="card">
          ${visual}
          <div class="card-name">${escapeHtml(card.name)}</div>
        </div>`;
      })
      .join("")}
  </div>`;
}

function renderPlayerBlocks(
  detail: DuelDetail,
  packets: DuelPacketRow[],
  imagePathLookup: Map<string, string | null>,
) {
  const summary = detail.summary;
  if (!summary) {
    return `<p class="muted">No parsed summary stored.</p>`;
  }

  const ratings = derivePlayerRatings(packets, summary.players);

  return summary.players
    .map((player) => {
      const cards = (summary.cardsByPlayer[player] ?? []).map((name) => ({
        name,
        imagePath: imagePathLookup.get(name) ?? null,
      }));
      const archetypes = Array.from(new Set([summary.probableArchetypes[player]].filter(Boolean)));

      return `<div class="panel">
        <h3>${escapeHtml(player)}</h3>
        <p><strong>Rating:</strong> ${ratings[player] ?? "n/a"}</p>
        <p><strong>Won:</strong> ${summary.winner === player ? "yes" : "no"}</p>
        <p><strong>Archetypes:</strong> ${archetypes.length ? escapeHtml(archetypes.join(", ")) : "n/a"}</p>
        <p><strong>Plays:</strong> ${summary.perPlayerRealPlays[player] ?? 0}</p>
        <p><strong>Unique cards:</strong> ${summary.uniqueCardsCountByPlayer[player] ?? 0}</p>
        ${renderCardGallery(cards)}
      </div>`;
    })
    .join("");
}

function renderDetailPage(
  detail: DuelDetail,
  packets: DuelPacketRow[],
  imagePathLookup: Map<string, string | null>,
) {
  const summary = detail.summary;

  const gameRows = summary
    ? summary.games
        .map(
          (game) => `<tr>
            <td>${game.gameNumber}</td>
            <td>${escapeHtml(game.scoreAtStart)}</td>
            <td>${game.startingPlayer ? escapeHtml(game.startingPlayer) : ""}</td>
            <td>${game.winner ? escapeHtml(game.winner) : ""}</td>
            <td>${game.realPlays}</td>
          </tr>`,
        )
        .join("")
    : "";

  return renderLayout(
    `Duel ${detail.duelId}`,
    `
    <div class="panel">
      <p><a href="/">Back</a></p>
      <h1>Duel ${detail.duelId}</h1>
      <p><strong>Winner:</strong> ${detail.winner ? escapeHtml(detail.winner) : "n/a"}</p>
      <p><strong>Loser:</strong> ${detail.loser ? escapeHtml(detail.loser) : "n/a"}</p>
      <p><strong>Score:</strong> ${detail.finalScore ? escapeHtml(detail.finalScore) : "n/a"}</p>
      <p><strong>Games played:</strong> ${detail.gamesPlayed}</p>
      <p><strong>Duration:</strong> ${escapeHtml(formatDuration(detail.startedAt, detail.completedAt))}</p>
      <p><strong>Replay:</strong> ${detail.replayUrl ? `<a href="${escapeHtml(detail.replayUrl)}" target="_blank" rel="noreferrer">Open on DuelingBook</a>` : "n/a"}</p>
    </div>

    <div class="panel">
      <h2>Match overview</h2>
      ${summary ? `<p><strong>Plays:</strong> ${summary.realPlays}</p>` : `<p class="muted">No summary available.</p>`}
    </div>

    <div class="grid">
      ${renderPlayerBlocks(detail, packets, imagePathLookup)}
    </div>

    <div class="panel">
      <h2>Games</h2>
      ${
        summary
          ? `<table>
              <thead>
                <tr>
                  <th>Game</th>
                  <th>Start score</th>
                  <th>Starting player</th>
                  <th>Winner</th>
                  <th>Plays</th>
                </tr>
              </thead>
              <tbody>${gameRows}</tbody>
            </table>`
          : `<p class="muted">No game breakdown available.</p>`
      }
    </div>
  `,
  );
}

function renderNotFound() {
  return renderLayout(
    "Not found",
    `<div class="panel"><h1>Not found</h1><p><a href="/">Back</a></p></div>`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = new ScraperDatabase(options.dbPath);
  db.init();
  const imageCache = new YgoProDeckImageCache();

  const server = http.createServer((request, response) => {
    void (async () => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${options.host}:${options.port}`}`);

    try {
      if (url.pathname.startsWith("/card-images/")) {
        const fileName = decodeURIComponent(url.pathname.replace("/card-images/", ""));
        const filePath = imageCache.getFilePath(fileName);
        const body = await readFile(filePath);
        const lower = fileName.toLowerCase();
        const contentType = lower.endsWith(".webp")
          ? "image/webp"
          : lower.endsWith(".png")
            ? "image/png"
            : "image/jpeg";
        response.writeHead(200, {
          "content-type": contentType,
          "cache-control": "public, max-age=31536000, immutable",
        });
        response.end(body);
        return;
      }

      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderIndexPage(db));
        return;
      }

      if (url.pathname.startsWith("/duels/")) {
        const duelId = Number(url.pathname.replace("/duels/", ""));
        if (!Number.isFinite(duelId)) {
          response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
          response.end(renderNotFound());
          return;
        }

        const detail = db.getDuelDetail(duelId);
        if (!detail) {
          response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
          response.end(renderNotFound());
          return;
        }

        const packets = db.getDuelPackets(duelId);
        const allNames = Array.from(new Set(Object.values(detail.summary?.cardsByPlayer ?? {}).flat()));
        const imagePathLookup = await imageCache.getPublicPaths(allNames);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderDetailPage(detail, packets, imagePathLookup));
        return;
      }

      if (url.pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(renderNotFound());
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.stack ?? error.message : "Unknown error");
    }
    })();
  });

  server.listen(options.port, options.host, () => {
    console.log(`[web] listening on http://${options.host}:${options.port} db=${options.dbPath}`);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
