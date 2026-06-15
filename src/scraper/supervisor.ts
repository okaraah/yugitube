import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";

import WebSocket from "ws";

import type { DuelPacket, MatchSummary } from "../analytics/duel-parser.js";
import { parseMatch } from "../analytics/duel-parser.js";
import { syncCardsCatalog } from "../cards/catalog.js";
import { DuelingBookClient } from "../duelingbook/client.js";
import { loadCookieJar, saveCookieJar } from "../duelingbook/session-store.js";
import type { ScraperAccountConfig, ScraperDatabase } from "../storage/database.js";
import { matchesQualifyingFilter, summarizeLobbyDuel, type LobbyDuelSummary, type QualifyingFilter } from "./filter.js";

const WS_URL = "wss://duel.duelingbook.com:8443/";
const HEARTBEAT_INTERVAL_MS = 30_000;
const CARD_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALE_DUEL_COOLDOWN_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_BASE_MS = 5_000;
const RETRY_BACKOFF_MAX_MS = 60_000;
const WS_CONNECT_TIMEOUT_MS = 20_000;

type WorkerState =
  | "starting"
  | "connecting"
  | "idle"
  | "evaluating"
  | "recording"
  | "reconnecting"
  | "stopped";

type LoginPayload = {
  action: string;
  user_id?: number;
  username?: string;
  password?: string;
};

type SupervisorOptions = {
  db: ScraperDatabase;
  accounts: ScraperAccountConfig[];
  filter: QualifyingFilter;
  dbPath: string;
};

export class DuelScraperSupervisor {
  private readonly db: ScraperDatabase;
  private readonly accounts: ScraperAccountConfig[];
  private readonly filter: QualifyingFilter;
  private readonly activeAssignments = new Map<number, string>();
  private readonly cooldownDuels = new Map<number, number>();
  private readonly workers = new Map<string, WatchWorker>();
  private readonly shutdownControllers = new Set<() => Promise<void>>();
  private runId = 0;
  private stopping = false;
  private cardSyncTimer: NodeJS.Timeout | null = null;

  constructor(options: SupervisorOptions) {
    this.db = options.db;
    this.accounts = options.accounts;
    this.filter = options.filter;
  }

  async start() {
    this.db.init();
    this.db.seedConfig({
      qualifying_filter: this.filter,
      watcher_accounts: this.accounts.map((account) => account.username),
    });
    this.db.upsertAccounts(this.accounts);
    this.runId = this.db.startRun();

    await this.syncCards("startup");
    this.cardSyncTimer = setInterval(() => {
      void this.syncCards("interval");
    }, CARD_SYNC_INTERVAL_MS);

    for (const account of this.accounts) {
      const worker = new WatchWorker({
        supervisor: this,
        db: this.db,
        runId: this.runId,
        account,
        filter: this.filter,
      });
      this.workers.set(account.username, worker);
      this.shutdownControllers.add(() => worker.stop());
      void worker.start();
    }

    const shutdown = async (signal: string) => {
      if (this.stopping) {
        return;
      }
      this.stopping = true;
      console.log(`[supervisor] stopping due to ${signal}`);
      if (this.cardSyncTimer) {
        clearInterval(this.cardSyncTimer);
      }

      for (const stopWorker of this.shutdownControllers) {
        await stopWorker();
      }

      this.db.finishRun(this.runId, "stopped");
      this.db.close();
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  }

  tryAssignDuel(workerUsername: string, duel: LobbyDuelSummary) {
    const cooldownUntil = this.cooldownDuels.get(duel.id) ?? 0;
    if (cooldownUntil > Date.now()) {
      return false;
    }

    if (this.activeAssignments.has(duel.id)) {
      return false;
    }

    if (this.db.isDuelCompleted(duel.id)) {
      return false;
    }

    this.activeAssignments.set(duel.id, workerUsername);
    return true;
  }

  releaseDuel(duelId: number, reason: "completed" | "stale" | "failed" | "rejected") {
    this.activeAssignments.delete(duelId);
    if (reason === "stale" || reason === "rejected") {
      this.cooldownDuels.set(duelId, Date.now() + STALE_DUEL_COOLDOWN_MS);
    }
  }

  async persistCompletedDuel(input: {
    duelId: number;
    assignedAccount: string;
    rawPackets: DuelPacket[];
    startedAt: string;
    completedAt: string;
  }) {
    const matchSummary = parseMatch(`duel-${input.duelId}`, input.rawPackets);
    const replayUrl = `https://www.duelingbook.com/replay?id=${input.duelId}`;
    const rawLogPath = resolve(`.runtime/duels/${input.duelId}.ndjson`);
    const persisted = this.db.persistCompletedDuel({
      duelId: input.duelId,
      assignedAccount: input.assignedAccount,
      rawPackets: input.rawPackets,
      matchSummary,
      rawLogPath,
      replayUrl,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      probableArchetypes: matchSummary.probableArchetypes,
    });

    if (persisted) {
      console.log(
        `[supervisor] persisted duel id=${input.duelId} winner=${matchSummary.winner ?? "unknown"} score=${matchSummary.finalScore ?? "unknown"}`,
      );
    } else {
      console.log(`[supervisor] skipped duplicate completed duel id=${input.duelId}`);
    }

    return { persisted, matchSummary };
  }

  private async syncCards(source: "startup" | "interval") {
    try {
      const count = await syncCardsCatalog(this.db);
      console.log(`[cards] ${source} sync complete count=${count}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[cards] ${source} sync failed: ${message}`);
    }
  }
}

type WorkerOptions = {
  supervisor: DuelScraperSupervisor;
  db: ScraperDatabase;
  runId: number;
  account: ScraperAccountConfig;
  filter: QualifyingFilter;
};

class WatchWorker {
  private readonly supervisor: DuelScraperSupervisor;
  private readonly db: ScraperDatabase;
  private readonly runId: number;
  private readonly account: ScraperAccountConfig;
  private readonly filter: QualifyingFilter;
  private readonly cookieFile: string;
  private readonly sessionId: number;
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pingStartedAt: number | null = null;
  private state: WorkerState = "starting";
  private lobbySnapshotLoaded = false;
  private pendingDuel: LobbyDuelSummary | null = null;
  private activeDuelId: number | null = null;
  private activeStartedAt: string | null = null;
  private rawPackets: DuelPacket[] = [];
  private retryCount = 0;
  private stopping = false;

  constructor(options: WorkerOptions) {
    this.supervisor = options.supervisor;
    this.db = options.db;
    this.runId = options.runId;
    this.account = options.account;
    this.filter = options.filter;
    this.cookieFile = resolve(`.runtime/sessions/${this.account.username}.json`);
    this.sessionId = this.db.createWorkerSession(this.runId, this.account.username);
  }

  async start() {
    await this.connectLoop();
  }

  async stop() {
    this.stopping = true;
    this.setState("stopped", null, null);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.socket?.close();
  }

  private async connectLoop() {
    while (!this.stopping) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setState("reconnecting", this.activeDuelId, message);
        this.db.updateAccountStatus(this.account.username, "reconnecting", message);
        const delayMs = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** this.retryCount, RETRY_BACKOFF_MAX_MS);
        console.error(`[worker:${this.account.username}] reconnecting after error: ${message}`);
        this.retryCount += 1;
        await sleep(delayMs);
      }
    }
  }

  private async connectOnce() {
    this.setState("connecting", this.activeDuelId, null);
    this.db.updateAccountStatus(this.account.username, "connecting");

    const cookieJar = await loadCookieJar(this.cookieFile);
    const client = new DuelingBookClient(cookieJar);
    const login = (await client.login({
      username: this.account.username,
      password: this.account.password,
      rememberMe: true,
    })) as LoginPayload;
    await saveCookieJar(this.cookieFile, client.cookieJar);

    if (!login.username || !login.password) {
      throw new Error("Login response did not include websocket credentials.");
    }

    await new Promise<void>((done, reject) => {
      const socket = new WebSocket(WS_URL, {
        headers: {
          Origin: "https://www.duelingbook.com",
        },
        rejectUnauthorized: false,
      });
      this.socket = socket;
      this.lobbySnapshotLoaded = false;
      let settled = false;
      const connectTimeout = setTimeout(() => {
        void finalizeFailure(`websocket connect timeout after ${WS_CONNECT_TIMEOUT_MS}ms`);
      }, WS_CONNECT_TIMEOUT_MS);

      const finalizeFailure = async (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (this.pendingDuel) {
          this.supervisor.releaseDuel(this.pendingDuel.id, "failed");
          this.pendingDuel = null;
        }
        if (this.activeDuelId !== null) {
          const failedDuelId = this.activeDuelId;
          const failedStartedAt = this.activeStartedAt ?? new Date().toISOString();
          const failedRawPackets = [...this.rawPackets];
          const failedRawLogPath = resolve(`.runtime/duels/incomplete/${failedDuelId}-${Date.now()}.ndjson`);
          this.db.persistFailedDuelAttempt({
            duelId: failedDuelId,
            assignedAccount: this.account.username,
            rawPackets: failedRawPackets,
            rawLogPath: failedRawLogPath,
            startedAt: failedStartedAt,
            failedAt: new Date().toISOString(),
            failureReason: message,
          });
          console.error(
            `[worker:${this.account.username}] duel failed id=${failedDuelId} reason=${message} rawPackets=${failedRawPackets.length}`,
          );
          this.supervisor.releaseDuel(this.activeDuelId, "failed");
          this.activeDuelId = null;
          this.rawPackets = [];
          this.activeStartedAt = null;
        }
        this.pendingDuel = null;
        socket.removeAllListeners();
        socket.close();
        reject(new Error(message));
      };

      socket.on("open", () => {
        clearTimeout(connectTimeout);
        this.retryCount = 0;
        this.sendPacket({
          action: "Connect",
          username: login.username,
          password: login.password,
          session: "",
          db_id: "",
          loadkey: "",
          part: "",
          administrate: false,
          version: 1000000,
          remember_me: 1,
          url: "https://www.duelingbook.com/",
        });

        this.heartbeatTimer = setInterval(() => {
          this.sendPacket({
            action: "Heartbeat",
            ping: this.pingStartedAt,
          }, false);
          this.pingStartedAt = Date.now();
        }, HEARTBEAT_INTERVAL_MS);
      });

      socket.on("message", (data, isBinary) => {
        const raw = isBinary ? data.toString() : data.toString("utf8");
        let packet: Record<string, unknown>;
        try {
          packet = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return;
        }

        const action = typeof packet.action === "string" ? packet.action : "<none>";
        if (action === "Heartbeat" && this.pingStartedAt !== null) {
          this.pingStartedAt = Date.now() - this.pingStartedAt;
          return;
        }

        switch (action) {
          case "Connected":
            this.setState("idle", null, null);
            this.db.updateAccountStatus(this.account.username, "idle");
            this.loadWatching();
            break;

          case "Already logged in":
            void finalizeFailure("Already logged in");
            break;

        case "Load duels":
            this.lobbySnapshotLoaded = true;
            if (this.state === "idle") {
              this.db.updateAccountStatus(this.account.username, "idle");
            }
            break;

          case "Add duel":
            if (!this.lobbySnapshotLoaded || this.state !== "idle") {
              break;
            }

            this.handleLobbyCandidate(packet);
            break;

        case "Watch duel":
            this.handleWatchStatePacket(packet);
            break;

          case "Rejected":
            if (this.pendingDuel) {
              console.log(
                `[worker:${this.account.username}] duel rejected id=${this.pendingDuel.id} message=${String(packet.message ?? "unknown")}`,
              );
              this.supervisor.releaseDuel(this.pendingDuel.id, "rejected");
              this.pendingDuel = null;
              this.setState("idle", null, String(packet.message ?? "unknown"));
              this.loadWatching();
            }
            break;

          case "Duel":
            this.handleDuelPacket(packet as DuelPacket).catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              void finalizeFailure(message);
            });
            break;

          case "Lost connection":
          case "Lost connection 2":
          case "Timed out":
          case "Terminated":
            void finalizeFailure(`socket ended with action=${action}`);
            break;
        }
      });

      socket.on("error", (error) => {
        void finalizeFailure(error.message);
      });

      socket.on("close", (code, reason) => {
        clearTimeout(connectTimeout);
        if (settled) {
          return;
        }
        if (this.stopping) {
          settled = true;
          done();
          return;
        }
        const message = `socket closed code=${code} reason=${reason.toString("utf8") || "<empty>"}`;
        void finalizeFailure(message);
      });
    });
  }

  private handleLobbyCandidate(packet: Record<string, unknown>) {
    const summary = summarizeLobbyDuel(packet);
    if (!matchesQualifyingFilter(summary, this.filter)) {
      return;
    }

    if (!this.supervisor.tryAssignDuel(this.account.username, summary)) {
      return;
    }

    this.pendingDuel = summary;
    this.setState("evaluating", summary.id, null);
    console.log(
      `[worker:${this.account.username}] candidate id=${summary.id} ${summary.title}`,
    );
    this.sendPacket({
      action: "Watch duel",
      id: summary.id,
      password: "",
    });
  }

  private handleWatchStatePacket(packet: Record<string, unknown>) {
    const duelId = Number(packet.id ?? this.pendingDuel?.id ?? this.activeDuelId ?? -1);
    const score = typeof packet.score === "string" ? packet.score : "";
    const status = typeof packet.status === "string" ? packet.status : "<none>";

    if (this.pendingDuel && score === "(0-0-0)") {
      this.activeDuelId = duelId;
      this.activeStartedAt = new Date().toISOString();
      this.rawPackets = [];
      this.pendingDuel = null;
      this.setState("recording", duelId, null);
      this.db.updateAccountStatus(this.account.username, "recording");
      console.log(`[worker:${this.account.username}] recording duel id=${duelId} status=${status} score=${score}`);
      return;
    }

    if (this.pendingDuel) {
      console.log(`[worker:${this.account.username}] skipping stale duel id=${duelId} status=${status} score=${score || "<missing>"}`);
            this.supervisor.releaseDuel(duelId, "stale");
            this.pendingDuel = null;
            this.setState("idle", null, null);
            this.sendPacket({ action: "Exit duel" });
            this.loadWatching();
    }
  }

  private async handleDuelPacket(packet: DuelPacket) {
    if (this.activeDuelId === null || typeof packet.play !== "string") {
      return;
    }

    this.rawPackets.push(packet);
    if (packet.over !== true) {
      return;
    }

    const duelId = this.activeDuelId;
    const completedAt = new Date().toISOString();
    const startedAt = this.activeStartedAt ?? completedAt;

    const result = await this.supervisor.persistCompletedDuel({
      duelId,
      assignedAccount: this.account.username,
      rawPackets: this.rawPackets,
      startedAt,
      completedAt,
    });

    this.supervisor.releaseDuel(duelId, "completed");
    this.rawPackets = [];
    this.activeDuelId = null;
    this.activeStartedAt = null;
    this.setState("idle", null, null);
    this.db.updateAccountStatus(this.account.username, "idle");
    console.log(
      `[worker:${this.account.username}] completed duel id=${duelId} winner=${result.matchSummary.winner ?? "unknown"} score=${result.matchSummary.finalScore ?? "unknown"}`,
    );
    this.loadWatching();
  }

  private sendPacket(packet: Record<string, unknown>, log = true) {
    if (!this.socket) {
      return;
      }

      if (log && packet.action !== "Heartbeat") {
        console.log(`[worker:${this.account.username}][out] ${JSON.stringify(packet)}`);
      }
    this.socket.send(JSON.stringify(packet));
  }

  private loadWatching() {
    this.sendPacket({ action: "Load watching", card: "" });
  }

  private setState(state: WorkerState, currentDuelId: number | null, lastError: string | null) {
    this.state = state;
    this.db.updateWorkerSession(this.sessionId, state, currentDuelId, lastError);
  }
}
