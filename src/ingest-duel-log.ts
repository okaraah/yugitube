import process from "node:process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseMatch, type DuelPacket } from "./analytics/duel-parser.js";
import { ScraperDatabase } from "./storage/database.js";

type CliOptions = {
  inputFile: string;
  dbPath: string;
  duelId?: number;
  account: string;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rawPackets = readFileSync(options.inputFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DuelPacket);

  const matchSummary = parseMatch(options.inputFile, rawPackets);
  const duelId = options.duelId ?? inferDuelId(rawPackets);
  if (!duelId) {
    throw new Error("Could not infer duel id from the log. Pass --duel-id explicitly.");
  }

  const db = new ScraperDatabase(options.dbPath);
  db.init();
  const persisted = db.persistCompletedDuel({
    duelId,
    assignedAccount: options.account,
    rawPackets,
    matchSummary,
    rawLogPath: resolve(options.inputFile),
    replayUrl: `https://www.duelingbook.com/replay?id=${duelId}`,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    probableArchetypes: matchSummary.probableArchetypes,
  });
  db.close();

  console.log(
    JSON.stringify(
      {
        duelId,
        persisted,
        winner: matchSummary.winner,
        finalScore: matchSummary.finalScore,
        probableArchetypes: matchSummary.probableArchetypes,
      },
      null,
      2,
    ),
  );
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    inputFile: ".runtime/logs/duel-plays.ndjson",
    dbPath: ".runtime/yugitube.sqlite",
    account: "manual-import",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--input-file") {
      options.inputFile = args[index + 1] ?? options.inputFile;
      index += 1;
      continue;
    }

    if (argument === "--db-path") {
      options.dbPath = args[index + 1] ?? options.dbPath;
      index += 1;
      continue;
    }

    if (argument === "--duel-id") {
      const parsed = Number.parseInt(args[index + 1] ?? "", 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.duelId = parsed;
      }
      index += 1;
      continue;
    }

    if (argument === "--account") {
      options.account = args[index + 1] ?? options.account;
      index += 1;
    }
  }

  return options;
}

function inferDuelId(packets: DuelPacket[]) {
  for (const packet of packets) {
    const id = Number(packet.id ?? NaN);
    if (Number.isFinite(id) && id > 0) {
      return id;
    }
  }
  return null;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
