export type DuelPacket = Record<string, unknown> & {
  play?: string;
  username?: string;
  seconds?: number;
  score?: string;
  over?: boolean;
  message?: string;
  viewing?: string;
  order?: unknown;
  winner?: string;
  player1?: Record<string, unknown>;
  player2?: Record<string, unknown>;
  card?: Record<string, unknown>;
};

export type CardActionSummary = {
  cardName: string;
  owner: string;
  total: number;
  actions: Record<string, number>;
};

export type GameSummary = {
  gameNumber: number;
  scoreAtStart: string;
  startingPlayer: string | null;
  loser: string | null;
  winner: string | null;
  endedMatch: boolean;
  totalPackets: number;
  realPlays: number;
  realPlayBreakdown: Record<string, number>;
  cardsByPlayer: Record<string, string[]>;
  topCards: CardActionSummary[];
};

export type MatchSummary = {
  file: string;
  players: string[];
  winner: string | null;
  loser: string | null;
  finalScore: string | null;
  gamesPlayed: number;
  turnsObserved: number;
  totalPackets: number;
  realPlays: number;
  realPlayBreakdown: Record<string, number>;
  perPlayerRealPlays: Record<string, number>;
  cardsByPlayer: Record<string, string[]>;
  uniqueCardsCountByPlayer: Record<string, number>;
  probableArchetypes: Record<string, string | null>;
  topCards: CardActionSummary[];
  gameResults: Array<{
    gameNumber: number;
    scoreAtStart: string;
    winner: string | null;
    loser: string | null;
    endedMatch: boolean;
    realPlays: number;
  }>;
  games: GameSummary[];
  insights: string[];
};

const IGNORED_PLAYS = new Set([
  "Add watcher",
  "Stop viewing",
  "View deck",
  "View GY",
  "View GY 2",
  "View ED",
  "View Banished",
  "Show hand",
  "Typing",
  "Thinking",
  "Good",
  "Stop good",
  "Duel message",
  "Shuffle deck",
  "Shuffle hand",
]);

const CARD_RELEVANT_PLAYS = new Set([
  "Activate ST",
  "Activate Field Spell",
  "Normal Summon",
  "SS ATK",
  "SS DEF",
  "Set ST",
  "To hand",
  "To GY",
  "Banish",
  "Banish FD",
  "Mill",
  "Declare",
  "Reveal",
  "Draw card",
  "To T Deck",
  "Life points",
]);

const ARCHETYPE_STOPWORDS = new Set([
  "the",
  "of",
  "and",
  "a",
  "an",
  "for",
  "to",
  "in",
  "on",
  "by",
  "with",
  "from",
  "at",
  "ace",
  "dragon",
  "monster",
  "spell",
  "trap",
  "card",
]);

export function parseMatch(file: string, packets: DuelPacket[]): MatchSummary {
  const players = Array.from(collectPlayers(packets));
  const games: GameSummary[] = [];
  let currentGame = createGameSummary(1, "(0-0-0)");
  let finalLoser: string | null = null;
  let finalWinner: string | null = null;
  let finalScore: string | null = null;
  let turnsObserved = 0;

  const overallRealPlayBreakdown = new Map<string, number>();
  const perPlayerRealPlays = new Map<string, number>();
  const overallCards = new Map<string, Map<string, number>>();

  for (const packet of packets) {
    const play = typeof packet.play === "string" ? packet.play : "<none>";
    currentGame.totalPackets += 1;

    if (play === "Begin next duel") {
      games.push(finalizeGameSummary(currentGame));
      const scoreAtStart = typeof packet.score === "string" ? packet.score : "(unknown)";
      currentGame = createGameSummary(games.length + 1, scoreAtStart);
      currentGame.totalPackets = 1;
      currentGame.startingPlayer = typeof packet.username === "string" ? packet.username : null;
    }

    if (play === "Start turn") {
      turnsObserved += 1;
    }

    if (play === "Pick first" && currentGame.startingPlayer === null) {
      currentGame.startingPlayer = typeof packet.username === "string" ? packet.username : null;
    }

    if (play === "Admit defeat") {
      const loser = typeof packet.username === "string" ? packet.username : null;
      const winner = loser ? findOtherPlayer(players, loser) : null;
      currentGame.loser = loser;
      currentGame.winner = winner;
      currentGame.endedMatch = packet.over === true;
      if (packet.over === true) {
        finalLoser = loser;
        finalWinner = winner;
      }
    }

    if (isRealPlay(play)) {
      incrementMap(overallRealPlayBreakdown, play);
      incrementMap(currentGame.realPlayBreakdownMap, play);
      currentGame.realPlays += 1;

      const actor = typeof packet.username === "string" ? packet.username : null;
      if (actor && players.includes(actor)) {
        perPlayerRealPlays.set(actor, (perPlayerRealPlays.get(actor) ?? 0) + 1);
      }
    }

    const cardName = extractCardName(packet);
    const owner = inferCardOwner(packet, players);
    if (cardName && owner && CARD_RELEVANT_PLAYS.has(play)) {
      addCardAction(overallCards, owner, cardName, play);
      addCardAction(currentGame.cardsMap, owner, cardName, play);
    }
  }

  games.push(finalizeGameSummary(currentGame));
  finalScore = buildFinalScore(players, games);

  const cardsByPlayer = mapCardsByPlayer(overallCards);
  const uniqueCardsCountByPlayer = Object.fromEntries(
    Object.entries(cardsByPlayer).map(([player, cards]) => [player, cards.length]),
  );
  const probableArchetypes = Object.fromEntries(
    players.map((player) => [player, inferArchetypeForPlayer(player, overallCards)]),
  );

  return {
    file,
    players,
    winner: finalWinner,
    loser: finalLoser,
    finalScore,
    gamesPlayed: games.length,
    turnsObserved,
    totalPackets: packets.length,
    realPlays: sumMap(overallRealPlayBreakdown),
    realPlayBreakdown: sortRecord(toRecord(overallRealPlayBreakdown)),
    perPlayerRealPlays: sortRecord(toRecord(perPlayerRealPlays)),
    cardsByPlayer,
    uniqueCardsCountByPlayer,
    probableArchetypes,
    topCards: flattenTopCards(overallCards),
    gameResults: games.map((game) => ({
      gameNumber: game.gameNumber,
      scoreAtStart: game.scoreAtStart,
      winner: game.winner,
      loser: game.loser,
      endedMatch: game.endedMatch,
      realPlays: game.realPlays,
    })),
    games,
    insights: buildInsights({
      games,
      finalWinner,
      finalScore,
      turnsObserved,
      overallRealPlayBreakdown,
      overallCards,
    }),
  };
}

export function parsePacketsFromLines(lines: string[], file = "<memory>") {
  const packets = lines.filter(Boolean).map((line) => JSON.parse(line) as DuelPacket);
  return parseMatch(file, packets);
}

function createGameSummary(gameNumber: number, scoreAtStart: string) {
  return {
    gameNumber,
    scoreAtStart,
    startingPlayer: null as string | null,
    loser: null as string | null,
    winner: null as string | null,
    endedMatch: false,
    totalPackets: 0,
    realPlays: 0,
    realPlayBreakdownMap: new Map<string, number>(),
    cardsMap: new Map<string, Map<string, number>>(),
  };
}

function finalizeGameSummary(game: ReturnType<typeof createGameSummary>): GameSummary {
  return {
    gameNumber: game.gameNumber,
    scoreAtStart: game.scoreAtStart,
    startingPlayer: game.startingPlayer,
    loser: game.loser,
    winner: game.winner,
    endedMatch: game.endedMatch,
    totalPackets: game.totalPackets,
    realPlays: game.realPlays,
    realPlayBreakdown: sortRecord(toRecord(game.realPlayBreakdownMap)),
    cardsByPlayer: mapCardsByPlayer(game.cardsMap),
    topCards: flattenTopCards(game.cardsMap),
  };
}

function collectPlayers(packets: DuelPacket[]) {
  const players = new Set<string>();

  for (const packet of packets) {
    for (const value of [packet.username, packet.player1?.username, packet.player2?.username, packet.winner]) {
      if (typeof value === "string" && value) {
        players.add(value);
      }
    }

    if (Array.isArray(packet.order)) {
      for (const value of packet.order) {
        if (typeof value === "string" && value) {
          players.add(value);
        }
      }
    }

    if (players.size >= 2) {
      return players;
    }
  }

  return players;
}

function isRealPlay(play: string) {
  return play !== "<none>" && !IGNORED_PLAYS.has(play);
}

function extractCardName(packet: DuelPacket) {
  const card = packet.card;
  if (!card || typeof card !== "object") {
    return null;
  }

  const treatedAs = typeof card.treated_as === "string" ? card.treated_as : null;
  const name = typeof card.name === "string" ? card.name : null;
  return treatedAs ?? name;
}

function inferCardOwner(packet: DuelPacket, players: string[]) {
  const actor = typeof packet.username === "string" ? packet.username : null;
  const play = typeof packet.play === "string" ? packet.play : "";

  if (!actor) {
    return null;
  }

  if (!players.includes(actor)) {
    return null;
  }

  if (play === "Show hand" && packet.viewing === "Opponent's Hand") {
    return findOtherPlayer(players, actor);
  }

  return actor;
}

function findOtherPlayer(players: string[], username: string) {
  return players.find((player) => player !== username) ?? null;
}

function incrementMap(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function addCardAction(
  cardsMap: Map<string, Map<string, number>>,
  owner: string,
  cardName: string,
  action: string,
) {
  let ownerMap = cardsMap.get(owner);
  if (!ownerMap) {
    ownerMap = new Map<string, number>();
    cardsMap.set(owner, ownerMap);
  }

  const compositeKey = `${cardName}|||${action}`;
  ownerMap.set(compositeKey, (ownerMap.get(compositeKey) ?? 0) + 1);
}

function mapCardsByPlayer(cardsMap: Map<string, Map<string, number>>) {
  const output: Record<string, string[]> = {};

  for (const [owner, ownerMap] of cardsMap.entries()) {
    const names = new Set<string>();
    for (const compositeKey of ownerMap.keys()) {
      names.add(compositeKey.split("|||")[0]);
    }
    output[owner] = Array.from(names).sort();
  }

  return output;
}

function flattenTopCards(cardsMap: Map<string, Map<string, number>>): CardActionSummary[] {
  const summaries: CardActionSummary[] = [];

  for (const [owner, ownerMap] of cardsMap.entries()) {
    const perCard = new Map<string, { total: number; actions: Map<string, number> }>();

    for (const [compositeKey, count] of ownerMap.entries()) {
      const [cardName, action] = compositeKey.split("|||");
      let entry = perCard.get(cardName);
      if (!entry) {
        entry = { total: 0, actions: new Map<string, number>() };
        perCard.set(cardName, entry);
      }
      entry.total += count;
      entry.actions.set(action, (entry.actions.get(action) ?? 0) + count);
    }

    for (const [cardName, entry] of perCard.entries()) {
      summaries.push({
        cardName,
        owner,
        total: entry.total,
        actions: sortRecord(toRecord(entry.actions)),
      });
    }
  }

  return summaries.sort((a, b) => b.total - a.total || a.owner.localeCompare(b.owner) || a.cardName.localeCompare(b.cardName));
}

function toRecord(map: Map<string, number>) {
  return Object.fromEntries(map.entries());
}

function sumMap(map: Map<string, number>) {
  return Array.from(map.values()).reduce((sum, value) => sum + value, 0);
}

function sortRecord(record: Record<string, number>) {
  return Object.fromEntries(Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function buildFinalScore(players: string[], games: GameSummary[]) {
  if (players.length < 2) {
    return null;
  }

  const wins = new Map<string, number>(players.map((player) => [player, 0]));
  for (const game of games) {
    if (game.winner) {
      wins.set(game.winner, (wins.get(game.winner) ?? 0) + 1);
    }
  }

  const [player1, player2] = players;
  return `(${wins.get(player1) ?? 0}-${wins.get(player2) ?? 0}-0)`;
}

function inferArchetypeForPlayer(player: string, overallCards: Map<string, Map<string, number>>) {
  const ownerMap = overallCards.get(player);
  if (!ownerMap) {
    return null;
  }

  const phraseScores = new Map<string, number>();
  for (const [compositeKey, count] of ownerMap.entries()) {
    const [cardName] = compositeKey.split("|||");
    for (const phrase of extractArchetypePhrases(cardName)) {
      phraseScores.set(phrase, (phraseScores.get(phrase) ?? 0) + count);
    }
  }

  const best = Array.from(phraseScores.entries()).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
  return best?.[0] ?? null;
}

function extractArchetypePhrases(cardName: string) {
  const phrases = new Set<string>();

  const quoted = Array.from(cardName.matchAll(/"([^"]+)"/g)).map((match) => match[1]?.trim()).filter(Boolean) as string[];
  for (const phrase of quoted) {
    if (phrase.length >= 3) {
      phrases.add(phrase);
    }
  }

  const beforeDash = cardName.split(" - ")[0]?.trim();
  if (beforeDash && beforeDash.split(" ").length >= 2) {
    phrases.add(beforeDash);
    const firstTwo = beforeDash.split(/\s+/).slice(0, 2).join(" ");
    if (firstTwo.length >= 3) {
      phrases.add(firstTwo);
    }
  }

  const tokens = cardName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const pair = `${tokens[index]} ${tokens[index + 1]}`;
    if (isUsefulPhrase(pair)) {
      phrases.add(pair);
    }
  }

  return Array.from(phrases).filter(isUsefulPhrase);
}

function isUsefulPhrase(phrase: string) {
  const tokens = phrase
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return false;
  }

  return tokens.some((token) => !ARCHETYPE_STOPWORDS.has(token) && token.length >= 3);
}

function buildInsights(input: {
  games: GameSummary[];
  finalWinner: string | null;
  finalScore: string | null;
  turnsObserved: number;
  overallRealPlayBreakdown: Map<string, number>;
  overallCards: Map<string, Map<string, number>>;
}) {
  const insights: string[] = [];
  const finalWinner = input.finalWinner ?? "Unknown winner";
  const finalScore = input.finalScore ?? "unknown score";
  insights.push(`${finalWinner} won the match with final tracked score ${finalScore}.`);
  insights.push(`The log contains ${input.games.length} duels inside the match and ${input.turnsObserved} explicit start-turn markers.`);

  const cardSummaries = flattenTopCards(input.overallCards);
  const topCard = cardSummaries[0];
  if (topCard) {
    insights.push(`${topCard.owner}'s most repeatedly seen card was ${topCard.cardName} (${topCard.total} tracked card events).`);
  }

  const mostCommonPlay = Object.entries(toRecord(input.overallRealPlayBreakdown)).sort((a, b) => b[1] - a[1])[0];
  if (mostCommonPlay) {
    insights.push(`The most common real play type was ${mostCommonPlay[0]} (${mostCommonPlay[1]} times).`);
  }

  const sideCount = input.overallRealPlayBreakdown.get("Siding") ?? 0;
  if (sideCount > 0) {
    insights.push(`The match definitely went beyond game 1 because siding happened ${sideCount} time(s).`);
  }

  const longestGame = [...input.games].sort((a, b) => b.realPlays - a.realPlays)[0];
  if (longestGame) {
    insights.push(`Game ${longestGame.gameNumber} had the highest action count with ${longestGame.realPlays} filtered real plays.`);
  }

  return insights;
}
