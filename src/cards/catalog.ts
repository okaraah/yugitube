import { type ScraperDatabase } from "../storage/database.js";

const CARDS_URL = "https://static.duelingbook.com/cards.json";

export type CatalogCardRecord = {
  cardId: number;
  name: string;
  treatedAs: string | null;
  cardType: string | null;
  attribute: string | null;
  typeLine: string | null;
  rawJson: string;
};

export async function fetchCardsCatalog() {
  const response = await fetch(CARDS_URL, {
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      Origin: "https://www.duelingbook.com",
      Referer: "https://www.duelingbook.com/",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`cards.json fetch failed with status ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  return normalizeCardsCatalog(payload);
}

export async function syncCardsCatalog(db: ScraperDatabase) {
  const cards = await fetchCardsCatalog();
  db.upsertCardsCatalog(cards);
  return cards.length;
}

function normalizeCardsCatalog(payload: unknown): CatalogCardRecord[] {
  const entries: Array<[string, Record<string, unknown>]> = [];

  const cardPayload =
    payload && typeof payload === "object" && Array.isArray((payload as { cards?: unknown }).cards)
      ? (payload as { cards: unknown[] }).cards
      : payload;

  if (Array.isArray(cardPayload)) {
    cardPayload.forEach((value, index) => {
      if (value && typeof value === "object") {
        entries.push([String(index), value as Record<string, unknown>]);
      }
    });
  } else if (cardPayload && typeof cardPayload === "object") {
    for (const [key, value] of Object.entries(cardPayload)) {
      if (value && typeof value === "object") {
        entries.push([key, value as Record<string, unknown>]);
      }
    }
  }

  return entries
    .map(([key, value]) => {
      const derivedId = Number(value.id ?? key);
      if (!Number.isFinite(derivedId)) {
        return null;
      }

      return {
        cardId: derivedId,
        name:
          typeof value.name === "string"
            ? value.name
            : typeof value.n === "string"
              ? value.n
              : `Card ${derivedId}`,
        treatedAs: typeof value.treated_as === "string" ? value.treated_as : null,
        cardType:
          typeof value.card_type === "string"
            ? value.card_type
            : typeof value.c === "string"
              ? value.c
              : null,
        attribute:
          typeof value.attribute === "string"
            ? value.attribute
            : typeof value.a === "string"
              ? value.a
              : null,
        typeLine:
          typeof value.type === "string"
            ? value.type
            : typeof value.typ === "string"
              ? value.typ
              : null,
        rawJson: JSON.stringify(value),
      };
    })
    .filter((record): record is CatalogCardRecord => record !== null);
}
