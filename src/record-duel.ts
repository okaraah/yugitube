import process from "node:process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import "./load-env.js";
import WebSocket from "ws";

import { DuelingBookClient } from "./duelingbook/client.js";
import { loadCookieJar, saveCookieJar } from "./duelingbook/session-store.js";

type CliOptions = {
  username?: string;
  password?: string;
  cookieFile: string;
  rememberMe: boolean;
  logFile: string;
  duelType?: string;
  duelFormat?: string;
  duelRules?: string;
  minRating: number;
  card: string;
  showHeartbeat: boolean;
};

type LoginPayload = {
  action: string;
  user_id?: number;
  username?: string;
  password?: string;
};

type DuelingBookPacket = Record<string, unknown> & {
  action?: string;
  play?: string;
  id?: number;
  status?: string;
  score?: string;
  over?: boolean;
};

type PlayerSummary = {
  username: string;
  rating: number;
};

type WatchDuelSummary = {
  id: number;
  format: string | null;
  rules: string | null;
  type: string | null;
  title: string;
  canWatch: boolean;
  private: boolean;
  playerOne: PlayerSummary;
  playerTwo: PlayerSummary;
};

const WS_URL = "wss://duel.duelingbook.com:8443/";
const HEARTBEAT_INTERVAL_MS = 30_000;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const username = options.username ?? process.env.DUELINGBOOK_USERNAME;
  const password = options.password ?? process.env.DUELINGBOOK_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "Missing credentials. Put DUELINGBOOK_USERNAME and DUELINGBOOK_PASSWORD in .env or pass --username/--password.",
    );
  }

  const cookieJar = await loadCookieJar(options.cookieFile);
  const client = new DuelingBookClient(cookieJar);

  const login = (await client.login({
    username,
    password,
    rememberMe: options.rememberMe,
  })) as LoginPayload;

  await saveCookieJar(options.cookieFile, client.cookieJar);

  const verification = await client.verifySession();
  if (!verification.isAuthenticated) {
    throw new Error(`Login succeeded but session verification failed with status ${verification.status}.`);
  }

  if (!login.username || !login.password) {
    throw new Error("Login response did not include websocket credentials.");
  }

  console.log(
    `[login] username=${login.username} userId=${login.user_id ?? "unknown"} verified=${verification.isAuthenticated}`,
  );
  console.log(
    `[record] waiting for fresh duel type=${options.duelType ?? "*"} format=${options.duelFormat ?? "*"} rules=${options.duelRules ?? "*"} minRating=${options.minRating}`,
  );
  console.log(`[record] writing play packets to ${options.logFile}`);

  await runRecorder({
    login: {
      ...login,
      username: login.username,
      password: login.password,
    },
    card: options.card,
    logFile: options.logFile,
    duelType: options.duelType,
    duelFormat: options.duelFormat,
    duelRules: options.duelRules,
    minRating: options.minRating,
    showHeartbeat: options.showHeartbeat,
  });
}

async function runRecorder(input: {
  login: Required<Pick<LoginPayload, "username" | "password">> & LoginPayload;
  card: string;
  logFile: string;
  duelType?: string;
  duelFormat?: string;
  duelRules?: string;
  minRating: number;
  showHeartbeat: boolean;
}) {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(WS_URL, {
      headers: {
        Origin: "https://www.duelingbook.com",
      },
      rejectUnauthorized: false,
    });

    let heartbeatTimer: NodeJS.Timeout | null = null;
    let pingStartedAt: number | null = null;
    let stopped = false;
    let lobbySnapshotLoaded = false;
    let pendingWatchId: number | null = null;
    let activeWatchedDuelId: number | null = null;
    let playCount = 0;
    const skippedDuelIds = new Set<number>();

    prepareFile(input.logFile);

    const stop = (message?: string) => {
      if (stopped) {
        return;
      }

      stopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (message) {
        console.log(message);
      }
      socket.close();
      resolve();
    };

    const logOutgoing = (packet: Record<string, unknown>) => {
      console.log(`[out] ${JSON.stringify(packet)}`);
    };

    const sendPacket = (packet: Record<string, unknown>, shouldLog = true) => {
      if (shouldLog) {
        logOutgoing(packet);
      }
      socket.send(JSON.stringify(packet));
    };

    const loadWatching = () => {
      sendPacket({ action: "Load watching", card: input.card });
    };

    const exitAndReturnToLobby = () => {
      sendPacket({ action: "Exit duel" });
      loadWatching();
      pendingWatchId = null;
      activeWatchedDuelId = null;
      playCount = 0;
    };

    const shutdown = () => stop("[record] stopping");
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    socket.on("open", () => {
      sendPacket({
        action: "Connect",
        username: input.login.username,
        password: input.login.password,
        session: "",
        db_id: "",
        loadkey: "",
        part: "",
        administrate: false,
        version: 1000000,
        remember_me: 1,
        url: "https://www.duelingbook.com/",
      });

      heartbeatTimer = setInterval(() => {
        const heartbeatPacket = {
          action: "Heartbeat",
          ping: pingStartedAt,
        };

        pingStartedAt = Date.now();
        if (input.showHeartbeat) {
          logOutgoing(heartbeatPacket);
        }
        socket.send(JSON.stringify(heartbeatPacket));
      }, HEARTBEAT_INTERVAL_MS);
    });

    socket.on("message", (data, isBinary) => {
      const raw = isBinary ? data.toString() : data.toString("utf8");
      let packet: DuelingBookPacket;

      try {
        packet = JSON.parse(raw) as DuelingBookPacket;
      } catch {
        console.log(`[in][raw] ${raw}`);
        return;
      }

      if (packet.action === "Heartbeat" && pingStartedAt !== null) {
        pingStartedAt = Date.now() - pingStartedAt;
        return;
      }

      switch (packet.action) {
        case "Connected": {
          console.log(
            `[in:Connected] username=${String(packet.username ?? "unknown")} userId=${String(packet.id ?? "unknown")}`,
          );
          loadWatching();
          break;
        }

        case "Already logged in": {
          stop("[record] websocket rejected: account is already logged in on another socket session");
          break;
        }

        case "Load duels": {
          const duels = Array.isArray(packet.duels) ? packet.duels : [];
          const interestingCount = duels
            .map(summarizeWatchingDuel)
            .filter((duel) => matchesInterestingFilter(duel, input)).length;
          lobbySnapshotLoaded = true;
          console.log(`[lobby] snapshot loaded duels=${duels.length} interesting=${interestingCount}`);
          break;
        }

        case "Add duel": {
          if (!lobbySnapshotLoaded || pendingWatchId !== null || activeWatchedDuelId !== null) {
            break;
          }

          const summary = summarizeWatchingDuel(packet);
          if (skippedDuelIds.has(summary.id) || !summary.canWatch || !matchesInterestingFilter(summary, input)) {
            break;
          }

          pendingWatchId = summary.id;
          console.log("");
          console.log(`[candidate] id=${summary.id}`);
          console.log(`[candidate] players=${summary.title}`);
          console.log(
            `[candidate] format=${summary.format ?? "?"} rules=${summary.rules ?? "?"} type=${summary.type ?? "?"}`,
          );
          sendPacket({
            action: "Watch duel",
            id: summary.id,
            password: "",
          });
          break;
        }

        case "Watch duel": {
          const duelId = Number(packet.id ?? pendingWatchId ?? -1);
          const score = typeof packet.score === "string" ? packet.score : "";
          const status = typeof packet.status === "string" ? packet.status : "<none>";

          if (pendingWatchId === null && activeWatchedDuelId === null) {
            break;
          }

          if (score !== "(0-0-0)") {
            console.log(`[watch] skipping non-fresh duel id=${duelId} score=${score || "<missing>"}`);
            console.log(`[watch] watch-state-packet ${JSON.stringify(packet)}`);
            skippedDuelIds.add(duelId);
            exitAndReturnToLobby();
            break;
          }

          pendingWatchId = null;
          activeWatchedDuelId = duelId;
          playCount = 0;
          console.log(`[watch] accepted duel id=${duelId} status=${status} score=${score}`);
          break;
        }

        case "Duel": {
          if (activeWatchedDuelId === null || typeof packet.play !== "string") {
            break;
          }

          playCount += 1;
          appendFileSync(input.logFile, `${JSON.stringify(packet)}\n`);
          console.log(
            `[play ${playCount}] ${packet.play}${packet.over === true ? " over=true" : ""}`,
          );

          if (packet.over === true) {
            stop(`[record] completed duel id=${activeWatchedDuelId} plays=${playCount}`);
          }
          break;
        }

        case "Duel over": {
          const duelId = Number(packet.id ?? -1);
          skippedDuelIds.delete(duelId);
          break;
        }

        case "Rejected": {
          const duelId = pendingWatchId ?? -1;
          skippedDuelIds.add(duelId);
          pendingWatchId = null;
          activeWatchedDuelId = null;
          console.log(
            `[watch] rejected duel id=${duelId} message=${typeof packet.message === "string" ? packet.message : "unknown"}`,
          );
          loadWatching();
          break;
        }

        case "Terminated":
        case "Timed out":
        case "Not online":
        case "Lost connection":
        case "Lost connection 2": {
          stop(`[record] socket ended with action=${packet.action}`);
          break;
        }
      }
    });

    socket.on("error", (error) => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      reject(error);
    });

    socket.on("close", (code, reason) => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (!stopped) {
        console.log(`[record] socket closed code=${code} reason=${reason.toString("utf8") || "<empty>"}`);
        resolve();
      }
    });
  });
}

function summarizeWatchingDuel(duel: unknown): WatchDuelSummary {
  const packet = (duel ?? {}) as Record<string, unknown>;
  const playerOne = normalizePlayer(packet.p1);
  const playerTwo = normalizePlayer(packet.p2);
  const note = typeof packet.note === "string" && packet.note ? ` note=${packet.note}` : "";

  return {
    id: Number(packet.id ?? -1),
    format: typeof packet.f === "string" ? packet.f : null,
    rules: typeof packet.r === "string" ? packet.r : null,
    type: typeof packet.t === "string" ? packet.t : null,
    title: `${playerOne.username} (${playerOne.rating}) vs ${playerTwo.username} (${playerTwo.rating})${note}`,
    canWatch: packet.watching !== false,
    private: Boolean(packet.password),
    playerOne,
    playerTwo,
  };
}

function normalizePlayer(value: unknown): PlayerSummary {
  const player = (value ?? {}) as Record<string, unknown>;
  return {
    username: typeof player.u === "string" ? player.u : "unknown",
    rating: typeof player.r === "number" ? player.r : Number(player.r ?? 0),
  };
}

function matchesInterestingFilter(
  duel: WatchDuelSummary,
  filter: {
    duelType?: string;
    duelFormat?: string;
    duelRules?: string;
    minRating: number;
  },
) {
  if (filter.duelType && duel.type !== filter.duelType) {
    return false;
  }

  if (filter.duelFormat && duel.format !== filter.duelFormat) {
    return false;
  }

  if (filter.duelRules && duel.rules !== filter.duelRules) {
    return false;
  }

  return duel.playerOne.rating >= filter.minRating && duel.playerTwo.rating >= filter.minRating;
}

function prepareFile(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, "");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    cookieFile: ".runtime/duelingbook-session.json",
    rememberMe: true,
    logFile: ".runtime/logs/duel-plays.ndjson",
    duelType: "m",
    duelFormat: "ar",
    duelRules: "TCG",
    minRating: 300,
    card: "",
    showHeartbeat: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--username") {
      options.username = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--password") {
      options.password = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--cookie-file") {
      options.cookieFile = args[index + 1] ?? options.cookieFile;
      index += 1;
      continue;
    }

    if (argument === "--log-file") {
      options.logFile = args[index + 1] ?? options.logFile;
      index += 1;
      continue;
    }

    if (argument === "--type") {
      options.duelType = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--format") {
      options.duelFormat = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--rules") {
      options.duelRules = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--min-rating") {
      const parsed = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        options.minRating = parsed;
      }
      index += 1;
      continue;
    }

    if (argument === "--card") {
      options.card = args[index + 1] ?? options.card;
      index += 1;
      continue;
    }

    if (argument === "--heartbeat-log") {
      options.showHeartbeat = true;
      continue;
    }

    if (argument === "--no-remember-me") {
      options.rememberMe = false;
      continue;
    }
  }

  return options;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
