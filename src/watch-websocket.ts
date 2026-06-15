import process from "node:process";
import { mkdirSync, appendFileSync } from "node:fs";
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
  card: string;
  duelId?: number;
  autoWatch: boolean;
  showAllPackets: boolean;
  showHeartbeat: boolean;
  logFile?: string;
  duelType?: string;
  duelFormat?: string;
  duelRules?: string;
  minRating: number;
  interestingOnly: boolean;
};

type LoginPayload = {
  action: string;
  user_id?: number;
  username?: string;
  password?: string;
  admin?: boolean;
  firstLogin?: boolean;
};

type DuelingBookPacket = Record<string, unknown> & {
  action?: string;
};

type WatchDuelSummary = {
  id: number;
  format: string | null;
  rules: string | null;
  type: string | null;
  title: string;
  canWatch: boolean;
  private: boolean;
  playerOne: ReturnType<typeof normalizePlayer>;
  playerTwo: ReturnType<typeof normalizePlayer>;
};

const WS_URL = "wss://duel.duelingbook.com:8443/";
const HEARTBEAT_INTERVAL_MS = 30_000;

const DEFAULT_IGNORED_ACTIONS = new Set([
  "Load statuses",
  "Load videos",
  "Load official tourneys",
  "Online user",
  "Offline user",
  "Back",
  "Away",
  "Like status",
  "Read message",
  "Loaded public chat",
  "Loaded watchers chat",
  "Loaded duel chat",
  "Public message",
  "Get friends",
  "Online users",
  "Post status",
]);

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
    `[watch] connecting to ${WS_URL} card=${JSON.stringify(options.card)} autoWatch=${options.autoWatch} duelId=${options.duelId ?? "auto"}`,
  );
  console.log(
    `[watch] filters type=${options.duelType ?? "*"} format=${options.duelFormat ?? "*"} rules=${options.duelRules ?? "*"} minRating=${options.minRating} interestingOnly=${options.interestingOnly}`,
  );
  if (options.logFile) {
    console.log(`[watch] logging packets to ${options.logFile}`);
  }

  await runWatchSession({
    login: {
      ...login,
      username: login.username,
      password: login.password,
    },
    card: options.card,
    duelId: options.duelId,
    autoWatch: options.autoWatch,
    showAllPackets: options.showAllPackets,
    showHeartbeat: options.showHeartbeat,
    logFile: options.logFile,
    duelType: options.duelType,
    duelFormat: options.duelFormat,
    duelRules: options.duelRules,
    minRating: options.minRating,
    interestingOnly: options.interestingOnly,
  });
}

async function runWatchSession(input: {
  login: Required<Pick<LoginPayload, "username" | "password">> & LoginPayload;
  card: string;
  duelId?: number;
  autoWatch: boolean;
  showAllPackets: boolean;
  showHeartbeat: boolean;
  logFile?: string;
  duelType?: string;
  duelFormat?: string;
  duelRules?: string;
  minRating: number;
  interestingOnly: boolean;
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
    let watchedDuelId: number | null = null;
    const trackedInterestingDuels = new Map<number, WatchDuelSummary>();
    const logFile = preparePacketLogFile(input.logFile);

    const writeLog = (entry: Record<string, unknown>) => {
      if (!logFile) {
        return;
      }

      appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    };

    const stop = (exitMessage?: string) => {
      if (stopped) {
        return;
      }

      stopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (exitMessage) {
        console.log(exitMessage);
      }
      socket.close();
      resolve();
    };

    const shutdown = () => stop("[watch] stopping");
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    socket.on("open", () => {
      const connectPacket = {
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
      };

      logOutgoing(connectPacket);
      writeLog({
        at: new Date().toISOString(),
        direction: "out",
        action: "Connect",
        payload: connectPacket,
      });
      socket.send(JSON.stringify(connectPacket));

      heartbeatTimer = setInterval(() => {
        const heartbeatPacket = {
          action: "Heartbeat",
          ping: pingStartedAt,
        };

        pingStartedAt = Date.now();
        if (input.showHeartbeat) {
          logOutgoing(heartbeatPacket);
        }
        writeLog({
          at: new Date().toISOString(),
          direction: "out",
          action: "Heartbeat",
          payload: heartbeatPacket,
        });
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
        const latency = Date.now() - pingStartedAt;
        pingStartedAt = latency;
      }

      if (shouldLogPacket(packet, input.showAllPackets, input.showHeartbeat)) {
        logIncoming(packet);
      }
      writeLog({
        at: new Date().toISOString(),
        direction: "in",
        action: typeof packet.action === "string" ? packet.action : "<none>",
        payload: packet,
      });

      switch (packet.action) {
        case "Connected": {
          const loadWatchingPacket = {
            action: "Load watching",
            card: input.card,
          };
          logOutgoing(loadWatchingPacket);
          writeLog({
            at: new Date().toISOString(),
            direction: "out",
            action: "Load watching",
            payload: loadWatchingPacket,
          });
          socket.send(JSON.stringify(loadWatchingPacket));
          break;
        }

        case "Load duels": {
          const duels = Array.isArray(packet.duels) ? packet.duels : [];
          const summaries = duels.map(summarizeWatchingDuel);
          const interesting = summaries.filter((summary) => matchesInterestingFilter(summary, input));
          trackedInterestingDuels.clear();
          for (const summary of interesting) {
            trackedInterestingDuels.set(summary.id, summary);
          }

          console.log(
            `[watch] received ${summaries.length} watchable listings interesting=${interesting.length}`,
          );
          const visibleSummaries = input.interestingOnly ? interesting : summaries.slice(0, 10);
          for (const summary of visibleSummaries.slice(0, 10)) {
            const tag = matchesInterestingFilter(summary, input) ? "[interesting]" : "[duel]";
            console.log(
              `${tag} id=${summary.id} ${summary.title} format=${summary.format ?? "?"} rules=${summary.rules ?? "?"} type=${summary.type ?? "?"} canWatch=${summary.canWatch} private=${summary.private}`,
            );
          }

          if (!input.autoWatch || watchedDuelId !== null) {
            break;
          }

          const candidates = summaries.filter((duel) => duel.canWatch);
          const filteredCandidates = candidates.filter((duel) => matchesInterestingFilter(duel, input));
          const target =
            summaries.find((duel) => duel.id === input.duelId) ??
            filteredCandidates[0] ??
            candidates[0];

          if (!target) {
            console.log("[watch] no suitable duel found in Load duels response");
            break;
          }

          watchedDuelId = target.id;
          const watchDuelPacket = {
            action: "Watch duel",
            id: target.id,
            password: "",
          };
          console.log(`[watch] sending Watch duel for id=${target.id}`);
          logOutgoing(watchDuelPacket);
          writeLog({
            at: new Date().toISOString(),
            direction: "out",
            action: "Watch duel",
            payload: watchDuelPacket,
          });
          socket.send(JSON.stringify(watchDuelPacket));
          break;
        }

        case "Add duel": {
          const summary = summarizeWatchingDuel(packet);
          if (matchesInterestingFilter(summary, input)) {
            trackedInterestingDuels.set(summary.id, summary);
            console.log(
              `[interesting:start] id=${summary.id} ${summary.title} format=${summary.format ?? "?"} rules=${summary.rules ?? "?"} type=${summary.type ?? "?"}`,
            );
          }
          break;
        }

        case "Duel over": {
          const duelId = Number(packet.id ?? -1);
          const tracked = trackedInterestingDuels.get(duelId);
          if (tracked) {
            console.log(
              `[interesting:end] id=${tracked.id} ${tracked.title} format=${tracked.format ?? "?"} rules=${tracked.rules ?? "?"} type=${tracked.type ?? "?"}`,
            );
            trackedInterestingDuels.delete(duelId);
          }
          break;
        }

        case "Watch duel": {
          console.log(`[watch] entered watch state for duel id=${String(packet.id ?? watchedDuelId ?? "unknown")}`);
          break;
        }

        case "Rejected": {
          const message = typeof packet.message === "string" ? packet.message : "server rejected request";
          stop(`[watch] rejected: ${message}`);
          break;
        }

        case "Terminated":
        case "Timed out":
        case "Not online":
        case "Lost connection":
        case "Lost connection 2": {
          stop(`[watch] socket ended with action=${packet.action}`);
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
        console.log(`[watch] socket closed code=${code} reason=${reason.toString("utf8") || "<empty>"}`);
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

function normalizePlayer(value: unknown) {
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

function shouldLogPacket(packet: DuelingBookPacket, showAllPackets: boolean, showHeartbeat: boolean) {
  const action = typeof packet.action === "string" ? packet.action : "<none>";

  if (showAllPackets) {
    return showHeartbeat || action !== "Heartbeat";
  }

  if (action === "Heartbeat") {
    return showHeartbeat;
  }

  if (DEFAULT_IGNORED_ACTIONS.has(action)) {
    return false;
  }

  return true;
}

function logOutgoing(packet: Record<string, unknown>) {
  console.log(`[out] ${JSON.stringify(packet)}`);
}

function logIncoming(packet: DuelingBookPacket) {
  const action = packet.action ?? "unknown";

  if (action === "Connected") {
    console.log(
      `[in:Connected] username=${String(packet.username ?? "unknown")} userId=${String(packet.id ?? "unknown")} decks=${Array.isArray(packet.decks) ? packet.decks.length : 0}`,
    );
    return;
  }

  if (action === "Load duels") {
    const duelCount = Array.isArray(packet.duels) ? packet.duels.length : 0;
    console.log(`[in:Load duels] duelCount=${duelCount}`);
    return;
  }

  if (action === "Add duel" || action === "Cancel duel" || action === "Host duel") {
    console.log(`[in:${action}] ${JSON.stringify(packet)}`);
    return;
  }

  if (action === "Duel") {
    const play = typeof packet.play === "string" ? packet.play : "<none>";
    const status = typeof packet.status === "string" ? packet.status : "";
    console.log(`[in:Duel] play=${play}${status ? ` status=${status}` : ""} ${JSON.stringify(packet)}`);
    return;
  }

  if (action === "Watch duel") {
    const duelId = String(packet.id ?? "unknown");
    const status = typeof packet.status === "string" ? packet.status : "<none>";
    console.log(`[in:Watch duel] id=${duelId} status=${status} ${JSON.stringify(packet)}`);
    return;
  }

  console.log(`[in:${action}] ${JSON.stringify(packet)}`);
}

function preparePacketLogFile(logFile?: string): string | null {
  if (!logFile) {
    return null;
  }

  mkdirSync(dirname(logFile), { recursive: true });
  return logFile;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    cookieFile: ".runtime/duelingbook-session.json",
    rememberMe: true,
    card: "",
    autoWatch: true,
    showAllPackets: false,
    showHeartbeat: true,
    logFile: undefined,
    duelType: "m",
    duelFormat: "ar",
    duelRules: "TCG",
    minRating: 300,
    interestingOnly: true,
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

    if (argument === "--card") {
      options.card = args[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (argument === "--duel-id") {
      const parsed = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isNaN(parsed)) {
        options.duelId = parsed;
      }
      index += 1;
      continue;
    }

    if (argument === "--no-auto-watch") {
      options.autoWatch = false;
      continue;
    }

    if (argument === "--lobby-only") {
      options.autoWatch = false;
      continue;
    }

    if (argument === "--all-packets") {
      options.showAllPackets = true;
      continue;
    }

    if (argument === "--interesting-only") {
      options.interestingOnly = true;
      continue;
    }

    if (argument === "--no-interesting-only") {
      options.interestingOnly = false;
      continue;
    }

    if (argument === "--no-heartbeat-log") {
      options.showHeartbeat = false;
      continue;
    }

    if (argument === "--log-file") {
      options.logFile = args[index + 1];
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
