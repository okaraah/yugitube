export type QualifyingFilter = {
  duelType: string;
  duelFormat: string;
  duelRules: string;
  minRating: number;
};

export type PlayerSummary = {
  username: string;
  rating: number;
};

export type LobbyDuelSummary = {
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

export function summarizeLobbyDuel(duel: unknown): LobbyDuelSummary {
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

export function matchesQualifyingFilter(duel: LobbyDuelSummary, filter: QualifyingFilter) {
  return (
    duel.canWatch &&
    !duel.private &&
    duel.type === filter.duelType &&
    duel.format === filter.duelFormat &&
    duel.rules === filter.duelRules &&
    duel.playerOne.rating >= filter.minRating &&
    duel.playerTwo.rating >= filter.minRating
  );
}

function normalizePlayer(value: unknown): PlayerSummary {
  const player = (value ?? {}) as Record<string, unknown>;
  return {
    username: typeof player.u === "string" ? player.u : "unknown",
    rating: typeof player.r === "number" ? player.r : Number(player.r ?? 0),
  };
}
