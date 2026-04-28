// OneDrive Graph API client for boards.json.
//
// All requests use a fresh access token from auth.getAccessToken(). Reads return
// { data, eTag } so the caller can later send eTag back with PUT for optimistic
// concurrency. PUTs send `If-Match: <eTag>` and surface a typed conflict error
// on 412 so the UI can prompt the user to refresh.

import { getAccessToken } from "./auth.js";
import { config } from "./config.js";

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

// URL-encode each path segment but leave the slashes intact. Required because
// dataFilePath may contain spaces or other reserved characters that would
// confuse the Graph API path parser if sent raw.
function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

// Build the Graph API path for the configured data file.
function fileItemUrl(suffix = "") {
  // /me/drive/root:/<path>:<suffix> — the colon separates the path from the
  // operation. e.g. /me/drive/root:/AZKanban/boards.json:/content for content.
  return `${GRAPH_ROOT}/me/drive/root:${encodePath(config.dataFilePath)}${suffix}`;
}

// Custom error thrown when a PUT fails the eTag precondition. The caller is
// expected to refetch and either re-apply edits or discard them.
export class ConflictError extends Error {
  constructor(message = "Remote file changed since last read.") {
    super(message);
    this.name = "ConflictError";
    this.isConflict = true;
  }
}

// Generic Graph fetch with auth header. Returns the raw Response so the caller
// can inspect status/headers.
async function graphFetch(url, init = {}) {
  const token = await getAccessToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

/**
 * Fetch boards.json. Returns { data: object, eTag: string } on success.
 * Returns { data: null, eTag: null } if the file does not exist yet.
 * Throws on transport errors or non-404 4xx/5xx responses.
 */
export async function fetchBoards() {
  // First fetch metadata so we can grab the eTag (the /content endpoint doesn't
  // always reliably return one in headers across all OneDrive backends).
  const metaUrl = fileItemUrl();
  const metaRes = await graphFetch(metaUrl);

  if (metaRes.status === 404) {
    return { data: null, eTag: null };
  }
  if (!metaRes.ok) {
    throw new Error(`Failed to fetch metadata: ${metaRes.status} ${metaRes.statusText}`);
  }

  const meta = await metaRes.json();
  // OneDrive returns the strong eTag at meta.eTag; the cTag changes on content
  // edits but not metadata edits. We use eTag because Graph PUT honors If-Match
  // against eTag, not cTag.
  const eTag = meta.eTag || null;

  const contentUrl = fileItemUrl(":/content");
  const contentRes = await graphFetch(contentUrl);

  if (!contentRes.ok) {
    throw new Error(`Failed to fetch content: ${contentRes.status} ${contentRes.statusText}`);
  }

  let data = null;
  try {
    data = await contentRes.json();
  } catch (err) {
    throw new Error(`boards.json is not valid JSON: ${err.message}`);
  }

  return { data, eTag };
}

/**
 * Save boards.json with optimistic concurrency. Pass the eTag you received from
 * the most recent fetch. Returns the new eTag on success.
 *
 * Throws ConflictError on HTTP 412 (the file changed since you read it).
 * Throws Error on other failures.
 */
export async function saveBoards(data, eTag) {
  const url = fileItemUrl(":/content");
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (eTag) {
    // Strong-match preconditional update. OneDrive accepts the standard If-Match.
    headers.set("If-Match", eTag);
  }

  const res = await graphFetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(data, null, 2),
  });

  if (res.status === 412) {
    throw new ConflictError();
  }
  if (!res.ok) {
    throw new Error(`Failed to save: ${res.status} ${res.statusText}`);
  }

  // The PUT response is the updated DriveItem metadata; pull the new eTag from it.
  const meta = await res.json();
  return meta.eTag || null;
}

/**
 * Lightweight check for external changes. Returns the current eTag without
 * downloading the full content. Used by the polling loop.
 */
export async function fetchETag() {
  const metaUrl = fileItemUrl();
  const res = await graphFetch(metaUrl);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch metadata: ${res.status} ${res.statusText}`);
  }
  const meta = await res.json();
  return meta.eTag || null;
}
