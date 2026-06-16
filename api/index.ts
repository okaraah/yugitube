import { createHmac, randomBytes } from "node:crypto";
import { URL } from "node:url";

import type { VercelRequest, VercelResponse } from "@vercel/node";

import { SiteDatabase, type ArchetypeGroupInput, type ReplayListResult, type ReplayPlayerArchetypeMatch } from "../src/storage/site-database.js";

const ADMIN_COOKIE_NAME = "yugitube_admin_session";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 14;

// Global singletons (preserved across warm starts)
let db: SiteDatabase | null = null;
let dbInitPromise: Promise<void> | null = null;

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

function getSessionIdFromRequest(req: VercelRequest, secret: string) {
  const raw = req.cookies[ADMIN_COOKIE_NAME];
  if (!raw) return null;
  
  const decoded = decodeURIComponent(raw);
  const separator = decoded.lastIndexOf(".");
  if (separator <= 0) return null;
  
  const sessionId = decoded.slice(0, separator);
  const signature = decoded.slice(separator + 1);
  if (signSession(sessionId, secret) !== signature) {
    return null;
  }
  return sessionId;
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

async function attachReplayListImages(db: SiteDatabase, replayList: ReplayListResult, filters?: any) {
  const coverCardNames = replayList.items
    .flatMap((item) => item.players)
    .flatMap((player) => player.archetypes)
    .map((archetype) => archetype.coverCardName)
    .filter((value): value is string => Boolean(value));
  const [imagePaths, croppedPaths] = await db.getCardImagePaths(coverCardNames);

  const filterMetadata: Array<{ name: string; kind: string; imageCroppedPath: string | null }> = [];
  if (filters) {
    if (filters.cards && filters.cards.length > 0) {
      const [imgP, cropP] = await db.getCardImagePaths(filters.cards);
      for (const card of filters.cards) {
        filterMetadata.push({ name: card, kind: "card", imageCroppedPath: cropP.get(card) ?? null });
      }
    }
    if (filters.archetypes && filters.archetypes.length > 0) {
      const groups = await db.listArchetypeGroups();
      const activeGroups = groups.filter(g => filters.archetypes.includes(g.name));
      const coverCards = activeGroups.map(g => g.coverCardName).filter(Boolean) as string[];
      const [imgP, cropP] = await db.getCardImagePaths(coverCards);
      for (const arch of filters.archetypes) {
        const group = activeGroups.find(g => g.name === arch);
        const cover = group?.coverCardName;
        filterMetadata.push({ name: arch, kind: "archetype", imageCroppedPath: cover ? (cropP.get(cover) ?? null) : null });
      }
    }
  }

  return {
    ...replayList,
    filterMetadata,
    items: replayList.items.map((item) => ({
      ...item,
      players: item.players.map((player) => ({
        ...player,
        archetypes: toReplayArchetypesWithImages(player.archetypes, imagePaths, croppedPaths),
      })),
    })),
  };
}

async function attachReplayDetailImages(db: SiteDatabase, replay: any) {
  const cardNames = replay.players.flatMap((player: any) => player.uniqueCards.map((card: any) => card.name));
  const coverCardNames = replay.players
    .flatMap((player: any) => player.archetypes)
    .map((archetype: any) => archetype.coverCardName)
    .filter((value: any): value is string => Boolean(value));
  const [imagePaths, croppedPaths] = await db.getCardImagePaths([...cardNames, ...coverCardNames]);

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

async function attachGroupImages(db: SiteDatabase, groups: any[]) {
  const coverNames = groups.map((group) => group.coverCardName).filter((value): value is string => Boolean(value));
  const [imagePaths, croppedPaths] = await db.getCardImagePaths(coverNames);
  return groups.map((group) => ({
    ...group,
    coverImagePath: group.coverCardName ? (imagePaths.get(group.coverCardName) ?? null) : null,
    coverImageCroppedPath: group.coverCardName ? (croppedPaths.get(group.coverCardName) ?? null) : null,
  }));
}

function parseNumber(value: string | null | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validateArchetypeInput(input: any) {
  const cards = Array.from<string>(new Set((input.cards ?? []).map((card: string) => card.trim()).filter(Boolean)));
  const name = input.name?.trim();
  const threshold = Number(input.threshold);

  if (!name) throw new Error("Archetype group name is required.");
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error("Threshold must be an integer greater than 0.");
  if (cards.length === 0) throw new Error("At least one card is required.");
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (!db) {
      db = new SiteDatabase();
    }

    if (!dbInitPromise) {
      dbInitPromise = db.init().then(() => {
        // It's safe to use the non-null assertion (!) here because db is defined right above
        return Promise.all([
          db!.clearExpiredAdminSessions(),
          db!.ensureReplayDerivedData()
        ]);
      }).then(() => {});
    }
    await dbInitPromise;
  } catch (error: any) {
    // If the database fails to initialize (missing URL or invalid credentials), we catch it here and return gracefully
    console.error("Database initialization failed:", error);
    return res.status(500).json({ error: `Database initialization failed: ${error.message}` });
  }

  const adminPassword = process.env.YUGITUBE_ADMIN_PASSWORD;
  if (!adminPassword) {
    return res.status(500).json({ error: "YUGITUBE_ADMIN_PASSWORD is not configured." });
  }
  const sessionSecret = process.env.YUGITUBE_ADMIN_SESSION_SECRET ?? adminPassword;

  // Reconstruct URL for easy query parsing
  const url = new URL(req.url ?? "/", `https://${req.headers.host}`);

  try {
    if (url.pathname === "/api/replays" && req.method === "GET") {
      const filters = {
        q: url.searchParams.get("q") ?? undefined,
        player: url.searchParams.get("player") ?? undefined,
        archetypes: url.searchParams.getAll("archetype"),
        cards: url.searchParams.getAll("card"),
        minRating: parseNumber(url.searchParams.get("minRating")),
        maxRating: parseNumber(url.searchParams.get("maxRating")),
        sort: (url.searchParams.get("sort") as any) ?? "newest",
        page: parseNumber(url.searchParams.get("page")),
        pageSize: parseNumber(url.searchParams.get("pageSize")),
      };
      const result = await db.listReplayPage(filters);
      return res.status(200).json(await attachReplayListImages(db, result, filters));
    }

    if (url.pathname.startsWith("/api/replays/") && req.method === "GET") {
      const duelId = Number(url.pathname.replace("/api/replays/", ""));
      if (!Number.isFinite(duelId)) return res.status(404).json({ error: "Replay not found." });
      
      const replay = await db.getReplayDetail(duelId);
      if (!replay) return res.status(404).json({ error: "Replay not found." });
      
      return res.status(200).json(await attachReplayDetailImages(db, replay));
    }

    if (url.pathname === "/api/search/suggestions" && req.method === "GET") {
      const type = url.searchParams.get("type");
      const query = url.searchParams.get("q") ?? "";
      if (type === "player") return res.status(200).json(await db.searchPlayers(query));
      if (type === "archetype") return res.status(200).json(await db.searchArchetypes(query));
      if (type === "card") {
        const cards = await db.searchCards(query);
        return res.status(200).json(
          cards.map((card) => {
            const idToUse = card.passcode && card.passcode > 0 ? card.passcode : card.cardId;
            return {
              ...card,
              imagePath: `https://images.ygoprodeck.com/images/cards/${idToUse}.jpg`,
              imageCroppedPath: `https://images.ygoprodeck.com/images/cards_cropped/${idToUse}.jpg`,
            };
          })
        );
      }
      return res.status(400).json({ error: "Unknown suggestion type." });
    }

    if (url.pathname === "/api/archetypes/highlighted" && req.method === "GET") {
      const archetypes = await db.listHighlightedArchetypes();
      const coverNames = archetypes.map((archetype) => archetype.coverCardName).filter((value): value is string => Boolean(value));
      const [paths, croppedPaths] = await db.getCardImagePaths(coverNames);
      return res.status(200).json(
        archetypes.map((archetype) => ({
          ...archetype,
          coverImagePath: archetype.coverCardName ? (paths.get(archetype.coverCardName) ?? null) : null,
          coverImageCroppedPath: archetype.coverCardName ? (croppedPaths.get(archetype.coverCardName) ?? null) : null,
        }))
      );
    }

    if (url.pathname === "/api/admin/login" && req.method === "POST") {
      const body = req.body || {};
      if (body.password !== adminPassword) return res.status(401).json({ error: "Invalid admin password." });

      const sessionId = randomBytes(24).toString("hex");
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
      await db.createAdminSession(sessionId, expiresAt.toISOString());
      res.setHeader("Set-Cookie", createSessionCookie(sessionId, sessionSecret, expiresAt));
      return res.status(200).json({ ok: true });
    }

    if (url.pathname === "/api/admin/logout" && req.method === "POST") {
      const sessionId = getSessionIdFromRequest(req, sessionSecret);
      if (sessionId) await db.deleteAdminSession(sessionId);
      res.setHeader("Set-Cookie", clearSessionCookie());
      return res.status(200).json({ ok: true });
    }

    if (url.pathname === "/api/admin/session" && req.method === "GET") {
      const sessionId = getSessionIdFromRequest(req, sessionSecret);
      const session = sessionId ? await db.getAdminSession(sessionId) : null;
      return res.status(200).json({ authenticated: Boolean(session) });
    }

    // Admin Auth Guard
    if (url.pathname.startsWith("/api/admin/")) {
      const sessionId = getSessionIdFromRequest(req, sessionSecret);
      const session = sessionId ? await db.getAdminSession(sessionId) : null;
      if (!session) return res.status(401).json({ error: "Unauthorized." });
    }

    if (url.pathname === "/api/admin/archetype-groups" && req.method === "GET") {
      return res.status(200).json(await attachGroupImages(db, await db.listArchetypeGroups()));
    }

    if (url.pathname === "/api/admin/archetype-groups" && req.method === "POST") {
      const body = validateArchetypeInput(req.body);
      const jobId = await db.createReclassificationJob();
      try {
        await db.createArchetypeGroup(body);
        await db.reclassifyAllCompletedDuels();
        await db.finishReclassificationJob(jobId, "completed", JSON.stringify({ scope: "all_completed_duels" }), null);
        return res.status(200).json({ ok: true });
      } catch (error) {
        await db.finishReclassificationJob(jobId, "failed", null, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }

    if (url.pathname.startsWith("/api/admin/archetype-groups/") && req.method === "PUT") {
      const groupId = Number(url.pathname.replace("/api/admin/archetype-groups/", ""));
      if (!Number.isFinite(groupId)) return res.status(404).json({ error: "Group not found." });
      
      const body = validateArchetypeInput(req.body);
      const jobId = await db.createReclassificationJob();
      try {
        await db.updateArchetypeGroup(groupId, body);
        await db.reclassifyAllCompletedDuels();
        await db.finishReclassificationJob(jobId, "completed", JSON.stringify({ scope: "all_completed_duels" }), null);
        return res.status(200).json({ ok: true });
      } catch (error) {
        await db.finishReclassificationJob(jobId, "failed", null, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }

    if (url.pathname.startsWith("/api/admin/archetype-groups/") && req.method === "DELETE") {
      const groupId = Number(url.pathname.replace("/api/admin/archetype-groups/", ""));
      if (!Number.isFinite(groupId)) return res.status(404).json({ error: "Group not found." });
      
      const jobId = await db.createReclassificationJob();
      try {
        await db.deleteArchetypeGroup(groupId);
        await db.reclassifyAllCompletedDuels();
        await db.finishReclassificationJob(jobId, "completed", JSON.stringify({ scope: "all_completed_duels" }), null);
        return res.status(200).json({ ok: true });
      } catch (error) {
        await db.finishReclassificationJob(jobId, "failed", null, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }

    if (url.pathname === "/api/admin/cards" && req.method === "GET") {
      const cards = await db.searchCards(url.searchParams.get("q") ?? "");
      return res.status(200).json(
        cards.map((card) => {
          const idToUse = card.passcode && card.passcode > 0 ? card.passcode : card.cardId;
          return {
            ...card,
            imagePath: `https://images.ygoprodeck.com/images/cards/${idToUse}.jpg`,
            imageCroppedPath: `https://images.ygoprodeck.com/images/cards_cropped/${idToUse}.jpg`,
          };
        })
      );
    }

    if (url.pathname === "/api/admin/reclassification-jobs/latest" && req.method === "GET") {
      return res.status(200).json(await db.getLatestReclassificationJob());
    }

    if (url.pathname === "/api/admin/workers" && req.method === "GET") {
      // Stubbed out for Vercel deployment. Scraper workers run locally via SQLite, not in Vercel.
      return res.status(200).json([]);
    }

    if (url.pathname === "/health" && req.method === "GET") {
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: "Not found." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
