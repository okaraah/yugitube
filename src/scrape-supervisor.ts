import process from "node:process";

import "./load-env.js";

import { ScraperDatabase, type ScraperAccountConfig } from "./storage/database.js";
import { DuelScraperSupervisor } from "./scraper/supervisor.js";
import type { QualifyingFilter } from "./scraper/filter.js";

type CliOptions = {
  dbPath: string;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const accounts = loadWatcherAccounts();
  const filter = loadQualifyingFilter();

  const db = new ScraperDatabase(options.dbPath);
  const supervisor = new DuelScraperSupervisor({
    db,
    accounts,
    filter,
    dbPath: options.dbPath,
  });

  console.log(
    `[supervisor] starting accounts=${accounts.map((account) => account.username).join(",")} db=${options.dbPath}`,
  );
  console.log(
    `[supervisor] filter type=${filter.duelType} format=${filter.duelFormat} rules=${filter.duelRules} minRating=${filter.minRating}`,
  );

  await supervisor.start();
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: ".runtime/yugitube.sqlite",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--db-path") {
      options.dbPath = args[index + 1] ?? options.dbPath;
      index += 1;
    }
  }

  return options;
}

function loadWatcherAccounts() {
  const json = process.env.DUELINGBOOK_WATCHER_ACCOUNTS_JSON;
  if (json) {
    const parsed = JSON.parse(json) as Array<{ username: string; password: string }>;
    return parsed.map((account) => ({
      username: account.username,
      password: account.password,
    })) satisfies ScraperAccountConfig[];
  }

  const commaSeparated = process.env.DUELINGBOOK_WATCHER_ACCOUNTS;
  const sharedPassword = process.env.DUELINGBOOK_WATCHER_PASSWORD ?? "billy123";
  if (commaSeparated) {
    return commaSeparated
      .split(",")
      .map((username) => username.trim())
      .filter(Boolean)
      .map((username) => ({ username, password: sharedPassword }));
  }

  return Array.from({ length: 5 }, (_, index) => ({
    username: `billyburger${index + 1}`,
    password: sharedPassword,
  }));
}

function loadQualifyingFilter(): QualifyingFilter {
  return {
    duelType: process.env.SCRAPER_DUEL_TYPE ?? "m",
    duelFormat: process.env.SCRAPER_DUEL_FORMAT ?? "ar",
    duelRules: process.env.SCRAPER_DUEL_RULES ?? "TCG",
    minRating: Number.parseInt(process.env.SCRAPER_MIN_RATING ?? "300", 10) || 300,
  };
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
