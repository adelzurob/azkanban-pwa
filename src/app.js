// AZKanban PWA — entry point.
//
// Build-sequence step 2: sign in, fetch boards.json from OneDrive, render a
// read-only list of boards. Card view, edit, archive, search, push come in
// later steps.

import { initAuth, signIn, signOut, getActiveAccount } from "./auth.js";
import { fetchBoards, fetchETag } from "./graph.js";
import { persistSnapshot, loadSnapshot, setState, subscribe } from "./store.js";
import { config } from "./config.js";

const els = {
  signinScreen: document.getElementById("signin-screen"),
  boardsScreen: document.getElementById("boards-screen"),
  errorScreen: document.getElementById("error-screen"),
  signinBtn: document.getElementById("signin-btn"),
  signinError: document.getElementById("signin-error"),
  signoutBtn: document.getElementById("signout-btn"),
  retryBtn: document.getElementById("retry-btn"),
  errorMessage: document.getElementById("error-message"),
  boardsList: document.getElementById("boards-list"),
  syncIndicator: document.getElementById("sync-indicator"),
};

function showScreen(screen) {
  for (const s of [els.signinScreen, els.boardsScreen, els.errorScreen]) {
    s.hidden = s !== screen;
  }
}

function showError(messageText) {
  els.errorMessage.textContent = messageText;
  showScreen(els.errorScreen);
}

function setSyncStatus(status) {
  els.syncIndicator.dataset.status = status;
}

function renderBoards(data) {
  // Clear children safely — never use innerHTML with data we received from a
  // remote source, even our own.
  while (els.boardsList.firstChild) {
    els.boardsList.removeChild(els.boardsList.firstChild);
  }

  if (!data || !Array.isArray(data.boards) || data.boards.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No boards yet. Create one on your desktop to see it here.";
    els.boardsList.appendChild(empty);
    return;
  }

  const activeBoards = data.boards.filter((b) => !b.archived);

  for (const board of activeBoards) {
    const cardCount = (board.columns || []).reduce(
      (n, col) => n + (col.cards || []).filter((c) => !c.archived).length,
      0
    );

    const btn = document.createElement("button");
    btn.className = "board-card";
    btn.type = "button";
    btn.dataset.boardId = board.id;
    btn.disabled = true; // re-enabled in step 3 when card view ships
    btn.title = "Card view coming soon";

    const icon = document.createElement("span");
    icon.className = "board-icon";
    icon.textContent = board.icon || "📋";
    btn.appendChild(icon);

    const info = document.createElement("div");
    info.className = "board-info";

    const name = document.createElement("div");
    name.className = "board-name";
    name.textContent = board.name || "Untitled";
    info.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "board-meta";
    const cols = (board.columns || []).length;
    meta.textContent =
      `${cols} column${cols === 1 ? "" : "s"} · ${cardCount} card${cardCount === 1 ? "" : "s"}`;
    info.appendChild(meta);

    btn.appendChild(info);
    els.boardsList.appendChild(btn);
  }
}

async function loadAndRender() {
  setSyncStatus("checking");
  try {
    const { data, eTag } = await fetchBoards();
    if (data) {
      setState(data, eTag);
      await persistSnapshot(data, eTag);
      setSyncStatus("synced");
    } else {
      // No file yet — show empty state.
      setState({ boards: [] }, null);
      setSyncStatus("synced");
    }
  } catch (err) {
    console.error("Initial load failed:", err);
    setSyncStatus("error");
    // Fall back to last cached snapshot if we have one.
    const cached = await loadSnapshot();
    if (cached) {
      setState(cached.data, cached.eTag);
      // Stay on boards screen with stale data + warning.
    } else {
      showError(
        "Couldn't load your boards. Check your network connection and try again."
      );
      throw err;
    }
  }
}

let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const remoteETag = await fetchETag();
      const { eTag: localETag } = (await loadSnapshot()) || {};
      if (remoteETag && remoteETag !== localETag) {
        await loadAndRender();
      }
    } catch (err) {
      // Polling errors are non-fatal — log and let the next tick try again.
      console.warn("Poll check failed:", err);
    }
  }, config.pollIntervalMs);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function showBoards() {
  showScreen(els.boardsScreen);
  els.signoutBtn.hidden = false;

  // Subscribe to state changes for live re-render.
  subscribe(({ data }) => renderBoards(data));

  // First paint from cache (instant), then refresh from network.
  const cached = await loadSnapshot();
  if (cached) {
    setState(cached.data, cached.eTag);
  }

  await loadAndRender();
  startPolling();
}

async function bootstrap() {
  // Sanity-check config presence before anything else.
  if (!config.clientId || config.clientId === "REPLACE_WITH_YOUR_CLIENT_ID") {
    showError(
      "Configuration missing: copy src/config.template.js to src/config.js and " +
      "fill in your Azure app registration's client ID. See README for details."
    );
    return;
  }

  try {
    await initAuth();
  } catch (err) {
    showError(`Auth init failed: ${err.message}`);
    return;
  }

  if (getActiveAccount()) {
    await showBoards();
  } else {
    showScreen(els.signinScreen);
  }
}

els.signinBtn.addEventListener("click", async () => {
  els.signinError.hidden = true;
  els.signinBtn.disabled = true;
  try {
    await signIn();
    // signIn navigates away via redirect; on return, bootstrap will run again
    // and pick up the active account.
  } catch (err) {
    els.signinError.textContent = err.message || "Sign-in failed.";
    els.signinError.hidden = false;
    els.signinBtn.disabled = false;
  }
});

els.signoutBtn.addEventListener("click", async () => {
  stopPolling();
  await signOut();
});

els.retryBtn.addEventListener("click", () => {
  showScreen(els.signinScreen);
  bootstrap();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && getActiveAccount()) {
    loadAndRender().catch((err) => console.error("Refresh on focus failed:", err));
  }
});

window.addEventListener("offline", () => setSyncStatus("offline"));
window.addEventListener("online", () => {
  if (getActiveAccount()) {
    loadAndRender().catch((err) => console.error("Refresh on reconnect failed:", err));
  }
});

// Catch top-level errors during bootstrap.
bootstrap().catch((err) => {
  console.error("Bootstrap failed:", err);
  showError(`Startup error: ${err.message || String(err)}`);
});
