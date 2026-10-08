import { API_ORIGIN, PAGES_ORIGIN } from "./config";
import { takeFault, type Fault } from "./failures/devFaults";

export type Screen = { id: string; name: string; url: string };

/**
 * `?latency=` and `?fail=` on the app URL are passed through to every API call, for testing.
 * An armed dev fault makes this one request fail on the server.
 */
function apiUrl(path: string, fault: Fault): string {
  const url = new URL(path, API_ORIGIN);
  const params = new URLSearchParams(window.location.search);
  for (const key of ["latency", "fail"]) {
    const value = params.get(key);
    if (value !== null) url.searchParams.set(key, value);
  }
  if (takeFault(fault)) url.searchParams.set("fail", "1");
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

async function getJson(path: string, signal: AbortSignal, fault: Fault): Promise<unknown> {
  const res = await fetch(apiUrl(path, fault), { signal });
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

export type ElementDetails = { component: string; description: string; status: string; owner: string };

function isElementDetails(value: unknown): value is ElementDetails {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return [d.component, d.description, d.status, d.owner].every((v) => typeof v === "string");
}

/** Resolves to null when the API has no details for the key (404), which is not an error. */
export async function fetchElementDetails(key: string, signal: AbortSignal): Promise<ElementDetails | null> {
  const path = `/elements/${encodeURIComponent(key)}`;
  let data: unknown;
  try {
    data = await getJson(path, signal, "details");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  if (!isElementDetails(data)) throw new ApiError(`GET ${path} returned unexpected data`, 200);
  return data;
}

export async function fetchScreens(signal: AbortSignal): Promise<Screen[]> {
  const data = await getJson("/screens", signal, "screens");
  if (!Array.isArray(data) || !data.every(isScreen)) {
    throw new ApiError("GET /screens returned unexpected data", 200);
  }
  return data;
}
