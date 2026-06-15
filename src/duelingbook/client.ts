export type LoginOptions = {
  username: string;
  password: string;
  rememberMe?: boolean;
};

export type LoginResponse = {
  action: string;
  user_id?: number;
  username?: string;
  password?: string;
  admin?: boolean;
  firstLogin?: boolean;
  logins?: unknown;
};

export type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expiresAt: number | null;
  secure: boolean;
  httpOnly: boolean;
};

const LOGIN_URL = "https://www.duelingbook.com/php-scripts/login-user.php";
const HOME_URL = "https://www.duelingbook.com/";
const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  constructor(initialCookies: StoredCookie[] = []) {
    for (const cookie of initialCookies) {
      this.set(cookie);
    }
  }

  toJSON() {
    return Array.from(this.cookies.values());
  }

  getCookieHeader(url: string) {
    return this.getCookiesForUrl(url)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  getCookieValue(url: string, name: string) {
    return this.getCookiesForUrl(url).find((cookie) => cookie.name === name)?.value ?? null;
  }

  applySetCookieHeaders(headers: Headers, originUrl: string) {
    const setCookieHeaders = this.readSetCookie(headers);

    for (const header of setCookieHeaders) {
      const parsed = parseSetCookie(header, originUrl);
      if (!parsed) {
        continue;
      }

      if (isExpiredCookie(parsed) || parsed.value === "deleted") {
        this.cookies.delete(cookieKey(parsed));
        continue;
      }

      this.set(parsed);
    }
  }

  private readSetCookie(headers: Headers) {
    const headerBag = headers as Headers & {
      getSetCookie?: () => string[];
    };

    if (typeof headerBag.getSetCookie === "function") {
      return headerBag.getSetCookie();
    }

    const combined = headers.get("set-cookie");
    return combined ? splitSetCookieHeader(combined) : [];
  }

  private set(cookie: StoredCookie) {
    this.cookies.set(cookieKey(cookie), cookie);
  }

  private getCookiesForUrl(url: string) {
    const target = new URL(url);
    const now = Date.now();

    return Array.from(this.cookies.values()).filter((cookie) => {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        return false;
      }

      const domain = cookie.domain.replace(/^\./, "");
      const hostname = target.hostname;
      const matchesDomain =
        hostname === domain || hostname.endsWith(`.${domain}`);
      const matchesPath = target.pathname.startsWith(cookie.path);
      const matchesSecure = !cookie.secure || target.protocol === "https:";

      return matchesDomain && matchesPath && matchesSecure;
    });
  }
}

export class DuelingBookClient {
  readonly cookieJar: CookieJar;

  constructor(cookieJar = new CookieJar()) {
    this.cookieJar = cookieJar;
  }

  async login(options: LoginOptions) {
    const body = new FormData();
    body.set("username", options.username);
    body.set("password", options.password);
    body.set("remember_me", options.rememberMe === false ? "0" : "1");

    const response = await fetch(LOGIN_URL, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: "*/*",
        Origin: "https://www.duelingbook.com",
        Referer: "https://www.duelingbook.com/",
        "User-Agent": DEFAULT_USER_AGENT,
        Cookie: this.cookieJar.getCookieHeader(LOGIN_URL),
      },
      body,
    });

    this.cookieJar.applySetCookieHeaders(response.headers, LOGIN_URL);

    const rawText = await response.text();
    let payload: LoginResponse;

    try {
      payload = JSON.parse(rawText) as LoginResponse;
    } catch {
      throw new Error(`Login response was not valid JSON: ${rawText.slice(0, 300)}`);
    }

    if (!response.ok) {
      throw new Error(`Login request failed with ${response.status}: ${rawText}`);
    }

    if (payload.action !== "Logged in") {
      throw new Error(`Login was rejected: ${rawText}`);
    }

    return payload;
  }

  async verifySession() {
    const response = await fetch(HOME_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": DEFAULT_USER_AGENT,
        Cookie: this.cookieJar.getCookieHeader(HOME_URL),
      },
    });

    const html = await response.text();
    const isAuthenticated =
      response.ok &&
      (html.includes('class="logout_btn"') || html.includes('value="Logout"'));

    const username =
      extractLoggedInUsername(html) ?? this.cookieJar.getCookieValue(HOME_URL, "username");

    return {
      ok: response.ok,
      isAuthenticated,
      username,
      status: response.status,
    };
  }
}

function extractLoggedInUsername(html: string) {
  const match = html.match(/<span id="username_txt"[^>]*>([^<]+)<\/span>/i);
  return match?.[1]?.trim() ?? null;
}

function parseSetCookie(header: string, originUrl: string): StoredCookie | null {
  const [nameValue, ...attributeParts] = header.split(";");
  const separatorIndex = nameValue.indexOf("=");

  if (separatorIndex <= 0) {
    return null;
  }

  const origin = new URL(originUrl);
  const name = nameValue.slice(0, separatorIndex).trim();
  const value = nameValue.slice(separatorIndex + 1).trim();

  const cookie: StoredCookie = {
    name,
    value,
    domain: origin.hostname,
    path: "/",
    expiresAt: null,
    secure: false,
    httpOnly: false,
  };

  for (const rawAttribute of attributeParts) {
    const [attributeName, ...attributeValueParts] = rawAttribute.trim().split("=");
    const attributeValue = attributeValueParts.join("=");
    const key = attributeName.toLowerCase();

    if (key === "domain" && attributeValue) {
      cookie.domain = attributeValue.toLowerCase();
      continue;
    }

    if (key === "path" && attributeValue) {
      cookie.path = attributeValue;
      continue;
    }

    if (key === "expires" && attributeValue) {
      const parsed = Date.parse(attributeValue);
      cookie.expiresAt = Number.isNaN(parsed) ? null : parsed;
      continue;
    }

    if (key === "max-age" && attributeValue) {
      const seconds = Number.parseInt(attributeValue, 10);
      cookie.expiresAt = Number.isNaN(seconds) ? null : Date.now() + seconds * 1000;
      continue;
    }

    if (key === "secure") {
      cookie.secure = true;
      continue;
    }

    if (key === "httponly") {
      cookie.httpOnly = true;
    }
  }

  return cookie;
}

function splitSetCookieHeader(header: string) {
  const parts: string[] = [];
  let current = "";
  let inExpires = false;

  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    current += character;

    if (current.toLowerCase().endsWith("expires=")) {
      inExpires = true;
      continue;
    }

    if (inExpires && character === ";") {
      inExpires = false;
      continue;
    }

    if (!inExpires && character === ",") {
      parts.push(current.slice(0, -1).trim());
      current = "";
    }
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function cookieKey(cookie: StoredCookie) {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`;
}

function isExpiredCookie(cookie: StoredCookie) {
  return cookie.expiresAt !== null && cookie.expiresAt <= Date.now();
}
