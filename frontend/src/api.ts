import { API_ORIGIN, PAGES_ORIGIN } from "./config";

export type Screen = { id: string; name: string; url: string };

/** `?latency=` and `?fail=` on the app URL are passed through to every API call, for testing. */
function apiUrl(path: string): string {
  const url = new URL(path, API_ORIGIN);
  const params = new URLSearchParams(window.location.search);
  for (const key of ["latency", "fail"]) {
    const value = params.get(key);
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(apiUrl(path), { signal });
  const text = await res.text();
  if (!res.ok) throw new ApiError(`GET ${path} failed with ${res.status}`, res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`GET ${path} returned a malformed body`, res.status);
  }
}

function isScreen(value: unknown): value is Screen {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.name !== "string" || typeof s.url !== "string") {
    return false;
  }
  try {
    // Only pages on the preview origin can run our agent and be talked to.
    return new URL(s.url).origin === PAGES_ORIGIN;
  } catch {
    return false;
  }
}

export async function fetchScreens(signal: AbortSignal): Promise<Screen[]> {
  const data = await getJson("/screens", signal);
  if (!Array.isArray(data) || !data.every(isScreen)) {
    throw new ApiError("GET /screens returned unexpected data", 200);
  }
  return data;
}
