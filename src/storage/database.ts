import { DatabaseSync } from "node:sqlite";
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
  private readonly db: DatabaseSync;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scraper_accounts (
        username TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_status TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scraper_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worker_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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

  seedConfig(defaults: Record<string, unknown>) {
    const statement = this.db.prepare(`
      INSERT INTO scraper_config (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);

    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(defaults)) {
      statement.run(key, JSON.stringify(value), now);
    }
  }

  upsertAccounts(accounts: ScraperAccountConfig[]) {
    const statement = this.db.prepare(`
      INSERT INTO scraper_accounts (username, enabled, last_status, last_error, updated_at)
      VALUES (?, 1, 'configured', NULL, ?)
      ON CONFLICT(username) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at
    `);

    const now = new Date().toISOString();
    for (const account of accounts) {
      statement.run(account.username, now);
    }
  }

  startRun() {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO scraper_runs (started_at, status) VALUES (?, 'running')`).run(now);
    return this.getLastInsertId();
  }

  finishRun(runId: number, status: string) {
    this.db.prepare(`UPDATE scraper_runs SET status = ?, ended_at = ? WHERE id = ?`).run(
      status,
      new Date().toISOString(),
      runId,
    );
  }

  createWorkerSession(runId: number, username: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO worker_sessions (run_id, account_username, state, current_duel_id, last_error, started_at, updated_at)
        VALUES (?, ?, 'starting', NULL, NULL, ?, ?)
      `)
      .run(runId, username, now, now);
    return this.getLastInsertId();
  }

  updateWorkerSession(sessionId: number, state: string, currentDuelId: number | null, lastError: string | null) {
    this.db
      .prepare(`
        UPDATE worker_sessions
        SET state = ?, current_duel_id = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(state, currentDuelId, lastError, new Date().toISOString(), sessionId);
  }

  updateAccountStatus(username: string, status: string, lastError: string | null = null) {
    this.db
      .prepare(`UPDATE scraper_accounts SET last_status = ?, last_error = ?, updated_at = ? WHERE username = ?`)
      .run(status, lastError, new Date().toISOString(), username);
  }

  upsertCardsCatalog(cards: CatalogCardRecord[]) {
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO cards_catalog (card_id, name, treated_as, card_type, attribute, type_line, raw_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(card_id) DO UPDATE SET
        name = excluded.name,
        treated_as = excluded.treated_as,
        card_type = excluded.card_type,
        attribute = excluded.attribute,
        type_line = excluded.type_line,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `);

    for (const card of cards) {
      statement.run(
        card.cardId,
        card.name,
        card.treatedAs,
        card.cardType,
        card.attribute,
        card.typeLine,
        card.rawJson,
        now,
      );
    }
  }

  isDuelCompleted(duelId: number) {
    const row = this.db.prepare(`SELECT status FROM duels WHERE duel_id = ?`).get(duelId) as { status?: string } | undefined;
    return row?.status === "completed";
  }

  persistCompletedDuel(input: PersistCompletedDuelInput) {
    if (this.isDuelCompleted(input.duelId)) {
      return false;
    }

    mkdirSync(dirname(input.rawLogPath), { recursive: true });
    writeFileSync(input.rawLogPath, input.rawPackets.map((packet) => JSON.stringify(packet)).join("\n") + "\n", "utf8");

    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM duel_play_packets WHERE duel_id = ?`).run(input.duelId);
      this.db.prepare(`DELETE FROM duel_seen_cards WHERE duel_id = ?`).run(input.duelId);
      this.db.prepare(`DELETE FROM duel_player_summaries WHERE duel_id = ?`).run(input.duelId);
      this.db.prepare(`DELETE FROM duel_games WHERE duel_id = ?`).run(input.duelId);
      this.db.prepare(`DELETE FROM duel_summaries WHERE duel_id = ?`).run(input.duelId);

      this.db
        .prepare(`
          INSERT INTO duels (
            duel_id, assigned_account, status, winner, loser, final_score, games_played, replay_url,
            raw_log_path, started_at, completed_at, created_at, updated_at
          ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(duel_id) DO UPDATE SET
            assigned_account = excluded.assigned_account,
            status = excluded.status,
            winner = excluded.winner,
            loser = excluded.loser,
            final_score = excluded.final_score,
            games_played = excluded.games_played,
            replay_url = excluded.replay_url,
            raw_log_path = excluded.raw_log_path,
            started_at = excluded.started_at,
            completed_at = excluded.completed_at,
            updated_at = excluded.updated_at
        `)
        .run(
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
        );

      this.db
        .prepare(`
          INSERT INTO duel_summaries (
            duel_id, winner, loser, final_score, games_played, turns_observed, total_packets, real_plays,
            probable_archetypes_json, summary_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
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
        );

      const gameStatement = this.db.prepare(`
        INSERT INTO duel_games (
          duel_id, game_number, score_at_start, starting_player, winner, loser, ended_match, total_packets, real_plays, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const game of input.matchSummary.games) {
        gameStatement.run(
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
        );
      }

      const playerStatement = this.db.prepare(`
        INSERT INTO duel_player_summaries (
          duel_id, username, won, probable_archetype, unique_cards_count, real_plays, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const player of input.matchSummary.players) {
        playerStatement.run(
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
        );
      }

      const cardStatement = this.db.prepare(`
        INSERT INTO duel_seen_cards (duel_id, username, card_name, total_count, actions_json)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const cardSummary of input.matchSummary.topCards) {
        cardStatement.run(
          input.duelId,
          cardSummary.owner,
          cardSummary.cardName,
          cardSummary.total,
          JSON.stringify(cardSummary.actions),
        );
      }

      const playStatement = this.db.prepare(`
        INSERT INTO duel_play_packets (duel_id, sequence, play, username, seconds, over_flag, packet_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      input.rawPackets.forEach((packet, index) => {
        playStatement.run(
          input.duelId,
          index + 1,
          typeof packet.play === "string" ? packet.play : "<none>",
          typeof packet.username === "string" ? packet.username : null,
          typeof packet.seconds === "number" ? packet.seconds : null,
          packet.over === true ? 1 : 0,
          JSON.stringify(packet),
        );
      });

      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  persistFailedDuelAttempt(input: PersistFailedDuelAttemptInput) {
    mkdirSync(dirname(input.rawLogPath), { recursive: true });
    writeFileSync(input.rawLogPath, input.rawPackets.map((packet) => JSON.stringify(packet)).join("\n") + (input.rawPackets.length ? "\n" : ""), "utf8");

    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO duels (
          duel_id, assigned_account, status, winner, loser, final_score, games_played, replay_url,
          raw_log_path, started_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, 'failed', NULL, NULL, NULL, 0, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(duel_id) DO UPDATE SET
          assigned_account = excluded.assigned_account,
          status = excluded.status,
          raw_log_path = excluded.raw_log_path,
          started_at = COALESCE(duels.started_at, excluded.started_at),
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `)
      .run(
        input.duelId,
        input.assignedAccount,
        `https://www.duelingbook.com/replay?id=${input.duelId}`,
        input.rawLogPath,
        input.startedAt,
        input.failedAt,
        now,
        now,
      );

    this.db
      .prepare(`
        INSERT INTO duel_summaries (
          duel_id, winner, loser, final_score, games_played, turns_observed, total_packets, real_plays,
          probable_archetypes_json, summary_json, updated_at
        ) VALUES (?, NULL, NULL, NULL, 0, 0, ?, 0, '{}', ?, ?)
        ON CONFLICT(duel_id) DO UPDATE SET
          total_packets = excluded.total_packets,
          summary_json = excluded.summary_json,
          updated_at = excluded.updated_at
      `)
      .run(
        input.duelId,
        input.rawPackets.length,
        JSON.stringify({
          duelId: input.duelId,
          status: "failed",
          failureReason: input.failureReason,
          rawPacketCount: input.rawPackets.length,
        }),
        now,
      );
  }

  getDashboardStats(): DashboardStats {
    const row = this.db
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM duels) AS total_duels,
          (SELECT COUNT(*) FROM duels WHERE status = 'completed') AS completed_duels,
          (SELECT COUNT(*) FROM duels WHERE status = 'failed') AS failed_duels,
          (SELECT COUNT(*) FROM duel_play_packets) AS total_packets,
          (SELECT COUNT(*) FROM cards_catalog) AS total_cards
      `)
      .get() as {
        total_duels: number;
        completed_duels: number;
        failed_duels: number;
        total_packets: number;
        total_cards: number;
      };

    return {
      totalDuels: Number(row.total_duels ?? 0),
      completedDuels: Number(row.completed_duels ?? 0),
      failedDuels: Number(row.failed_duels ?? 0),
      totalPackets: Number(row.total_packets ?? 0),
      totalCards: Number(row.total_cards ?? 0),
    };
  }

  listRecentDuels(limit = 100): DuelListItem[] {
    const rows = this.db
      .prepare(`
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
        LIMIT ?
      `)
      .all(limit) as Array<{
      duel_id: number;
      status: string;
      winner: string | null;
      loser: string | null;
      final_score: string | null;
      games_played: number;
      assigned_account: string;
      replay_url: string | null;
      started_at: string | null;
      completed_at: string | null;
      updated_at: string;
      total_packets: number | null;
      real_plays: number | null;
      probable_archetypes_json: string | null;
    }>;

    return rows.map((row) => ({
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

  getDuelDetail(duelId: number): DuelDetail | null {
    const row = this.db
      .prepare(`
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
        WHERE d.duel_id = ?
      `)
      .get(duelId) as
      | {
          duel_id: number;
          status: string;
          winner: string | null;
          loser: string | null;
          final_score: string | null;
          games_played: number;
          assigned_account: string;
          replay_url: string | null;
          raw_log_path: string | null;
          started_at: string | null;
          completed_at: string | null;
          updated_at: string;
          summary_json: string | null;
        }
      | undefined;

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

  getDuelSeenCards(duelId: number): DuelSeenCardRow[] {
    const rows = this.db
      .prepare(`
        SELECT username, card_name, total_count, actions_json
        FROM duel_seen_cards
        WHERE duel_id = ?
        ORDER BY username ASC, total_count DESC, card_name ASC
      `)
      .all(duelId) as Array<{
      username: string;
      card_name: string;
      total_count: number;
      actions_json: string;
    }>;

    return rows.map((row) => ({
      username: row.username,
      cardName: row.card_name,
      totalCount: Number(row.total_count),
      actions: JSON.parse(row.actions_json) as Record<string, number>,
    }));
  }

  getDuelPackets(duelId: number): DuelPacketRow[] {
    const rows = this.db
      .prepare(`
        SELECT sequence, play, username, seconds, over_flag, packet_json
        FROM duel_play_packets
        WHERE duel_id = ?
        ORDER BY sequence ASC
      `)
      .all(duelId) as Array<{
      sequence: number;
      play: string;
      username: string | null;
      seconds: number | null;
      over_flag: number;
      packet_json: string;
    }>;

    return rows.map((row) => ({
      sequence: Number(row.sequence),
      play: row.play,
      username: row.username,
      seconds: row.seconds === null ? null : Number(row.seconds),
      overFlag: row.over_flag === 1,
      packetJson: row.packet_json,
    }));
  }

  listLatestWorkerSessions(): WorkerSessionRow[] {
    const rows = this.db
      .prepare(`
        SELECT ws.account_username, ws.state, ws.current_duel_id, ws.last_error, ws.updated_at
        FROM worker_sessions ws
        INNER JOIN (
          SELECT account_username, MAX(id) AS max_id
          FROM worker_sessions
          GROUP BY account_username
        ) latest ON latest.max_id = ws.id
        ORDER BY ws.account_username ASC
      `)
      .all() as Array<{
      account_username: string;
      state: string;
      current_duel_id: number | null;
      last_error: string | null;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      accountUsername: row.account_username,
      state: row.state,
      currentDuelId: row.current_duel_id === null ? null : Number(row.current_duel_id),
      lastError: row.last_error,
      updatedAt: row.updated_at,
    }));
  }

  lookupCardsByNames(names: string[]) {
    const uniqueNames = Array.from(new Set(names)).filter(Boolean);
    if (uniqueNames.length === 0) {
      return new Map<string, CatalogCardLookup>();
    }

    const placeholders = uniqueNames.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT card_id, name
        FROM cards_catalog
        WHERE name IN (${placeholders})
      `)
      .all(...uniqueNames) as Array<{
      card_id: number;
      name: string;
    }>;

    const output = new Map<string, CatalogCardLookup>();
    for (const row of rows) {
      output.set(row.name, {
        cardId: Number(row.card_id),
        name: row.name,
      });
    }
    return output;
  }

  close() {
    this.db.close();
  }

  private getLastInsertId() {
    const row = this.db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
    return Number(row.id);
  }
}
