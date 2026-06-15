import process from "node:process";

import "./load-env.js";

import { syncCardsCatalog } from "./cards/catalog.js";
import { ScraperDatabase } from "./storage/database.js";

type CliOptions = {
  dbPath: string;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = new ScraperDatabase(options.dbPath);
  db.init();
  const count = await syncCardsCatalog(db);
  db.close();
  console.log(JSON.stringify({ dbPath: options.dbPath, cardsSynced: count }, null, 2));
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
