import process from "node:process";

import "./load-env.js";

import { DuelingBookClient } from "./duelingbook/client.js";
import { loadCookieJar, saveCookieJar } from "./duelingbook/session-store.js";

type CliOptions = {
  username?: string;
  password?: string;
  cookieFile: string;
  rememberMe: boolean;
};

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

  console.log(
    JSON.stringify(
      {
        action: login.action,
        userId: login.user_id ?? null,
        username: login.username ?? username,
        admin: login.admin ?? false,
        firstLogin: login.firstLogin ?? false,
        sessionVerified: verification.isAuthenticated,
        verifiedUsername: verification.username,
        cookieFile: options.cookieFile,
      },
      null,
      2,
    ),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    cookieFile: ".runtime/duelingbook-session.json",
    rememberMe: true,
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
