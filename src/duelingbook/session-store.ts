import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { CookieJar, type StoredCookie } from "./client.js";

export async function loadCookieJar(filePath: string) {
  try {
    const raw = await readFile(filePath, "utf8");
    const cookies = JSON.parse(raw) as StoredCookie[];
    return new CookieJar(cookies);
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException;

    if (typedError.code === "ENOENT") {
      return new CookieJar();
    }

    throw error;
  }
}

export async function saveCookieJar(filePath: string, cookieJar: CookieJar) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(cookieJar.toJSON(), null, 2) + "\n", "utf8");
}
