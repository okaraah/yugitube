import pkg from 'pg';
const { Pool } = pkg;
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { MatchSummary, DuelPacket } from "../analytics/duel-parser.js";
import type { CatalogCardRecord } from "../cards/catalog.js";

export type ScraperAccountConfig = {
  username: string;
  password: string;
};

export type PersistCompletedDuelInput = {
  duelId: number;
  assignedAccount: string;
  rawPackets: DuelPacket[];
  matchSummary: MatchSummary;
  rawLogPath: string;
  replayUrl: string;
  startedAt: string;
  completedAt: string;
  probableArchetypes: Record<string, string | null>;
};

export type PersistFailedDuelAttemptInput = {
  duelId: number;
  assignedAccount: string;
  rawPackets: DuelPacket[];
  rawLogPath: string;
  startedAt: string;
  failedAt: string;
  failureReason: string;
};

export type DuelListItem = {
  duelId: number;
  status: string;
  winner: string | null;
  loser: string | null;
  finalScore: string | null;
  gamesPlayed: number;
  assignedAccount: string;
  replayUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  totalPackets: number | null;
  realPlays: number | null;
  probableArchetypes: Record<string, string | null>;
};

export type DuelDetail = {
  duelId: number;
  status: string;
  winner: string | null;
  loser: string | null;
  finalScore: string | null;
  gamesPlayed: number;
  assignedAccount: string;
  replayUrl: string | null;
  rawLogPath: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  summary: MatchSummary | null;
};

export type DuelSeenCardRow = {
  username: string;
  cardName: string;
  totalCount: number;
  actions: Record<string, number>;
};

export type DuelPacketRow = {
  sequence: number;
  play: string;
  username: string | null;
  seconds: number | null;
  overFlag: boolean;
  packetJson: string;
};

export type DashboardStats = {
  totalDuels: number;
  completedDuels: number;
  failedDuels: number;
  totalPackets: number;
  totalCards: number;
};

export type WorkerSessionRow = {
  accountUsername: string;
  state: string;
  currentDuelId: number | null;
  lastError: string | null;
  updatedAt: string;
};

export type CatalogCardLookup = {
  cardId: number;
  name: string;
};

export class ScraperDatabase {
  private readonly pool: pkg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
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
    `);
  }

  async seedConfig(defaults: Record<string, unknown>) {
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(defaults)) {
      await this.pool.query(`
        INSERT INTO scraper_config (key, value_json, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at
      `, [key, JSON.stringify(value), now]);
    }
  }

  async upsertAccounts(accounts: ScraperAccountConfig[]) {
    const now = new Date().toISOString();
    for (const account of accounts) {
      await this.pool.query(`
        INSERT INTO scraper_accounts (username, enabled, last_status, last_error, updated_at)
        VALUES ($1, 1, 'configured', NULL, $2)
        ON CONFLICT(username) DO UPDATE SET enabled = 1, updated_at = EXCLUDED.updated_at
      `, [account.username, now]);
    }
  }

  async startRun() {
    const now = new Date().toISOString();
    const res = await this.pool.query(`INSERT INTO scraper_runs (started_at, status) VALUES ($1, 'running') RETURNING id`, [now]);
    return res.rows[0].id;
  }

  async finishRun(runId: number, status: string) {
    await this.pool.query(`UPDATE scraper_runs SET status = $1, ended_at = $2 WHERE id = $3`, [
      status,
      new Date().toISOString(),
      runId,
    ]);
  }

  async createWorkerSession(runId: number, username: string) {
    const now = new Date().toISOString();
    const res = await this.pool.query(`
        INSERT INTO worker_sessions (run_id, account_username, state, current_duel_id, last_error, started_at, updated_at)
        VALUES ($1, $2, 'starting', NULL, NULL, $3, $4)
        RETURNING id
      `, [runId, username, now, now]);
    return res.rows[0].id;
  }

  async updateWorkerSession(sessionId: number, state: string, currentDuelId: number | null, lastError: string | null) {
    await this.pool.query(`
        UPDATE worker_sessions
        SET state = $1, current_duel_id = $2, last_error = $3, updated_at = $4
        WHERE id = $5
      `, [state, currentDuelId, lastError, new Date().toISOString(), sessionId]);
  }

  async updateAccountStatus(username: string, status: string, lastError: string | null = null) {
    await this.pool.query(`UPDATE scraper_accounts SET last_status = $1, last_error = $2, updated_at = $3 WHERE username = $4`, [status, lastError, new Date().toISOString(), username]);
  }

  async listActiveWorkers(): Promise<WorkerSessionRow[]> {
    const runRes = await this.pool.query(`SELECT id FROM scraper_runs ORDER BY id DESC LIMIT 1`);
    if (runRes.rowCount === 0) return [];
    
    const res = await this.pool.query(`
      SELECT account_username as "accountUsername", state, current_duel_id as "currentDuelId", last_error as "lastError", updated_at as "updatedAt"
      FROM worker_sessions
      WHERE run_id = $1
    `, [runRes.rows[0].id]);
    return res.rows as WorkerSessionRow[];
  }

  async upsertCardsCatalog(cards: CatalogCardRecord[]) {
    const now = new Date().toISOString();
    for (const card of cards) {
      await this.pool.query(`
        INSERT INTO cards_catalog (card_id, name, treated_as, card_type, attribute, type_line, raw_json, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(card_id) DO UPDATE SET
          name = EXCLUDED.name,
          treated_as = EXCLUDED.treated_as,
          card_type = EXCLUDED.card_type,
          attribute = EXCLUDED.attribute,
          type_line = EXCLUDED.type_line,
          raw_json = EXCLUDED.raw_json,
          updated_at = EXCLUDED.updated_at
      `, [
        card.cardId,
        card.name,
        card.treatedAs,
        card.cardType,
        card.attribute,
        card.typeLine,
        card.rawJson,
        now,
      ]);
    }
  }

  async isDuelCompleted(duelId: number) {
    const res = await this.pool.query(`SELECT status FROM duels WHERE duel_id = $1`, [duelId]);
    return res.rows[0]?.status === "completed";
  }

  async persistCompletedDuel(input: PersistCompletedDuelInput) {
    if (await this.isDuelCompleted(input.duelId)) {
      return false;
    }

    mkdirSync(dirname(input.rawLogPath), { recursive: true });
    writeFileSync(input.rawLogPath, input.rawPackets.map((packet) => JSON.stringify(packet)).join("\n") + "\n", "utf8");

    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      
      await client.query(`DELETE FROM duel_play_packets WHERE duel_id = $1`, [input.duelId]);
      await client.query(`DELETE FROM duel_seen_cards WHERE duel_id = $1`, [input.duelId]);
      await client.query(`DELETE FROM duel_player_summaries WHERE duel_id = $1`, [input.duelId]);
      await client.query(`DELETE FROM duel_games WHERE duel_id = $1`, [input.duelId]);
      await client.query(`DELETE FROM duel_summaries WHERE duel_id = $1`, [input.duelId]);

      await client.query(`
          INSERT INTO duels (
            duel_id, assigned_account, status, winner, loser, final_score, games_played, replay_url,
            raw_log_path, started_at, completed_at, created_at, updated_at
          ) VALUES ($1, $2, 'completed', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT(duel_id) DO UPDATE SET
            assigned_account = EXCLUDED.assigned_account,
            status = EXCLUDED.status,
            winner = EXCLUDED.winner,
            loser = EXCLUDED.loser,
            final_score = EXCLUDED.final_score,
            games_played = EXCLUDED.games_played,
            replay_url = EXCLUDED.replay_url,
            raw_log_path = EXCLUDED.raw_log_path,
            started_at = EXCLUDED.started_at,
            completed_at = EXCLUDED.completed_at,
            updated_at = EXCLUDED.updated_at
        `, [
          input.duelId,
          input.assignedAccount,
          input.matchSummary.winner,
          input.matchSummary.loser,
          input.matchSummary.finalScore,
          input.matchSummary.gamesPlayed,
          input.replayUrl,
          input.rawLogPath,
          input.startedAt,
          input.completedAt,
          now,
          now,
        ]);

      await client.query(`
          INSERT INTO duel_summaries (
            duel_id, winner, loser, final_score, games_played, turns_observed, total_packets, real_plays,
            probable_archetypes_json, summary_json, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          input.duelId,
          input.matchSummary.winner,
          input.matchSummary.loser,
          input.matchSummary.finalScore,
          input.matchSummary.gamesPlayed,
          input.matchSummary.turnsObserved,
          input.matchSummary.totalPackets,
          input.matchSummary.realPlays,
          JSON.stringify(input.probableArchetypes),
          JSON.stringify(input.matchSummary),
          now,
        ]);

      for (const game of input.matchSummary.games) {
        await client.query(`
          INSERT INTO duel_games (
            duel_id, game_number, score_at_start, starting_player, winner, loser, ended_match, total_packets, real_plays, raw_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          input.duelId,
          game.gameNumber,
          game.scoreAtStart,
          game.startingPlayer,
          game.winner,
          game.loser,
          game.endedMatch ? 1 : 0,
          game.totalPackets,
          game.realPlays,
          JSON.stringify(game),
        ]);
      }

      for (const player of input.matchSummary.players) {
        await client.query(`
          INSERT INTO duel_player_summaries (
            duel_id, username, won, probable_archetype, unique_cards_count, real_plays, raw_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          input.duelId,
          player,
          input.matchSummary.winner === player ? 1 : 0,
          input.matchSummary.probableArchetypes[player] ?? null,
          input.matchSummary.uniqueCardsCountByPlayer[player] ?? 0,
          input.matchSummary.perPlayerRealPlays[player] ?? 0,
          JSON.stringify({
            player,
            archetype: input.matchSummary.probableArchetypes[player] ?? null,
            uniqueCards: input.matchSummary.cardsByPlayer[player] ?? [],
            realPlays: input.matchSummary.perPlayerRealPlays[player] ?? 0,
          }),
        ]);
      }

      for (const cardSummary of input.matchSummary.topCards) {
        await client.query(`
          INSERT INTO duel_seen_cards (duel_id, username, card_name, total_count, actions_json)
          VALUES ($1, $2, $3, $4, $5)
        `, [
          input.duelId,
          cardSummary.owner,
          cardSummary.cardName,
          cardSummary.total,
          JSON.stringify(cardSummary.actions),
        ]);
      }

      for (const [index, packet] of input.rawPackets.entries()) {
        await client.query(`
          INSERT INTO duel_play_packets (duel_id, sequence, play, username, seconds, over_flag, packet_json)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          input.duelId,
          index + 1,
          typeof packet.play === "string" ? packet.play : "<none>",
          typeof packet.username === "string" ? packet.username : null,
          typeof packet.seconds === "number" ? packet.seconds : null,
          packet.over === true ? 1 : 0,
          JSON.stringify(packet),
        ]);
      }

      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async persistFailedDuelAttempt(input: PersistFailedDuelAttemptInput) {
    mkdirSync(dirname(input.rawLogPath), { recursive: true });
    writeFileSync(input.rawLogPath, input.rawPackets.map((packet) => JSON.stringify(packet)).join("\n") + (input.rawPackets.length ? "\n" : ""), "utf8");

    const now = new Date().toISOString();
    await this.pool.query(`
        INSERT INTO duels (
          duel_id, assigned_account, status, winner, loser, final_score, games_played, replay_url,
          raw_log_path, started_at, completed_at, created_at, updated_at
        ) VALUES ($1, $2, 'failed', NULL, NULL, NULL, 0, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(duel_id) DO UPDATE SET
          assigned_account = EXCLUDED.assigned_account,
          status = EXCLUDED.status,
          raw_log_path = EXCLUDED.raw_log_path,
          started_at = COALESCE(duels.started_at, EXCLUDED.started_at),
          completed_at = EXCLUDED.completed_at,
          updated_at = EXCLUDED.updated_at
      `, [
        input.duelId,
        input.assignedAccount,
        `https://www.duelingbook.com/replay?id=${input.duelId}`,
        input.rawLogPath,
        input.startedAt,
        input.failedAt,
        now,
        now,
      ]);

    await this.pool.query(`
        INSERT INTO duel_summaries (
          duel_id, winner, loser, final_score, games_played, turns_observed, total_packets, real_plays,
          probable_archetypes_json, summary_json, updated_at
        ) VALUES ($1, NULL, NULL, NULL, 0, 0, $2, 0, '{}', $3, $4)
        ON CONFLICT(duel_id) DO UPDATE SET
          total_packets = EXCLUDED.total_packets,
          summary_json = EXCLUDED.summary_json,
          updated_at = EXCLUDED.updated_at
      `, [
        input.duelId,
        input.rawPackets.length,
        JSON.stringify({
          duelId: input.duelId,
          status: "failed",
          failureReason: input.failureReason,
          rawPacketCount: input.rawPackets.length,
        }),
        now,
      ]);
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const res = await this.pool.query(`
        SELECT
          (SELECT COUNT(*) FROM duels) AS total_duels,
          (SELECT COUNT(*) FROM duels WHERE status = 'completed') AS completed_duels,
          (SELECT COUNT(*) FROM duels WHERE status = 'failed') AS failed_duels,
          (SELECT COUNT(*) FROM duel_play_packets) AS total_packets,
          (SELECT COUNT(*) FROM cards_catalog) AS total_cards
      `);
    const row = res.rows[0] || {};

    return {
      totalDuels: Number(row.total_duels ?? 0),
      completedDuels: Number(row.completed_duels ?? 0),
      failedDuels: Number(row.failed_duels ?? 0),
      totalPackets: Number(row.total_packets ?? 0),
      totalCards: Number(row.total_cards ?? 0),
    };
  }

  async listRecentDuels(limit = 100): Promise<DuelListItem[]> {
    const res = await this.pool.query(`
        SELECT
          d.duel_id,
          d.status,
          d.winner,
          d.loser,
          d.final_score,
          d.games_played,
          d.assigned_account,
          d.replay_url,
          d.started_at,
          d.completed_at,
          d.updated_at,
          s.total_packets,
          s.real_plays,
          s.probable_archetypes_json
        FROM duels d
        LEFT JOIN duel_summaries s ON s.duel_id = d.duel_id
        ORDER BY COALESCE(d.completed_at, d.updated_at) DESC
        LIMIT $1
      `, [limit]);

    return res.rows.map((row) => ({
      duelId: Number(row.duel_id),
      status: row.status,
      winner: row.winner,
      loser: row.loser,
      finalScore: row.final_score,
      gamesPlayed: Number(row.games_played ?? 0),
      assignedAccount: row.assigned_account,
      replayUrl: row.replay_url,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
      totalPackets: row.total_packets === null ? null : Number(row.total_packets),
      realPlays: row.real_plays === null ? null : Number(row.real_plays),
      probableArchetypes: row.probable_archetypes_json ? JSON.parse(row.probable_archetypes_json) : {},
    }));
  }

  async getDuelDetail(duelId: number): Promise<DuelDetail | null> {
    const res = await this.pool.query(`
        SELECT
          d.duel_id,
          d.status,
          d.winner,
          d.loser,
          d.final_score,
          d.games_played,
          d.assigned_account,
          d.replay_url,
          d.raw_log_path,
          d.started_at,
          d.completed_at,
          d.updated_at,
          s.summary_json
        FROM duels d
        LEFT JOIN duel_summaries s ON s.duel_id = d.duel_id
        WHERE d.duel_id = $1
      `, [duelId]);

    const row = res.rows[0];
    if (!row) {
      return null;
    }

    return {
      duelId: Number(row.duel_id),
      status: row.status,
      winner: row.winner,
      loser: row.loser,
      finalScore: row.final_score,
      gamesPlayed: Number(row.games_played ?? 0),
      assignedAccount: row.assigned_account,
      replayUrl: row.replay_url,
      rawLogPath: row.raw_log_path,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      updatedAt: row.updated_at,
      summary: row.summary_json ? (JSON.parse(row.summary_json) as MatchSummary) : null,
    };
  }

  async getDuelSeenCards(duelId: number): Promise<DuelSeenCardRow[]> {
    const res = await this.pool.query(`
        SELECT username, card_name, total_count, actions_json
        FROM duel_seen_cards
        WHERE duel_id = $1
        ORDER BY username ASC, total_count DESC, card_name ASC
      `, [duelId]);

    return res.rows.map((row) => ({
      username: row.username,
      cardName: row.card_name,
      totalCount: Number(row.total_count),
      actions: JSON.parse(row.actions_json) as Record<string, number>,
    }));
  }

  async getDuelPackets(duelId: number): Promise<DuelPacketRow[]> {
    const res = await this.pool.query(`
        SELECT sequence, play, username, seconds, over_flag, packet_json
        FROM duel_play_packets
        WHERE duel_id = $1
        ORDER BY sequence ASC
      `, [duelId]);

    return res.rows.map((row) => ({
      sequence: Number(row.sequence),
      play: row.play,
      username: row.username,
      seconds: row.seconds === null ? null : Number(row.seconds),
      overFlag: row.over_flag === 1,
      packetJson: row.packet_json,
    }));
  }

  async listLatestWorkerSessions(): Promise<WorkerSessionRow[]> {
    const res = await this.pool.query(`
        SELECT ws.account_username, ws.state, ws.current_duel_id, ws.last_error, ws.updated_at
        FROM worker_sessions ws
        INNER JOIN (
          SELECT account_username, MAX(id) AS max_id
          FROM worker_sessions
          GROUP BY account_username
        ) latest ON latest.max_id = ws.id
        ORDER BY ws.account_username ASC
      `);

    return res.rows.map((row) => ({
      accountUsername: row.account_username,
      state: row.state,
      currentDuelId: row.current_duel_id === null ? null : Number(row.current_duel_id),
      lastError: row.last_error,
      updatedAt: row.updated_at,
    }));
  }

  async lookupCardsByNames(names: string[]) {
    const uniqueNames = Array.from(new Set(names)).filter(Boolean);
    if (uniqueNames.length === 0) {
      return new Map<string, CatalogCardLookup>();
    }

    const res = await this.pool.query(`
        SELECT card_id, name
        FROM cards_catalog
        WHERE name = ANY($1::text[])
      `, [uniqueNames]);

    const output = new Map<string, CatalogCardLookup>();
    for (const row of res.rows) {
      output.set(row.name, {
        cardId: Number(row.card_id),
        name: row.name,
      });
    }
    return output;
  }

  async close() {
    await this.pool.end();
  }
}
