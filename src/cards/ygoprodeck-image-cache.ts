import { extname } from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const API_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const REQUEST_CHUNK_SIZE = 20;

type CacheEntry = {
  fileName: string;
  sourceUrl: string;
  fetchedAt: string;
};

type CardImage = {
  id?: number;
  image_url?: string;
  image_url_small?: string;
  image_url_cropped?: string;
};

type CardInfoResponse = {
  data?: Array<{
    name?: string;
    card_images?: CardImage[];
  }>;
};

type VariantConfig = {
  prefix: string;
  indexKey: string;
  index: Map<string, CacheEntry>;
  publicPrefix: string;
  loaded: boolean;
  selectUrl: (image: CardImage) => string | undefined;
};

export class YgoProDeckImageCache {
  private s3: S3Client | null = null;
  private bucket: string;
  private publicUrl: string;

  private readonly smallVariant: VariantConfig;
  private readonly croppedVariant: VariantConfig;

  constructor() {
    this.bucket = process.env.R2_BUCKET_NAME || "yugitube-images";
    this.publicUrl = process.env.R2_PUBLIC_URL ? process.env.R2_PUBLIC_URL.replace(/\/$/, "") : "";

    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (accountId && accessKeyId && secretAccessKey) {
      this.s3 = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
    }

    this.smallVariant = {
      prefix: "ygoprodeck/",
      indexKey: "ygoprodeck/index.json",
      index: new Map(),
      publicPrefix: `${this.publicUrl}/ygoprodeck/`,
      loaded: false,
      selectUrl: (img) => img.image_url_small ?? img.image_url,
    };

    this.croppedVariant = {
      prefix: "ygoprodeck-cropped/",
      indexKey: "ygoprodeck-cropped/index.json",
      index: new Map(),
      publicPrefix: `${this.publicUrl}/ygoprodeck-cropped/`,
      loaded: false,
      selectUrl: (img) => img.image_url_cropped,
    };
  }

  async getPublicPaths(names: string[]) {
    return this.resolvePublicPaths(names, this.smallVariant);
  }

  async getCroppedPublicPaths(names: string[]) {
    return this.resolvePublicPaths(names, this.croppedVariant);
  }

  private async resolvePublicPaths(names: string[], variant: VariantConfig) {
    if (!this.s3) {
      // If S3 is not configured, just return null for everything.
      const result = new Map<string, string | null>();
      for (const name of names) {
        result.set(name, null);
      }
      return result;
    }

    await this.loadIndex(variant);

    const uniqueNames = Array.from(new Set(names)).filter(Boolean);
    const missingNames: string[] = [];
    const result = new Map<string, string | null>();

    for (const name of uniqueNames) {
      const existing = variant.index.get(name);
      if (existing) {
        // Assume file exists in R2 if it's in the index to avoid many HeadObject calls.
        result.set(name, `${variant.publicPrefix}${encodeURIComponent(existing.fileName)}`);
        continue;
      }

      missingNames.push(name);
    }

    if (missingNames.length > 0) {
      for (const chunk of chunkNames(missingNames, REQUEST_CHUNK_SIZE)) {
        const fetched = await this.fetchAndCacheChunk(chunk, variant);
        for (const [name, publicPath] of fetched.entries()) {
          result.set(name, publicPath);
        }
      }

      await this.saveIndex(variant);
    }

    for (const name of uniqueNames) {
      if (!result.has(name)) {
        const existing = variant.index.get(name);
        result.set(name, existing ? `${variant.publicPrefix}${encodeURIComponent(existing.fileName)}` : null);
      }
    }

    return result;
  }

  private async loadIndex(variant: VariantConfig) {
    if (variant.loaded || !this.s3) {
      return;
    }

    variant.loaded = true;

    try {
      const response = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: variant.indexKey,
      }));
      
      const raw = await response.Body?.transformToString();
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
        for (const [name, entry] of Object.entries(parsed)) {
          if (entry?.fileName && entry?.sourceUrl) {
            variant.index.set(name, entry);
          }
        }
      }
    } catch {
      // Ignore errors (file might not exist yet)
    }
  }

  private async saveIndex(variant: VariantConfig) {
    if (!this.s3) return;

    const serialized = Object.fromEntries(variant.index.entries());
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: variant.indexKey,
      Body: JSON.stringify(serialized, null, 2),
      ContentType: "application/json",
    }));
  }

  private async fetchAndCacheChunk(names: string[], variant: VariantConfig) {
    const url = `${API_URL}?name=${encodeURIComponent(names.join("|"))}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      // Just log and return empty to avoid throwing and breaking the page
      console.warn(`YGOPRODeck card info failed with ${response.status}`);
      return new Map<string, string | null>();
    }

    const payload = (await response.json()) as CardInfoResponse;
    const result = new Map<string, string | null>();
    const seenNames = new Set<string>();

    for (const card of payload.data ?? []) {
      const name = typeof card.name === "string" ? card.name : null;
      const image = card.card_images?.[0];
      const sourceUrl = image ? (variant.selectUrl(image) ?? null) : null;
      const imageId = image?.id;

      if (!name || !sourceUrl || !imageId) {
        continue;
      }

      seenNames.add(name);
      const extension = extname(new URL(sourceUrl).pathname) || ".jpg";
      const fileName = `${imageId}${extension}`;
      const s3Key = `${variant.prefix}${fileName}`;

      if (!(await this.fileExists(s3Key))) {
        const imageResponse = await fetch(sourceUrl, {
          signal: AbortSignal.timeout(20_000),
        });

        if (!imageResponse.ok) {
          continue;
        }

        const arrayBuffer = await imageResponse.arrayBuffer();
        await this.s3?.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Body: new Uint8Array(arrayBuffer),
          ContentType: imageResponse.headers.get("content-type") || "image/jpeg",
          CacheControl: "public, max-age=31536000, immutable",
        }));
      }

      variant.index.set(name, {
        fileName,
        sourceUrl,
        fetchedAt: new Date().toISOString(),
      });
      result.set(name, `${variant.publicPrefix}${encodeURIComponent(fileName)}`);
    }

    for (const name of names) {
      if (!seenNames.has(name) && !result.has(name)) {
        result.set(name, null);
      }
    }

    return result;
  }

  private async fileExists(s3Key: string) {
    if (!this.s3) return false;
    try {
      await this.s3.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
      }));
      return true;
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
