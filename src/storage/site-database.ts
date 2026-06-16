import pkg from 'pg';
const { Pool } = pkg;
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { DuelPacketRow } from "./database.js";

export type ReplayPlayerArchetypeMatch = {
  groupId: number;
  name: string;
  coverCardName: string | null;
  matchedUniqueCount: number;
  matchedCards: string[];
};

export type ReplayPlayerListItem = {
  username: string;
  rating: number | null;
  won: boolean;
  archetypes: ReplayPlayerArchetypeMatch[];
};

export type ReplayListItem = {
  duelId: number;
  winner: string | null;
  loser: string | null;
  finalScore: string | null;
  gamesPlayed: number;
  plays: number;
  durationSeconds: number;
  replayUrl: string | null;
  completedAt: string | null;
  players: ReplayPlayerListItem[];
};

export type ReplayListFilters = {
  q?: string;
  player?: string;
  archetypes?: string[];
  cards?: string[];
  minRating?: number;
  maxRating?: number;
  sort?: "newest" | "oldest" | "plays_desc" | "duration_desc" | "rating_desc";
  page?: number;
  pageSize?: number;
};

export type ReplayListResult = {
  items: ReplayListItem[];
  total: number;
  page: number;
  pageSize: number;
  filterMetadata?: Array<{
    name: string;
    kind: string;
    imageCroppedPath: string | null;
  }>;
};

export type ReplayGameRow = {
  gameNumber: number;
  scoreAtStart: string;
  startingPlayer: string | null;
  winner: string | null;
  plays: number;
};

export type ReplayActionRow = {
  sequence: number;
  play: string;
  username: string | null;
  seconds: number | null;
  cardName: string | null;
  message: string | null;
  score: string | null;
};

export type ReplayPlayerDetail = {
  username: string;
  rating: number | null;
  won: boolean;
  plays: number;
  uniqueCardCount: number;
  uniqueCards: Array<{ name: string; detail: any }>;
  archetypes: ReplayPlayerArchetypeMatch[];
};

export type ReplayDetail = {
  duelId: number;
  winner: string | null;
  loser: string | null;
  finalScore: string | null;
  gamesPlayed: number;
  plays: number;
  durationSeconds: number;
  replayUrl: string | null;
  players: ReplayPlayerDetail[];
  games: ReplayGameRow[];
  actions: ReplayActionRow[];
};

export type ArchetypeGroup = {
  id: number;
  name: string;
  threshold: number;
  enabled: boolean;
  coverCardName: string | null;
  cards: string[];
  matchCount: number;
  updatedAt: string;
  isTrending: boolean;
};

export type HighlightedArchetype = {
  id: number;
  name: string;
  coverCardName: string | null;
  matchCount: number;
};

export type ArchetypeGroupInput = {
  name: string;
  threshold: number;
  enabled: boolean;
  isTrending: boolean;
  coverCardName: string | null;
  cards: string[];
};

export type CardSearchResult = {
  cardId: number;
  passcode?: number;
  name: string;
};

export type ReclassificationJob = {
  id: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  summaryJson: string | null;
  errorText: string | null;
};

const ACTION_FEED_IGNORED = new Set([
  "Add watcher",
  "Stop viewing",
  "View deck",
  "View GY",
  "View GY 2",
  "View ED",
  "View Banished",
  "Show hand",
  "Typing",
  "Thinking",
  "Good",
  "Stop good",
  "Shuffle deck",
  "Shuffle hand",
]);

export class SiteDatabase {
  private readonly pool: pkg.Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is missing.");
    }
    this.pool = new pkg.Pool({ connectionString });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS scraper_accounts (
        username TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_status TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scraper_runs (
        id SERIAL PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_sessions (
        id SERIAL PRIMARY KEY,
        run_id INTEGER NOT NULL,
        account_username TEXT NOT NULL,
        state TEXT NOT NULL,
        current_duel_id INTEGER,
        last_error TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scraper_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cards_catalog (
        card_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        treated_as TEXT,
        card_type TEXT,
        attribute TEXT,
        type_line TEXT,
        raw_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS duels (
        duel_id INTEGER PRIMARY KEY,
        assigned_account TEXT NOT NULL,
        status TEXT NOT NULL,
        winner TEXT,
        loser TEXT,
        final_score TEXT,
        games_played INTEGER NOT NULL DEFAULT 0,
        replay_url TEXT,
        raw_log_path TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS duel_summaries (
        duel_id INTEGER PRIMARY KEY,
        winner TEXT,
        loser TEXT,
        final_score TEXT,
        games_played INTEGER NOT NULL,
        turns_observed INTEGER NOT NULL,
        total_packets INTEGER NOT NULL,
        real_plays INTEGER NOT NULL,
        probable_archetypes_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS duel_games (
        duel_id INTEGER NOT NULL,
        game_number INTEGER NOT NULL,
        score_at_start TEXT NOT NULL,
        starting_player TEXT,
        winner TEXT,
        loser TEXT,
        ended_match INTEGER NOT NULL,
        total_packets INTEGER NOT NULL,
        real_plays INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (duel_id, game_number)
      );

      CREATE TABLE IF NOT EXISTS duel_player_summaries (
        duel_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        won INTEGER NOT NULL,
        probable_archetype TEXT,
        unique_cards_count INTEGER NOT NULL,
        real_plays INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (duel_id, username)
      );

      CREATE TABLE IF NOT EXISTS duel_seen_cards (
        duel_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        card_name TEXT NOT NULL,
        total_count INTEGER NOT NULL,
        actions_json TEXT NOT NULL,
        PRIMARY KEY (duel_id, username, card_name)
      );

      CREATE TABLE IF NOT EXISTS duel_play_packets (
        duel_id INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        play TEXT NOT NULL,
        username TEXT,
        seconds INTEGER,
        over_flag INTEGER NOT NULL DEFAULT 0,
        packet_json TEXT NOT NULL,
        PRIMARY KEY (duel_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS duel_site_data (
        duel_id INTEGER PRIMARY KEY,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        average_rating INTEGER,
        classified_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS duel_player_site_data (
        duel_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        rating INTEGER,
        PRIMARY KEY (duel_id, username)
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        session_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS archetype_groups (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        threshold INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        cover_card_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_trending INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS archetype_group_cards (
        group_id INTEGER NOT NULL,
        card_name TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (group_id, card_name),
        FOREIGN KEY (group_id) REFERENCES archetype_groups(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS duel_player_archetype_matches (
        duel_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        matched_unique_count INTEGER NOT NULL,
        matched_cards_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (duel_id, username, group_id),
        FOREIGN KEY (group_id) REFERENCES archetype_groups(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS reclassification_jobs (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        summary_json TEXT,
        error_text TEXT
      );

      SELECT setval('scraper_runs_id_seq', COALESCE((SELECT MAX(id) FROM scraper_runs), 1), true);
      SELECT setval('worker_sessions_id_seq', COALESCE((SELECT MAX(id) FROM worker_sessions), 1), true);
      SELECT setval('archetype_groups_id_seq', COALESCE((SELECT MAX(id) FROM archetype_groups), 1), true);
      SELECT setval('reclassification_jobs_id_seq', COALESCE((SELECT MAX(id) FROM reclassification_jobs), 1), true);
    `);

    // Postgres 9.6+ supports ADD COLUMN IF NOT EXISTS
    await this.pool.query(`
      ALTER TABLE archetype_groups ADD COLUMN IF NOT EXISTS is_trending INTEGER NOT NULL DEFAULT 0;
    `);
  }

  async createAdminSession(sessionId: string, expiresAt: string) {
    const now = new Date().toISOString();
    await this.pool.query(`
        INSERT INTO admin_sessions (session_id, created_at, expires_at)
        VALUES ($1, $2, $3)
      `, [sessionId, now, expiresAt]);
  }

  async getAdminSession(sessionId: string) {
    const res = await this.pool.query(`
        SELECT session_id, created_at, expires_at
        FROM admin_sessions
        WHERE session_id = $1 AND expires_at > $2
      `, [sessionId, new Date().toISOString()]);
    return res.rows[0] as { session_id: string; created_at: string; expires_at: string } | undefined;
  }

  async deleteAdminSession(sessionId: string) {
    await this.pool.query(`DELETE FROM admin_sessions WHERE session_id = $1`, [sessionId]);
  }

  async clearExpiredAdminSessions() {
    await this.pool.query(`DELETE FROM admin_sessions WHERE expires_at <= $1`, [new Date().toISOString()]);
  }

  async ensureReplayDerivedData() {
    const res = await this.pool.query(`
        SELECT d.duel_id, d.started_at, d.completed_at
        FROM duels d
        LEFT JOIN duel_site_data s ON s.duel_id = d.duel_id
        WHERE d.status = 'completed' AND (s.duel_id IS NULL OR s.updated_at < d.updated_at)
      `);
    const rows = res.rows as Array<{ duel_id: number; started_at: string | null; completed_at: string | null }>;

    if (rows.length === 0) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of rows) {
        const packets = await this.getReplayPackets(row.duel_id);
        const ratings = derivePlayerRatings(packets);
        const ratingValues = Array.from(ratings.values()).filter((value): value is number => typeof value === "number");
        const averageRating =
          ratingValues.length > 0
            ? Math.round(ratingValues.reduce((sum, value) => sum + value, 0) / ratingValues.length)
            : null;
        const durationSeconds = computeDurationSeconds(row.started_at, row.completed_at);
        const now = new Date().toISOString();

        await client.query(`
          INSERT INTO duel_site_data (duel_id, duration_seconds, average_rating, classified_at, updated_at)
          VALUES ($1, $2, $3, COALESCE((SELECT classified_at FROM duel_site_data WHERE duel_id = $4), NULL), $5)
          ON CONFLICT(duel_id) DO UPDATE SET
            duration_seconds = EXCLUDED.duration_seconds,
            average_rating = EXCLUDED.average_rating,
            updated_at = EXCLUDED.updated_at
        `, [row.duel_id, durationSeconds, averageRating, row.duel_id, now]);

        await client.query(`DELETE FROM duel_player_site_data WHERE duel_id = $1`, [row.duel_id]);
        
        for (const [username, rating] of ratings.entries()) {
          await client.query(`
            INSERT INTO duel_player_site_data (duel_id, username, rating)
            VALUES ($1, $2, $3)
          `, [row.duel_id, username, rating]);
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async ensureReplayClassificationCurrent() {
    await this.ensureReplayDerivedData();

    const maxGroupUpdatedAtRes = await this.pool.query(`SELECT MAX(updated_at) AS updated_at FROM archetype_groups WHERE enabled = 1`);
    const thresholdTimestamp = maxGroupUpdatedAtRes.rows[0]?.updated_at;
    if (!thresholdTimestamp) {
      return;
    }

    const staleRowsRes = await this.pool.query(`
        SELECT d.duel_id
        FROM duels d
        LEFT JOIN duel_site_data s ON s.duel_id = d.duel_id
        WHERE d.status = 'completed' AND (s.classified_at IS NULL OR s.classified_at < $1)
      `, [thresholdTimestamp]);

    if (staleRowsRes.rows.length === 0) {
      return;
    }

    await this.reclassifyDuels(staleRowsRes.rows.map((row) => row.duel_id));
  }

  async createReclassificationJob() {
    const now = new Date().toISOString();
    const res = await this.pool.query(`INSERT INTO reclassification_jobs (status, started_at) VALUES ('running', $1) RETURNING id`, [now]);
    return res.rows[0].id;
  }

  async finishReclassificationJob(jobId: number, status: "completed" | "failed", summaryJson: string | null, errorText: string | null) {
    await this.pool.query(`
        UPDATE reclassification_jobs
        SET status = $1, completed_at = $2, summary_json = $3, error_text = $4
        WHERE id = $5
      `, [status, new Date().toISOString(), summaryJson, errorText, jobId]);
  }

  async getLatestReclassificationJob(): Promise<ReclassificationJob | null> {
    const res = await this.pool.query(`
        SELECT id, status, started_at, completed_at, summary_json, error_text
        FROM reclassification_jobs
        ORDER BY id DESC
        LIMIT 1
      `);
    const row = res.rows[0];

    if (!row) {
      return null;
    }

    return {
      id: Number(row.id),
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      summaryJson: row.summary_json,
      errorText: row.error_text,
    };
  }

  async reclassifyAllCompletedDuels() {
    const res = await this.pool.query(`SELECT duel_id FROM duels WHERE status = 'completed'`);
    await this.reclassifyDuels(res.rows.map((row) => row.duel_id));
  }

  async reclassifyDuels(duelIds: number[]) {
    const uniqueDuelIds = Array.from(new Set(duelIds)).filter((value) => Number.isFinite(value));
    const groups = await this.getEnabledArchetypeGroupsWithCards();
    const now = new Date().toISOString();

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const duelId of uniqueDuelIds) {
        await client.query(`DELETE FROM duel_player_archetype_matches WHERE duel_id = $1`, [duelId]);
        const cardsByPlayer = await this.getUniqueCardsByPlayer(duelId);
        for (const [username, uniqueCards] of Object.entries(cardsByPlayer)) {
          const uniqueCardSet = new Set(uniqueCards);
          for (const group of groups) {
            const matchedCards = group.cards.filter((card) => uniqueCardSet.has(card));
            if (matchedCards.length >= group.threshold) {
              await client.query(`
                INSERT INTO duel_player_archetype_matches (
                  duel_id, username, group_id, matched_unique_count, matched_cards_json, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6)
              `, [duelId, username, group.id, matchedCards.length, JSON.stringify(matchedCards), now]);
            }
          }
        }
        await client.query(`
          INSERT INTO duel_site_data (duel_id, duration_seconds, average_rating, classified_at, updated_at)
          VALUES (
            $1,
            COALESCE((SELECT duration_seconds FROM duel_site_data WHERE duel_id = $2), 0),
            (SELECT average_rating FROM duel_site_data WHERE duel_id = $3),
            $4,
            $5
          )
          ON CONFLICT(duel_id) DO UPDATE SET classified_at = EXCLUDED.classified_at, updated_at = EXCLUDED.updated_at
        `, [duelId, duelId, duelId, now, now]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listReplayPage(filters: ReplayListFilters): Promise<ReplayListResult> {
    await this.ensureReplayClassificationCurrent();

    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 20));
    const offset = (page - 1) * pageSize;
    const params: Array<string | number> = [];
    const where = this.buildReplayWhere(filters, params);
    const orderBy = getReplayOrderBy(filters.sort);

    const countRes = await this.pool.query(`SELECT COUNT(*) AS total FROM duels d ${where}`, params);
    const countRow = countRes.rows[0];
    
    const rowsRes = await this.pool.query(`
        SELECT
          d.duel_id,
          d.winner,
          d.loser,
          d.final_score,
          d.games_played,
          d.replay_url,
          d.completed_at,
          s.real_plays,
          sd.duration_seconds
        FROM duels d
        INNER JOIN duel_summaries s ON s.duel_id = d.duel_id
        LEFT JOIN duel_site_data sd ON sd.duel_id = d.duel_id
        ${where}
        ORDER BY ${orderBy}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, pageSize, offset]);

    const duelIds = rowsRes.rows.map((row) => Number(row.duel_id));
    const playersByDuel = await this.getReplayPlayersForDuels(duelIds);

    return {
      items: rowsRes.rows.map((row) => ({
        duelId: Number(row.duel_id),
        winner: row.winner,
        loser: row.loser,
        finalScore: row.final_score,
        gamesPlayed: Number(row.games_played),
        plays: Number(row.real_plays),
        durationSeconds: Number(row.duration_seconds ?? 0),
        replayUrl: row.replay_url,
        completedAt: row.completed_at,
        players: playersByDuel.get(Number(row.duel_id)) ?? [],
      })),
      total: Number(countRow?.total ?? 0),
      page,
      pageSize,
    };
  }

  async getReplayDetail(duelId: number): Promise<ReplayDetail | null> {
    await this.ensureReplayClassificationCurrent();

    const res = await this.pool.query(`
        SELECT
          d.duel_id,
          d.winner,
          d.loser,
          d.final_score,
          d.games_played,
          d.replay_url,
          s.real_plays,
          sd.duration_seconds
        FROM duels d
        INNER JOIN duel_summaries s ON s.duel_id = d.duel_id
        LEFT JOIN duel_site_data sd ON sd.duel_id = d.duel_id
        WHERE d.duel_id = $1 AND d.status = 'completed'
      `, [duelId]);

    const row = res.rows[0];
    if (!row) {
      return null;
    }

    const playersByDuel = await this.getReplayPlayersForDuels([duelId]);
    const players = playersByDuel.get(duelId) ?? [];
    const uniqueCardsByPlayer = await this.getUniqueCardsByPlayer(duelId);
    
    const allUniqueCardNames = new Set<string>();
    for (const cards of Object.values(uniqueCardsByPlayer)) {
      for (const card of cards) {
        allUniqueCardNames.add(card);
      }
    }

    const cardDetailsMap = new Map<string, any>();
    if (allUniqueCardNames.size > 0) {
      const names = Array.from(allUniqueCardNames);
      const cardsRes = await this.pool.query(`
        SELECT name, raw_json 
        FROM cards_catalog 
        WHERE name = ANY($1::text[])
      `, [names]);
      for (const cardRow of cardsRes.rows) {
        try {
          cardDetailsMap.set(cardRow.name, JSON.parse(cardRow.raw_json));
        } catch (e) {
          // ignore parsing errors
        }
      }
    }

    const playerDetails: ReplayPlayerDetail[] = [];
    for (const player of players) {
      playerDetails.push({
        username: player.username,
        rating: player.rating,
        won: player.won,
        plays: await this.getPlayerRealPlays(duelId, player.username),
        uniqueCardCount: uniqueCardsByPlayer[player.username]?.length ?? 0,
        uniqueCards: (uniqueCardsByPlayer[player.username] ?? []).map(name => ({
          name,
          detail: cardDetailsMap.get(name) ?? null,
        })),
        archetypes: player.archetypes,
      });
    }

    const gamesRes = await this.pool.query(`
        SELECT game_number, score_at_start, starting_player, winner, real_plays
        FROM duel_games
        WHERE duel_id = $1
        ORDER BY game_number ASC
      `, [duelId]);

    const packets = await this.getReplayPackets(duelId);
    const actions = packets
      .map((packet) => buildActionRow(packet))
      .filter((row): row is ReplayActionRow => row !== null);

    return {
      duelId,
      winner: row.winner,
      loser: row.loser,
      finalScore: row.final_score,
      gamesPlayed: Number(row.games_played),
      plays: Number(row.real_plays),
      durationSeconds: Number(row.duration_seconds ?? 0),
      replayUrl: row.replay_url,
      players: playerDetails,
      games: gamesRes.rows.map((game) => ({
        gameNumber: Number(game.game_number),
        scoreAtStart: game.score_at_start,
        startingPlayer: game.starting_player,
        winner: game.winner,
        plays: Number(game.real_plays),
      })),
      actions,
    };
  }

  async listArchetypeGroups(): Promise<ArchetypeGroup[]> {
    const groupsRes = await this.pool.query(`
        SELECT g.id, g.name, g.threshold, g.enabled, g.cover_card_name, g.updated_at
        FROM archetype_groups g
        ORDER BY g.name ASC
      `);

    const cardsRes = await this.pool.query(`
        SELECT group_id, card_name, sort_order
        FROM archetype_group_cards
        ORDER BY group_id ASC, sort_order ASC, card_name ASC
      `);
      
    const cardsByGroup = new Map<number, string[]>();
    for (const row of cardsRes.rows) {
      const list = cardsByGroup.get(Number(row.group_id)) ?? [];
      list.push(row.card_name);
      cardsByGroup.set(Number(row.group_id), list);
    }

    const matchCountsRes = await this.pool.query(`
        SELECT group_id, COUNT(*) AS match_count
        FROM duel_player_archetype_matches
        GROUP BY group_id
      `);
      
    const matchCountByGroup = new Map<number, number>();
    for (const row of matchCountsRes.rows) {
      matchCountByGroup.set(Number(row.group_id), Number(row.match_count));
    }

    return groupsRes.rows.map((group) => ({
      id: Number(group.id),
      name: group.name,
      threshold: Number(group.threshold),
      enabled: group.enabled === 1,
      isTrending: group.is_trending === 1,
      coverCardName: group.cover_card_name,
      cards: cardsByGroup.get(Number(group.id)) ?? [],
      matchCount: matchCountByGroup.get(Number(group.id)) ?? 0,
      updatedAt: group.updated_at,
    }));
  }

  async listHighlightedArchetypes(limit = 8): Promise<HighlightedArchetype[]> {
    const res = await this.pool.query(`
        SELECT
          g.id,
          g.name,
          g.cover_card_name,
          COUNT(m.group_id) AS match_count
        FROM archetype_groups g
        LEFT JOIN duel_player_archetype_matches m ON m.group_id = g.id
        WHERE g.enabled = 1 AND g.is_trending = 1
        GROUP BY g.id, g.name, g.cover_card_name
        ORDER BY match_count DESC, g.name ASC
        LIMIT $1
      `, [limit]);

    return res.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      coverCardName: row.cover_card_name,
      matchCount: Number(row.match_count ?? 0),
    }));
  }

  async createArchetypeGroup(input: ArchetypeGroupInput) {
    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(`
          INSERT INTO archetype_groups (name, threshold, enabled, cover_card_name, created_at, updated_at, is_trending)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `, [input.name, input.threshold, input.enabled ? 1 : 0, input.coverCardName, now, now, input.isTrending ? 1 : 0]);
      const groupId = res.rows[0].id;
      await this.replaceGroupCards(groupId, input.cards, client);
      await client.query("COMMIT");
      return groupId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateArchetypeGroup(groupId: number, input: ArchetypeGroupInput) {
    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
          UPDATE archetype_groups
          SET name = $1, threshold = $2, enabled = $3, cover_card_name = $4, updated_at = $5, is_trending = $7
          WHERE id = $6
        `, [input.name, input.threshold, input.enabled ? 1 : 0, input.coverCardName, now, groupId, input.isTrending ? 1 : 0]);
      await this.replaceGroupCards(groupId, input.cards, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteArchetypeGroup(groupId: number) {
    await this.pool.query(`DELETE FROM archetype_groups WHERE id = $1`, [groupId]);
  }

  async searchCards(query: string, limit = 20): Promise<CardSearchResult[]> {
    const q = query.trim();
    if (!q) {
      return [];
    }

    const res = await this.pool.query(`
        SELECT MIN(card_id) AS card_id, name, MIN(CAST(raw_json::json->>'s' AS INTEGER)) AS passcode
        FROM cards_catalog
        WHERE name ILIKE $1
        GROUP BY name
        ORDER BY
          CASE WHEN name ILIKE $2 THEN 0 ELSE 1 END,
          LENGTH(name) ASC,
          name ASC
        LIMIT $3
      `, [`%${q}%`, `${q}%`, limit]);

    return res.rows.map((row) => ({
      cardId: Number(row.card_id),
      passcode: Number(row.passcode),
      name: row.name,
    }));
  }

  async getCardImagePaths(names: string[]) {
    const uniqueNames = Array.from(new Set(names)).filter(Boolean);
    const paths = new Map<string, string>();
    const croppedPaths = new Map<string, string>();

    if (uniqueNames.length === 0) {
      return [paths, croppedPaths] as const;
    }

    const res = await this.pool.query(`
      SELECT name, MIN(CAST(raw_json::json->>'s' AS INTEGER)) AS passcode
      FROM cards_catalog
      WHERE name = ANY($1::text[])
      GROUP BY name
    `, [uniqueNames]);

    for (const row of res.rows) {
      if (row.passcode && Number(row.passcode) > 0) {
        paths.set(row.name, `https://images.ygoprodeck.com/images/cards/${row.passcode}.jpg`);
        croppedPaths.set(row.name, `https://images.ygoprodeck.com/images/cards_cropped/${row.passcode}.jpg`);
      }
    }

    return [paths, croppedPaths] as const;
  }

  async searchPlayers(query: string, limit = 10): Promise<string[]> {
    const q = query.trim();
    if (!q) {
      return [];
    }

    const res = await this.pool.query(`
        SELECT username
        FROM (
          SELECT DISTINCT username FROM duel_player_summaries
        ) AS unique_players
        WHERE username ILIKE $1
        ORDER BY CASE WHEN username ILIKE $2 THEN 0 ELSE 1 END, username ASC
        LIMIT $3
      `, [`%${q}%`, `${q}%`, limit]);

    return res.rows.map((row) => row.username);
  }

  async searchArchetypes(query: string, limit = 10): Promise<string[]> {
    const q = query.trim();
    if (!q) {
      return [];
    }

    const res = await this.pool.query(`
        SELECT name
        FROM archetype_groups
        WHERE name ILIKE $1
        ORDER BY CASE WHEN name ILIKE $2 THEN 0 ELSE 1 END, name ASC
        LIMIT $3
      `, [`%${q}%`, `${q}%`, limit]);

    return res.rows.map((row) => row.name);
  }

  async close() {
    await this.pool.end();
  }

  private buildReplayWhere(filters: ReplayListFilters, params: Array<string | number>) {
    const where = ["WHERE d.status = 'completed'"];

    const addParam = (val: string | number) => {
      params.push(val);
      return `$${params.length}`;
    };

    if (filters.player?.trim()) {
      where.push(`
        AND EXISTS (
          SELECT 1 FROM duel_player_summaries ps
          WHERE ps.duel_id = d.duel_id AND ps.username ILIKE ${addParam(`%${filters.player.trim()}%`)}
        )
      `);
    }

    if (filters.archetypes && filters.archetypes.length > 0) {
      for (const arch of filters.archetypes) {
        if (arch.trim()) {
          where.push(`
            AND EXISTS (
              SELECT 1
              FROM duel_player_archetype_matches m
              INNER JOIN archetype_groups g ON g.id = m.group_id
              WHERE m.duel_id = d.duel_id AND g.name ILIKE ${addParam(`%${arch.trim()}%`)}
            )
          `);
        }
      }
    }

    if (filters.cards && filters.cards.length > 0) {
      for (const card of filters.cards) {
        if (card.trim()) {
          where.push(`
            AND EXISTS (
              SELECT 1 FROM duel_seen_cards c
              WHERE c.duel_id = d.duel_id AND c.card_name ILIKE ${addParam(`%${card.trim()}%`)}
            )
          `);
        }
      }
    }

    if (typeof filters.minRating === "number") {
      where.push(`
        AND NOT EXISTS (
          SELECT 1 FROM duel_player_site_data pd
          WHERE pd.duel_id = d.duel_id AND (pd.rating IS NULL OR pd.rating < ${addParam(filters.minRating)})
        )
      `);
    }

    if (typeof filters.maxRating === "number") {
      where.push(`
        AND NOT EXISTS (
          SELECT 1 FROM duel_player_site_data pd
          WHERE pd.duel_id = d.duel_id AND (pd.rating IS NULL OR pd.rating > ${addParam(filters.maxRating)})
        )
      `);
    }

    if (filters.q?.trim()) {
      where.push(`
        AND (
          EXISTS (
            SELECT 1 FROM duel_player_summaries ps
            WHERE ps.duel_id = d.duel_id AND ps.username ILIKE ${addParam(`%${filters.q.trim()}%`)}
          )
          OR EXISTS (
            SELECT 1 FROM duel_seen_cards c
            WHERE c.duel_id = d.duel_id AND c.card_name ILIKE ${addParam(`%${filters.q.trim()}%`)}
          )
          OR EXISTS (
            SELECT 1
            FROM duel_player_archetype_matches m
            INNER JOIN archetype_groups g ON g.id = m.group_id
            WHERE m.duel_id = d.duel_id AND g.name ILIKE ${addParam(`%${filters.q.trim()}%`)}
          )
        )
      `);
    }

    return where.join("\n");
  }

  private async getReplayPlayersForDuels(duelIds: number[]) {
    const map = new Map<number, ReplayPlayerListItem[]>();
    if (duelIds.length === 0) {
      return map;
    }

    const res = await this.pool.query(`
        SELECT
          ps.duel_id,
          ps.username,
          ps.won,
          pd.rating,
          m.group_id,
          m.matched_unique_count,
          m.matched_cards_json,
          g.name AS group_name,
          g.cover_card_name
        FROM duel_player_summaries ps
        LEFT JOIN duel_player_site_data pd
          ON pd.duel_id = ps.duel_id AND pd.username = ps.username
        LEFT JOIN duel_player_archetype_matches m
          ON m.duel_id = ps.duel_id AND m.username = ps.username
        LEFT JOIN archetype_groups g
          ON g.id = m.group_id
        WHERE ps.duel_id = ANY($1::int[])
        ORDER BY ps.duel_id ASC, ps.username ASC, g.name ASC
      `, [duelIds]);
      
    const rows = res.rows;

    const keyed = new Map<string, ReplayPlayerListItem>();

    for (const row of rows) {
      const duelId = Number(row.duel_id);
      const key = `${duelId}:::${row.username}`;
      let entry = keyed.get(key);
      if (!entry) {
        entry = {
          username: row.username,
          rating: row.rating === null ? null : Number(row.rating),
          won: row.won === 1,
          archetypes: [],
        };
        keyed.set(key, entry);
        const list = map.get(duelId) ?? [];
        list.push(entry);
        map.set(duelId, list);
      }

      if (row.group_id !== null && row.group_name) {
        entry.archetypes.push({
          groupId: Number(row.group_id),
          name: row.group_name,
          coverCardName: row.cover_card_name,
          matchedUniqueCount: Number(row.matched_unique_count ?? 0),
          matchedCards: row.matched_cards_json ? (JSON.parse(row.matched_cards_json) as string[]) : [],
        });
      }
    }

    return map;
  }

  private async getPlayerRealPlays(duelId: number, username: string) {
    const res = await this.pool.query(`
        SELECT real_plays
        FROM duel_player_summaries
        WHERE duel_id = $1 AND username = $2
      `, [duelId, username]);
    return Number(res.rows[0]?.real_plays ?? 0);
  }

  private async getUniqueCardsByPlayer(duelId: number) {
    const res = await this.pool.query(`
        SELECT username, card_name, MAX(total_count) AS total_count
        FROM duel_seen_cards
        WHERE duel_id = $1
        GROUP BY username, card_name
        ORDER BY username ASC, total_count DESC, card_name ASC
      `, [duelId]);

    const output: Record<string, string[]> = {};
    for (const row of res.rows) {
      const list = output[row.username] ?? [];
      list.push(row.card_name);
      output[row.username] = list;
    }
    return output;
  }

  private async getReplayPackets(duelId: number) {
    const res = await this.pool.query(`
        SELECT sequence, play, username, seconds, over_flag, packet_json
        FROM duel_play_packets
        WHERE duel_id = $1
        ORDER BY sequence ASC
      `, [duelId]);
    return res.rows;
  }

  private async getEnabledArchetypeGroupsWithCards() {
    const groupsRes = await this.pool.query(`
        SELECT id, name, threshold, cover_card_name
        FROM archetype_groups
        WHERE enabled = 1
        ORDER BY name ASC
      `);

    const groupCardsRes = await this.pool.query(`
        SELECT group_id, card_name, sort_order
        FROM archetype_group_cards
        ORDER BY group_id ASC, sort_order ASC, card_name ASC
      `);

    const cardsByGroup = new Map<number, string[]>();
    for (const row of groupCardsRes.rows) {
      const list = cardsByGroup.get(Number(row.group_id)) ?? [];
      list.push(row.card_name);
      cardsByGroup.set(Number(row.group_id), list);
    }

    return groupsRes.rows.map((group) => ({
      id: Number(group.id),
      name: group.name,
      threshold: Number(group.threshold),
      coverCardName: group.cover_card_name,
      cards: cardsByGroup.get(Number(group.id)) ?? [],
    }));
  }

  private async replaceGroupCards(groupId: number, cards: string[], client: pkg.PoolClient) {
    const normalized = Array.from(new Set(cards.map((card) => card.trim()).filter(Boolean)));
    await client.query(`DELETE FROM archetype_group_cards WHERE group_id = $1`, [groupId]);
    
    // Postgres supports multiple row inserts if we want, but doing them iteratively is fine.
    // Or we could build a query string for multiple VALUES. 
    for (let index = 0; index < normalized.length; index++) {
      await client.query(`
        INSERT INTO archetype_group_cards (group_id, card_name, sort_order)
        VALUES ($1, $2, $3)
      `, [groupId, normalized[index], index]);
    }
  }
}

function derivePlayerRatings(
  packets: Array<{ packet_json: string } | { packetJson: string }>,
) {
  let player1Name: string | null = null;
  let player2Name: string | null = null;
  const ratings = new Map<string, number | null>();

  for (const row of packets) {
    const raw = "packet_json" in row ? row.packet_json : row.packetJson;
    let packet: Record<string, unknown>;
    try {
      packet = JSON.parse(raw) as Record<string, unknown>;
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
      ratings.set(player1Name, player1Rating);
    }
    if (typeof player2Rating === "number") {
      ratings.set(player2Name, player2Rating);
    }
  }

  return ratings;
}

function computeDurationSeconds(startedAt: string | null, completedAt: string | null) {
  if (!startedAt || !completedAt) {
    return 0;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return 0;
  }
  return Math.round((end - start) / 1000);
}

function getReplayOrderBy(sort: ReplayListFilters["sort"]) {
  switch (sort) {
    case "oldest":
      return "d.completed_at ASC, d.duel_id ASC";
    case "plays_desc":
      return "s.real_plays DESC, d.completed_at DESC";
    case "duration_desc":
      return "sd.duration_seconds DESC, d.completed_at DESC";
    case "rating_desc":
      return "sd.average_rating DESC, d.completed_at DESC";
    case "newest":
    default:
      return "d.completed_at DESC, d.duel_id DESC";
  }
}

function buildActionRow(packet: {
  sequence: number;
  play: string;
  username: string | null;
  seconds: number | null;
  packet_json: string;
}): ReplayActionRow | null {
  if (ACTION_FEED_IGNORED.has(packet.play) || packet.play === "<none>") {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(packet.packet_json) as Record<string, unknown>;
  } catch {
    return null;
  }

  const cardObject = parsed.card;
  const cardName =
    cardObject && typeof cardObject === "object"
      ? typeof (cardObject as { treated_as?: unknown }).treated_as === "string"
        ? ((cardObject as { treated_as: string }).treated_as)
        : typeof (cardObject as { name?: unknown }).name === "string"
          ? ((cardObject as { name: string }).name)
          : null
      : null;

  return {
    sequence: Number(packet.sequence),
    play: packet.play,
    username: packet.username,
    seconds: packet.seconds,
    cardName,
    message: typeof parsed.message === "string" ? parsed.message : null,
    score: typeof parsed.score === "string" ? parsed.score : null,
  };
}
