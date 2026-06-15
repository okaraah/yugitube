import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

const API_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const CACHE_DIR = resolve(".runtime/card-images/ygoprodeck");
const INDEX_PATH = resolve(".runtime/card-images/ygoprodeck/index.json");
const REQUEST_CHUNK_SIZE = 20;

type CacheEntry = {
  fileName: string;
  sourceUrl: string;
  fetchedAt: string;
};

type CardInfoResponse = {
  data?: Array<{
    name?: string;
    card_images?: Array<{
      id?: number;
      image_url?: string;
      image_url_small?: string;
      image_url_cropped?: string;
    }>;
  }>;
};

export class YgoProDeckImageCache {
  private loaded = false;
  private readonly index = new Map<string, CacheEntry>();

  async getPublicPaths(names: string[]) {
    await this.loadIndex();

    const uniqueNames = Array.from(new Set(names)).filter(Boolean);
    const missingNames: string[] = [];
    const result = new Map<string, string | null>();

    for (const name of uniqueNames) {
      const existing = this.index.get(name);
      if (existing && (await this.fileExists(resolve(CACHE_DIR, existing.fileName)))) {
        result.set(name, `/card-images/${encodeURIComponent(existing.fileName)}`);
        continue;
      }

      missingNames.push(name);
    }

    if (missingNames.length > 0) {
      await mkdir(CACHE_DIR, { recursive: true });

      for (const chunk of chunkNames(missingNames, REQUEST_CHUNK_SIZE)) {
        const fetched = await this.fetchAndCacheChunk(chunk);
        for (const [name, publicPath] of fetched.entries()) {
          result.set(name, publicPath);
        }
      }

      await this.saveIndex();
    }

    for (const name of uniqueNames) {
      if (!result.has(name)) {
        const existing = this.index.get(name);
        result.set(name, existing ? `/card-images/${encodeURIComponent(existing.fileName)}` : null);
      }
    }

    return result;
  }

  getFilePath(fileName: string) {
    return resolve(CACHE_DIR, fileName);
  }

  private async loadIndex() {
    if (this.loaded) {
      return;
    }

    this.loaded = true;

    try {
      const raw = await readFile(INDEX_PATH, "utf8");
      const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
      for (const [name, entry] of Object.entries(parsed)) {
        if (entry?.fileName && entry?.sourceUrl) {
          this.index.set(name, entry);
        }
      }
    } catch {
      await mkdir(CACHE_DIR, { recursive: true });
    }
  }

  private async saveIndex() {
    const serialized = Object.fromEntries(this.index.entries());
    await writeFile(INDEX_PATH, JSON.stringify(serialized, null, 2), "utf8");
  }

  private async fetchAndCacheChunk(names: string[]) {
    const url = `${API_URL}?name=${encodeURIComponent(names.join("|"))}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`YGOPRODeck card info failed with ${response.status}`);
    }

    const payload = (await response.json()) as CardInfoResponse;
    const result = new Map<string, string | null>();
    const seenNames = new Set<string>();

    for (const card of payload.data ?? []) {
      const name = typeof card.name === "string" ? card.name : null;
      const image = card.card_images?.[0];
      const sourceUrl = image?.image_url_small ?? image?.image_url ?? null;
      const imageId = image?.id;

      if (!name || !sourceUrl || !imageId) {
        continue;
      }

      seenNames.add(name);
      const extension = extname(new URL(sourceUrl).pathname) || ".jpg";
      const fileName = `${imageId}${extension}`;
      const filePath = resolve(CACHE_DIR, fileName);

      if (!(await this.fileExists(filePath))) {
        const imageResponse = await fetch(sourceUrl, {
          signal: AbortSignal.timeout(20_000),
        });

        if (!imageResponse.ok) {
          continue;
        }

        const arrayBuffer = await imageResponse.arrayBuffer();
        await writeFile(filePath, new Uint8Array(arrayBuffer));
      }

      this.index.set(name, {
        fileName,
        sourceUrl,
        fetchedAt: new Date().toISOString(),
      });
      result.set(name, `/card-images/${encodeURIComponent(fileName)}`);
    }

    for (const name of names) {
      if (!seenNames.has(name) && !result.has(name)) {
        result.set(name, null);
      }
    }

    return result;
  }

  private async fileExists(filePath: string) {
    try {
      const info = await stat(filePath);
      return info.isFile();
    } catch {
      return false;
    }
  }
}

function chunkNames(names: string[], size: number) {
  const chunks: string[][] = [];
  for (let index = 0; index < names.length; index += size) {
    chunks.push(names.slice(index, index + size));
  }
  return chunks;
}
