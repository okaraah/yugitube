import process from "node:process";
import { readFileSync } from "node:fs";
import { parseMatch, type DuelPacket } from "./analytics/duel-parser.js";

type CliOptions = {
  inputFile: string;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packets = loadPackets(options.inputFile);
  const summary = parseMatch(options.inputFile, packets);
  console.log(JSON.stringify(summary, null, 2));
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    inputFile: ".runtime/logs/duel-plays.ndjson",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--input-file") {
      options.inputFile = args[index + 1] ?? options.inputFile;
      index += 1;
    }
  }

  return options;
}

function loadPackets(path: string): DuelPacket[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DuelPacket);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
