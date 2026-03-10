/**
 * OAuth Usage API - Reads rate limit usage data.
 *
 * Primary source: OMC's shared usage cache file at
 * ~/.claude/plugins/oh-my-claudecode/.usage-cache.json (maintained by OMC's HUD).
 *
 * Fallback: Direct API call to api.anthropic.com/api/oauth/usage with
 * 429 handling, exponential backoff, and stale-data serving.
 */

import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import https from "https";
import { join } from "path";
import { homedir } from "os";

// ── Types ────────────────────────────────────────────────────────────

export interface OAuthRateLimits {
  fiveHourPercent: number;
  fiveHourResetsAt: number | null; // epoch ms
  weeklyPercent: number | null;
  weeklyResetsAt: number | null; // epoch ms
}

interface UsageApiResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
}

interface FetchResult {
  data: UsageApiResponse | null;
  rateLimited?: boolean;
}

interface OAuthCredentials {
  accessToken: string;
  expiresAt?: number;
}

// ── Cache ────────────────────────────────────────────────────────────

const OMC_CACHE_MAX_AGE_MS = 300_000; // Accept OMC cache up to 5 minutes old
const CACHE_TTL_SUCCESS_MS = 90_000;
const CACHE_TTL_FAILURE_MS = 15_000;
const CACHE_TTL_RATE_LIMITED_MS = 120_000;
const MAX_RATE_LIMITED_BACKOFF_MS = 600_000;
const API_TIMEOUT_MS = 10_000;

let cachedResult: {
  data: OAuthRateLimits | null;
  timestamp: number;
  ttl: number;
  rateLimitedCount: number;
} | null = null;

// ── OMC shared cache ─────────────────────────────────────────────────

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * Read OMC's usage cache file. Returns parsed data if fresh enough.
 */
function readOmcCache(): OAuthRateLimits | null {
  try {
    const cachePath = join(
      getClaudeConfigDir(),
      "plugins",
      "oh-my-claudecode",
      ".usage-cache.json",
    );
    if (!existsSync(cachePath)) return null;
    const content = readFileSync(cachePath, "utf-8");
    const parsed = JSON.parse(content);

    // Check freshness
    if (typeof parsed.timestamp !== "number") return null;
    if (Date.now() - parsed.timestamp > OMC_CACHE_MAX_AGE_MS) return null;

    // Must have data
    const data = parsed.data;
    if (!data || typeof data !== "object") return null;
    if (typeof data.fiveHourPercent !== "number" && typeof data.weeklyPercent !== "number")
      return null;

    const parseDate = (dateStr: unknown): number | null => {
      if (typeof dateStr !== "string") return null;
      const ms = Date.parse(dateStr);
      return isNaN(ms) ? null : ms;
    };

    return {
      fiveHourPercent: typeof data.fiveHourPercent === "number" ? data.fiveHourPercent : 0,
      fiveHourResetsAt: parseDate(data.fiveHourResetsAt),
      weeklyPercent: typeof data.weeklyPercent === "number" ? data.weeklyPercent : null,
      weeklyResetsAt: parseDate(data.weeklyResetsAt),
    };
  } catch {
    return null;
  }
}

// ── Credentials ──────────────────────────────────────────────────────

function getKeychainServiceName(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
    return `Claude Code-credentials-${hash}`;
  }
  return "Claude Code-credentials";
}

function readKeychainCredentials(): OAuthCredentials | null {
  if (process.platform !== "darwin") return null;
  try {
    const serviceName = getKeychainServiceName();
    const result = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", serviceName, "-w"],
      { encoding: "utf-8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!result) return null;
    const parsed = JSON.parse(result);
    const creds = parsed.claudeAiOauth || parsed;
    if (creds.accessToken) {
      return { accessToken: creds.accessToken, expiresAt: creds.expiresAt };
    }
  } catch {
    // Keychain access failed
  }
  return null;
}

function readFileCredentials(): OAuthCredentials | null {
  try {
    const credPath = join(getClaudeConfigDir(), ".credentials.json");
    if (!existsSync(credPath)) return null;
    const content = readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(content);
    const creds = parsed.claudeAiOauth || parsed;
    if (creds.accessToken) {
      return { accessToken: creds.accessToken, expiresAt: creds.expiresAt };
    }
  } catch {
    // File read failed
  }
  return null;
}

function getCredentials(): OAuthCredentials | null {
  const creds = readKeychainCredentials() ?? readFileCredentials();
  if (!creds) return null;
  if (creds.expiresAt != null && creds.expiresAt <= Date.now()) return null;
  return creds;
}

// ── API call (fallback) ──────────────────────────────────────────────

function fetchUsage(accessToken: string): Promise<FetchResult> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/api/oauth/usage",
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
        },
        timeout: API_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              resolve({ data: JSON.parse(data) });
            } catch {
              resolve({ data: null });
            }
          } else if (res.statusCode === 429) {
            resolve({ data: null, rateLimited: true });
          } else {
            resolve({ data: null });
          }
        });
      },
    );
    req.on("error", () => resolve({ data: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ data: null });
    });
    req.end();
  });
}

// ── Parse API response ──────────────────────────────────────────────

function clamp(v: number | undefined): number {
  if (v == null || !isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function parseResponse(response: UsageApiResponse): OAuthRateLimits | null {
  const fiveHour = response.five_hour?.utilization;
  const sevenDay = response.seven_day?.utilization;
  if (fiveHour == null && sevenDay == null) return null;

  const parseDate = (dateStr: string | undefined): number | null => {
    if (!dateStr) return null;
    const ms = Date.parse(dateStr);
    return isNaN(ms) ? null : ms;
  };

  return {
    fiveHourPercent: clamp(fiveHour),
    fiveHourResetsAt: parseDate(response.five_hour?.resets_at),
    weeklyPercent: sevenDay != null ? clamp(sevenDay) : null,
    weeklyResetsAt: parseDate(response.seven_day?.resets_at),
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Get rate limit usage. Reads OMC's shared cache first (zero API calls),
 * falls back to direct Anthropic OAuth API with 429 backoff.
 */
export async function getOAuthRateLimits(): Promise<OAuthRateLimits | null> {
  // 1. Try OMC's shared cache (fast, no network, no 429 risk)
  const omcData = readOmcCache();
  if (omcData) {
    cachedResult = {
      data: omcData,
      timestamp: Date.now(),
      ttl: CACHE_TTL_SUCCESS_MS,
      rateLimitedCount: 0,
    };
    return omcData;
  }

  // 2. Check our own in-memory cache
  if (cachedResult && Date.now() - cachedResult.timestamp < cachedResult.ttl) {
    return cachedResult.data;
  }

  // 3. Fallback: direct API call
  const creds = getCredentials();
  if (!creds) {
    cachedResult = {
      data: null,
      timestamp: Date.now(),
      ttl: CACHE_TTL_FAILURE_MS,
      rateLimitedCount: 0,
    };
    return null;
  }

  const result = await fetchUsage(creds.accessToken);

  if (result.rateLimited) {
    const prevCount = cachedResult?.rateLimitedCount ?? 0;
    const newCount = prevCount + 1;
    const backoffTtl = Math.min(
      CACHE_TTL_RATE_LIMITED_MS * 2 ** (newCount - 1),
      MAX_RATE_LIMITED_BACKOFF_MS,
    );
    const staleData = cachedResult?.data ?? null;
    cachedResult = {
      data: staleData,
      timestamp: Date.now(),
      ttl: backoffTtl,
      rateLimitedCount: newCount,
    };
    return staleData;
  }

  if (!result.data) {
    cachedResult = {
      data: null,
      timestamp: Date.now(),
      ttl: CACHE_TTL_FAILURE_MS,
      rateLimitedCount: 0,
    };
    return null;
  }

  const parsed = parseResponse(result.data);
  cachedResult = {
    data: parsed,
    timestamp: Date.now(),
    ttl: CACHE_TTL_SUCCESS_MS,
    rateLimitedCount: 0,
  };
  return parsed;
}
