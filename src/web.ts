import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, resolve } from "node:path";
import { URL } from "node:url";

import "./load-env.js";

import { YgoProDeckImageCache } from "./cards/ygoprodeck-image-cache.js";
import { SiteDatabase, type ArchetypeGroupInput, type ReplayDetail, type ReplayListResult, type ReplayPlayerArchetypeMatch } from "./storage/site-database.js";
import { ScraperDatabase } from "./storage/database.js";

type ServerOptions = {
  dbPath: string;
  port: number;
  host: string;
};

const CLIENT_DIST_DIR = resolve("dist/client");
const CLIENT_INDEX_PATH = resolve(CLIENT_DIST_DIR, "index.html");
const ADMIN_COOKIE_NAME = "yugitube_admin_session";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 14;

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

function json(response: http.ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function text(response: http.ServerResponse, status: number, payload: string) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(payload);
}

async function readJsonBody<T>(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function parseCookies(request: http.IncomingMessage) {
  const header = request.headers.cookie ?? "";
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rawKey) {
      continue;
    }
    cookies.set(rawKey, decodeURIComponent(rest.join("=")));
  }
  return cookies;
}

function signSession(sessionId: string, secret: string) {
  return createHmac("sha256", secret).update(sessionId).digest("hex");
}

function createSessionCookie(sessionId: string, secret: string, expiresAt: Date) {
  const signature = signSession(sessionId, secret);
  const value = encodeURIComponent(`${sessionId}.${signature}`);
  return `${ADMIN_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}`;
}

function clearSessionCookie() {
  return `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(0).toUTCString()}`;
}

function getSessionIdFromRequest(request: http.IncomingMessage, secret: string) {
  const raw = parseCookies(request).get(ADMIN_COOKIE_NAME);
  if (!raw) {
    return null;
  }
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }
  const sessionId = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (signSession(sessionId, secret) !== signature) {
    return null;
  }
  return sessionId;
}

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toReplayArchetypesWithImages(
  archetypes: ReplayPlayerArchetypeMatch[],
  imagePaths: Map<string, string | null>,
  croppedPaths: Map<string, string | null>,
) {
  return archetypes.map((archetype) => ({
    ...archetype,
    coverImagePath: archetype.coverCardName ? (imagePaths.get(archetype.coverCardName) ?? null) : null,
    coverImageCroppedPath: archetype.coverCardName ? (croppedPaths.get(archetype.coverCardName) ?? null) : null,
  }));
}

async function attachReplayListImages(imageCache: YgoProDeckImageCache, replayList: ReplayListResult) {
  const coverCardNames = replayList.items
    .flatMap((item) => item.players)
    .flatMap((player) => player.archetypes)
    .map((archetype) => archetype.coverCardName)
    .filter((value): value is string => Boolean(value));
  const [imagePaths, croppedPaths] = await Promise.all([
    imageCache.getPublicPaths(coverCardNames),
    imageCache.getCroppedPublicPaths(coverCardNames),
  ]);

  return {
    ...replayList,
    items: replayList.items.map((item) => ({
      ...item,
      players: item.players.map((player) => ({
        ...player,
        archetypes: toReplayArchetypesWithImages(player.archetypes, imagePaths, croppedPaths),
      })),
    })),
  };
}

async function attachReplayDetailImages(imageCache: YgoProDeckImageCache, replay: any) {
  const cardNames = replay.players.flatMap((player: any) => player.uniqueCards.map((card: any) => card.name));
  const coverCardNames = replay.players
    .flatMap((player: any) => player.archetypes)
    .map((archetype: any) => archetype.coverCardName)
    .filter((value: any): value is string => Boolean(value));
  const [imagePaths, croppedPaths] = await Promise.all([
    imageCache.getPublicPaths([...cardNames, ...coverCardNames]),
    imageCache.getCroppedPublicPaths(coverCardNames),
  ]);

  return {
    ...replay,
    players: replay.players.map((player: any) => ({
      ...player,
      uniqueCards: player.uniqueCards.map((card: any) => ({
        ...card,
        imagePath: imagePaths.get(card.name) ?? null,
      })),
      archetypes: toReplayArchetypesWithImages(player.archetypes, imagePaths, croppedPaths),
    })),
  };
}

async function attachGroupImages(imageCache: YgoProDeckImageCache, groups: Awaited<ReturnType<SiteDatabase["listArchetypeGroups"]>>) {
  const coverNames = groups.map((group) => group.coverCardName).filter((value): value is string => Boolean(value));
  const [imagePaths, croppedPaths] = await Promise.all([
    imageCache.getPublicPaths(coverNames),
    imageCache.getCroppedPublicPaths(coverNames),
  ]);
  return groups.map((group) => ({
    ...group,
    coverImagePath: group.coverCardName ? (imagePaths.get(group.coverCardName) ?? null) : null,
    coverImageCroppedPath: group.coverCardName ? (croppedPaths.get(group.coverCardName) ?? null) : null,
  }));
}

function parseNumber(value: string | null) {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getMimeType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".html":
    default:
      return "text/html; charset=utf-8";
  }
}

async function serveStaticFile(response: http.ServerResponse, filePath: string) {
  const content = await readFile(filePath);
  response.writeHead(200, { "content-type": getMimeType(filePath) });
  response.end(content);
}

function validateArchetypeInput(input: ArchetypeGroupInput) {
  const cards = Array.from(new Set((input.cards ?? []).map((card) => card.trim()).filter(Boolean)));
  const name = input.name?.trim();
  const threshold = Number(input.threshold);

  if (!name) {
    throw new Error("Archetype group name is required.");
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error("Threshold must be an integer greater than 0.");
  }
  if (cards.length === 0) {
    throw new Error("At least one card is required.");
  }
  if (input.coverCardName && !cards.includes(input.coverCardName)) {
    throw new Error("Cover card must be selected from the group card list.");
  }

  return {
    name,
    threshold,
    enabled: input.enabled !== false,
    coverCardName: input.coverCardName ?? null,
    cards,
  } satisfies ArchetypeGroupInput;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const adminPassword = getRequiredEnv("YUGITUBE_ADMIN_PASSWORD");
  const sessionSecret = process.env.YUGITUBE_ADMIN_SESSION_SECRET ?? adminPassword;

  const db = new SiteDatabase();
  db.init();
  const scraperDb = new ScraperDatabase(options.dbPath);
  db.clearExpiredAdminSessions();
  db.ensureReplayDerivedData();
  const imageCache = new YgoProDeckImageCache();

  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${options.host}:${options.port}`}`);

      try {


        if (url.pathname === "/api/replays" && request.method === "GET") {
          const result = await db.listReplayPage({
            q: url.searchParams.get("q") ?? undefined,
            player: url.searchParams.get("player") ?? undefined,
            archetypes: url.searchParams.getAll("archetype"),
            card: url.searchParams.get("card") ?? undefined,
            minRating: parseNumber(url.searchParams.get("minRating")),
            maxRating: parseNumber(url.searchParams.get("maxRating")),
            sort: (url.searchParams.get("sort") as ReplayListResult["items"][number] extends never ? never : "newest") ?? "newest",
            page: parseNumber(url.searchParams.get("page")),
            pageSize: parseNumber(url.searchParams.get("pageSize")),
          });
          json(response, 200, await attachReplayListImages(imageCache, result));
          return;
        }

        if (url.pathname.startsWith("/api/replays/") && request.method === "GET") {
          const duelId = Number(url.pathname.replace("/api/replays/", ""));
          if (!Number.isFinite(duelId)) {
            json(response, 404, { error: "Replay not found." });
            return;
          }
          const replay = await db.getReplayDetail(duelId);
          if (!replay) {
            json(response, 404, { error: "Replay not found." });
            return;
          }
          json(response, 200, await attachReplayDetailImages(imageCache, replay));
          return;
        }

        if (url.pathname === "/api/search/suggestions" && request.method === "GET") {
          const type = url.searchParams.get("type");
          const query = url.searchParams.get("q") ?? "";
          if (type === "player") {
            json(response, 200, await db.searchPlayers(query));
            return;
          }
          if (type === "archetype") {
            json(response, 200, await db.searchArchetypes(query));
            return;
          }
          if (type === "card") {
            const cards = await db.searchCards(query);
            const names = cards.map((card) => card.name);
            const [paths, croppedPaths] = await Promise.all([
              imageCache.getPublicPaths(names),
              imageCache.getCroppedPublicPaths(names),
            ]);
            json(
              response,
              200,
              cards.map((card) => ({
                ...card,
                imagePath: paths.get(card.name) ?? null,
                imageCroppedPath: croppedPaths.get(card.name) ?? null,
              })),
            );
            return;
          }
          json(response, 400, { error: "Unknown suggestion type." });
          return;
        }

        if (url.pathname === "/api/archetypes/highlighted" && request.method === "GET") {
          const archetypes = await db.listHighlightedArchetypes();
          const coverNames = archetypes.map((archetype) => archetype.coverCardName).filter((value): value is string => Boolean(value));
          const [paths, croppedPaths] = await Promise.all([
            imageCache.getPublicPaths(coverNames),
            imageCache.getCroppedPublicPaths(coverNames),
          ]);
          json(
            response,
            200,
            archetypes.map((archetype) => ({
              ...archetype,
              coverImagePath: archetype.coverCardName ? (paths.get(archetype.coverCardName) ?? null) : null,
              coverImageCroppedPath: archetype.coverCardName ? (croppedPaths.get(archetype.coverCardName) ?? null) : null,
            })),
          );
          return;
        }

        if (url.pathname === "/api/admin/login" && request.method === "POST") {
          const body = await readJsonBody<{ password?: string }>(request);
          if (body.password !== adminPassword) {
            json(response, 401, { error: "Invalid admin password." });
            return;
          }

          const sessionId = randomBytes(24).toString("hex");
          const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
          await db.createAdminSession(sessionId, expiresAt.toISOString());
          response.setHeader("Set-Cookie", createSessionCookie(sessionId, sessionSecret, expiresAt));
          json(response, 200, { ok: true });
          return;
        }

        if (url.pathname === "/api/admin/logout" && request.method === "POST") {
          const sessionId = getSessionIdFromRequest(request, sessionSecret);
          if (sessionId) {
            await db.deleteAdminSession(sessionId);
          }
          response.setHeader("Set-Cookie", clearSessionCookie());
          json(response, 200, { ok: true });
          return;
        }

        if (url.pathname === "/api/admin/session" && request.method === "GET") {
          const sessionId = getSessionIdFromRequest(request, sessionSecret);
          const session = sessionId ? await db.getAdminSession(sessionId) : null;
          json(response, 200, { authenticated: Boolean(session) });
          return;
        }

        if (url.pathname.startsWith("/api/admin/")) {
          const sessionId = getSessionIdFromRequest(request, sessionSecret);
          const session = sessionId ? await db.getAdminSession(sessionId) : null;
          if (!session) {
            json(response, 401, { error: "Unauthorized." });
            return;
          }
        }

        if (url.pathname === "/api/admin/archetype-groups" && request.method === "GET") {
          json(response, 200, await attachGroupImages(imageCache, await db.listArchetypeGroups()));
          return;
        }

        if (url.pathname === "/api/admin/archetype-groups" && request.method === "POST") {
          const body = validateArchetypeInput(await readJsonBody<ArchetypeGroupInput>(request));
          const jobId = await db.createReclassificationJob();
          try {
            await db.createArchetypeGroup(body);
            await db.reclassifyAllCompletedDuels();
            await db.finishReclassificationJob(jobId, "completed", JSON.stringify({ scope: "all_completed_duels" }), null);
            json(response, 200, { ok: true });
          } catch (error) {
            await db.finishReclassificationJob(jobId, "failed", null, error instanceof Error ? error.message : String(error));
            throw error;
          }
          return;
        }

        if (url.pathname.startsWith("/api/admin/archetype-groups/") && request.method === "PUT") {
          const groupId = Number(url.pathname.replace("/api/admin/archetype-groups/", ""));
          if (!Number.isFinite(groupId)) {
            json(response, 404, { error: "Group not found." });
            return;
          }
          const body = validateArchetypeInput(await readJsonBody<ArchetypeGroupInput>(request));
          const jobId = await db.createReclassificationJob();
          try {
            await db.updateArchetypeGroup(groupId, body);
            await db.reclassifyAllCompletedDuels();
            await db.finishReclassificationJob(jobId, "completed", JSON.stringify({ scope: "all_completed_duels" }), null);
            json(response, 200, { ok: true });
          } catch (error) {
            await db.finishReclassificationJob(jobId, "failed", null, error instanceof Error ? error.message : String(error));
            throw error;
          }
          return;
        }

        if (url.pathname.startsWith("/api/admin/archetype-groups/") && request.method === "DELETE") {
          const groupId = Number(url.pathname.replace("/api/admin/archetype-groups/", ""));
          if (!Number.isFinite(groupId)) {
            json(response, 404, { error: "Group not found." });
            return;
          }
          const jobId = await db.createReclassificationJob();
          try {
            await db.deleteArchetypeGroup(groupId);
            await db.reclassifyAllCompletedDuels();
            await db.finishReclassificationJob(jobId, "completed", JSON.stringify({ scope: "all_completed_duels" }), null);
            json(response, 200, { ok: true });
          } catch (error) {
            await db.finishReclassificationJob(jobId, "failed", null, error instanceof Error ? error.message : String(error));
            throw error;
          }
          return;
        }

        if (url.pathname === "/api/admin/cards" && request.method === "GET") {
          const cards = await db.searchCards(url.searchParams.get("q") ?? "");
          const names = cards.map((card) => card.name);
          const [imagePaths, croppedPaths] = await Promise.all([
            imageCache.getPublicPaths(names),
            imageCache.getCroppedPublicPaths(names),
          ]);
          json(
            response,
            200,
            cards.map((card) => ({
              ...card,
              imagePath: imagePaths.get(card.name) ?? null,
              imageCroppedPath: croppedPaths.get(card.name) ?? null,
            })),
          );
          return;
        }

        if (url.pathname === "/api/admin/reclassification-jobs/latest" && request.method === "GET") {
          json(response, 200, db.getLatestReclassificationJob());
          return;
        }

        if (url.pathname === "/api/admin/workers" && request.method === "GET") {
          json(response, 200, scraperDb.listActiveWorkers());
          return;
        }

        if (url.pathname === "/health" && request.method === "GET") {
          json(response, 200, { ok: true });
          return;
        }

        const requestPath = url.pathname === "/" ? CLIENT_INDEX_PATH : resolve(CLIENT_DIST_DIR, `.${url.pathname}`);
        if (existsSync(requestPath) && !url.pathname.startsWith("/api/")) {
          await serveStaticFile(response, requestPath);
          return;
        }

        if (!url.pathname.startsWith("/api/")) {
          if (!existsSync(CLIENT_INDEX_PATH)) {
            text(response, 500, "Client build not found. Run `npm run build:client` first.");
            return;
          }
          await serveStaticFile(response, CLIENT_INDEX_PATH);
          return;
        }

        json(response, 404, { error: "Not found." });
      } catch (error) {
        text(response, 500, error instanceof Error ? error.stack ?? error.message : String(error));
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
