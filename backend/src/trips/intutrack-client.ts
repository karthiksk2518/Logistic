import { z } from "zod";

const baseUrl = process.env.INTUTRACK_BASE_URL || "https://sct.intutrack.com/api/prod";
const username = process.env.INTUTRACK_USERNAME || "";
const password = process.env.INTUTRACK_PASSWORD || "";
const timeoutMs = Number.parseInt(process.env.INTUTRACK_TIMEOUT || "120000", 10);

type HttpMethod = "GET" | "POST" | "PUT";
type AuthMode = "basic" | "bearer";

type RequestOptions = {
  method?: HttpMethod;
  auth?: AuthMode;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
};

type TokenCache = {
  token: string;
  expiresAt: number;
};

let cachedToken: TokenCache | null = null;

const loginResponseSchema = z.object({
  token: z.string(),
});

function base64UrlToBase64(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return padded + "=".repeat((4 - (padded.length % 4)) % 4);
}

function decodeJwtExpiry(token: string) {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  const decoded = Buffer.from(base64UrlToBase64(payload), "base64").toString("utf8");
  const json = JSON.parse(decoded);
  if (typeof json.exp !== "number") return 0;
  return json.exp * 1000;
}

function basicAuthHeader() {
  if (!username || !password) {
    throw new Error("INTUTRACK_USERNAME and INTUTRACK_PASSWORD must be set");
  }
  const encoded = Buffer.from(`${username}:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

async function getIntuTrackToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60000) {
    return cachedToken.token;
  }
  const response = await intutrackRequest("/login", { method: "POST", auth: "basic" });
  const parsed = loginResponseSchema.parse(response);
  const expiresAt = decodeJwtExpiry(parsed.token) || Date.now() + 55 * 60 * 1000;
  cachedToken = { token: parsed.token, expiresAt };
  return parsed.token;
}

async function intutrackRequest(path: string, options: RequestOptions = {}) {
  const url = new URL(`${baseUrl}${path}`);
  if (options.query) {
    Object.entries(options.query).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const headers: Record<string, string> = {};
  const method = options.method || "GET";
  const auth = options.auth || "bearer";

  if (auth === "basic") {
    headers.Authorization = basicAuthHeader();
  } else {
    const token = await getIntuTrackToken();
    headers.Authorization = `Bearer ${token}`;
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    const contentType = res.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") && text ? JSON.parse(text) : text;

    if (!res.ok) {
      const error = new Error(`IntuTrack request failed with status ${res.status}`);
      (error as Error & { status?: number; payload?: unknown }).status = res.status;
      (error as Error & { status?: number; payload?: unknown }).payload = payload;
      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function startTrip(payload: Record<string, unknown>) {
  return intutrackRequest("/trips/start", { method: "POST", body: payload, auth: "bearer" });
}

export async function submitTrip(payload: Record<string, unknown>) {
  return intutrackRequest("/trips/submit", { method: "POST", body: payload, auth: "bearer" });
}

export async function updateTrip(payload: Record<string, unknown>) {
  return intutrackRequest("/trips/", { method: "PUT", body: payload, auth: "basic" });
}

export async function endTrip(intutrackTripId: string) {
  return intutrackRequest(`/trips/end/${intutrackTripId}`, { method: "POST", auth: "basic" });
}

export async function generatePublicLink(tripId: string) {
  return intutrackRequest("/trips/generatepubliclink", {
    method: "POST",
    body: { tripId },
    auth: "basic",
  });
}

export async function getConsents(tel: string) {
  return intutrackRequest("/consents", { method: "GET", query: { tel }, auth: "bearer" });
}

export async function getLocations(tripId: string, limit?: number) {
  return intutrackRequest("/status", { method: "GET", query: { tripId, limit }, auth: "bearer" });
}
