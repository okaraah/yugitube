import process from "node:process";

import "./load-env.js";
import WebSocket from "ws";

import { DuelingBookClient } from "./duelingbook/client.js";
import { loadCookieJar, saveCookieJar } from "./duelingbook/session-store.js";

type CliOptions = {
  username?: string;
  password?: string;
  cookieFile: string;
  rememberMe: boolean;
  durationMs: number;
};

type WebSocketEvent =
  | {
      direction: "out";
      type: "connect-packet";
      at: string;
      payload: Record<string, unknown>;
    }
  | {
      direction: "in";
      type: "message";
      at: string;
      payload: string;
    }
  | {
      direction: "meta";
      type: "open" | "close" | "error";
      at: string;
      payload: string;
    };

const WS_URL = "wss://duel.duelingbook.com:8443/";

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

  const login = await client.login({
    username,
    password,
    rememberMe: options.rememberMe,
  });

  await saveCookieJar(options.cookieFile, client.cookieJar);

  const verification = await client.verifySession();
  if (!verification.isAuthenticated) {
    throw new Error(`Login succeeded but session verification failed with status ${verification.status}.`);
  }

  if (!login.password || !login.username) {
    throw new Error("Login response did not include the websocket credentials expected by DuelingBook.");
  }

  const probeResult = await probeWebSocket({
    username: login.username,
    password: login.password,
    durationMs: options.durationMs,
  });

  console.log(
    JSON.stringify(
      {
        login: {
          action: login.action,
          userId: login.user_id ?? null,
          username: login.username,
          sessionVerified: verification.isAuthenticated,
        },
        websocket: probeResult,
      },
      null,
      2,
    ),
  );
}

async function probeWebSocket(input: {
  username: string;
  password: string;
  durationMs: number;
}) {
  const events: WebSocketEvent[] = [];

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(WS_URL, {
      headers: {
        Origin: "https://www.duelingbook.com",
      },
      rejectUnauthorized: false,
    });

    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
    };

    const timer = setTimeout(() => {
      events.push({
        direction: "meta",
        type: "close",
        at: new Date().toISOString(),
        payload: `probe timeout after ${input.durationMs}ms`,
      });

      socket.close();
      finish(resolve);
    }, input.durationMs);

    socket.on("open", () => {
      const packet = {
        action: "Connect",
        username: input.username,
        password: input.password,
        session: "",
        db_id: "",
        loadkey: "",
        part: "",
        administrate: false,
        version: 1000000,
        remember_me: 1,
        url: "https://www.duelingbook.com/",
      };

      events.push({
        direction: "meta",
        type: "open",
        at: new Date().toISOString(),
        payload: "socket opened",
      });

      events.push({
        direction: "out",
        type: "connect-packet",
        at: new Date().toISOString(),
        payload: packet,
      });

      socket.send(JSON.stringify(packet));
    });

    socket.on("message", (data, isBinary) => {
      const payload = isBinary ? data.toString() : data.toString("utf8");
      events.push({
        direction: "in",
        type: "message",
        at: new Date().toISOString(),
        payload,
      });
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      events.push({
        direction: "meta",
        type: "error",
        at: new Date().toISOString(),
        payload: error.message,
      });
      socket.close();
      finish(() => reject(error));
    });

    socket.on("close", (code, reason) => {
      clearTimeout(timer);
      events.push({
        direction: "meta",
        type: "close",
        at: new Date().toISOString(),
        payload: `code=${code} reason=${reason.toString("utf8") || "<empty>"}`,
      });
      finish(resolve);
    });
  });

  return {
    url: WS_URL,
    durationMs: input.durationMs,
    eventCount: events.length,
    events,
  };
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    cookieFile: ".runtime/duelingbook-session.json",
    rememberMe: true,
    durationMs: 10000,
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

    if (argument === "--duration-ms") {
      const parsed = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.durationMs = parsed;
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
