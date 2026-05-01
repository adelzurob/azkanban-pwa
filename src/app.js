// AZKanban PWA — entry point.
//
// Handles bootstrap (auth + initial fetch), navigation between five views
// (boards list / board detail / card detail / archive / search), debounced
// writes back to OneDrive via Graph with eTag-based optimistic concurrency,
// conflict recovery, offline edit queue with replay-on-reconnect, and
// cache-first cold-start rendering from IndexedDB.

import { initAuth, signIn, signOut, getActiveAccount } from "./auth.js";
import {
  fetchBoards, fetchETag, saveBoards, ConflictError,
} from "./graph.js";
import {
  persistSnapshot, loadSnapshot, setState, setStateSilent, getState, subscribe,
  queuePending, loadPending, clearPending,
} from "./store.js";
import { config } from "./config.js";
import {
  archiveCard, unarchiveCard, deleteCard, addCard, moveCard,
  updateCardFields, toggleSubtask, addSubtask, deleteSubtask,
  updateSubtaskTitle, stampLastModified, addTag, removeTag,
} from "./mutations.js";
import { renderBoardDetail } from "./ui/board.js";
import { renderCardDetail } from "./ui/card.js";
import { renderArchive } from "./ui/archive.js";
import { renderSearch } from "./ui/search.js";

// ---------------------------------------------------------------------------
// DOM references — gathered once at module load.
// ---------------------------------------------------------------------------

const els = {
  signinScreen:        document.getElementById("signin-screen"),
  boardsScreen:        document.getElementById("boards-screen"),
  boardDetailScreen:   document.getElementById("board-detail-screen"),
  cardDetailScreen:    document.getElementById("card-detail-screen"),
  archiveScreen:       document.getElementById("archive-screen"),
  searchScreen:        document.getElementById("search-screen"),
  errorScreen:         document.getElementById("error-screen"),
  signinBtn:           document.getElementById("signin-btn"),
  signinError:         document.getElementById("signin-error"),
  signoutBtn:          document.getElementById("signout-btn"),
  retryBtn:            document.getElementById("retry-btn"),
  errorMessage:        document.getElementById("error-message"),
  boardsList:          document.getElementById("boards-list"),
  boardsToolbar:       document.getElementById("boards-toolbar"),
  searchOpenBtn:       document.getElementById("search-open-btn"),
  archiveOpenBtn:      document.getElementById("archive-open-btn"),
  boardDetailHeader:   document.getElementById("board-detail-header"),
  boardDetailRoot:     document.getElementById("board-detail-root"),
  cardDetailHeader:    document.getElementById("card-detail-header"),
  cardDetailRoot:      document.getElementById("card-detail-root"),
  archiveHeader:       document.getElementById("archive-header"),
  archiveRoot:         document.getElementById("archive-root"),
  searchHeader:        document.getElementById("search-header"),
  searchRoot:          document.getElementById("search-root"),
  syncIndicator:       document.getElementById("sync-indicator"),
  backBtn:             document.getElementById("back-btn"),
  offlineBanner:       document.getElementById("offline-banner"),
};

// ---------------------------------------------------------------------------
// View routing — simple state machine, no URL hashes.
// ---------------------------------------------------------------------------

// view = { name: "list" }
//      | { name: "board", boardId: "..." }
//      | { name: "card",  cardId: "...", boardId: "..." }
//      | { name: "archive" }
//      | { name: "search" }
let view = { name: "list" };

// Where to send the user when they tap Back from a card detail screen.
// Cards can be reached from a board view, the archive view, or search;
// remembering the source keeps Back natural.
let cardOrigin = "board"; // "board" | "archive" | "search"

const ALL_SCREENS = [
  els.signinScreen,
  els.boardsScreen,
  els.boardDetailScreen,
  els.cardDetailScreen,
  els.archiveScreen,
  els.searchScreen,
  els.errorScreen,
];

function showScreen(target) {
  for (const s of ALL_SCREENS) s.hidden = s !== target;
}

function updateBackButton() {
  // Back button is meaningful on every screen except the boards list and the
  // sign-in/error screens.
  els.backBtn.hidden = !(
    view.name === "board" ||
    view.name === "card" ||
    view.name === "archive" ||
    view.name === "search"
  );
}

function navigateToBoard(boardId) {
  view = { name: "board", boardId };
  updateBackButton();
  renderCurrentView();
}

function navigateToCard(cardId, boardId) {
  view = { name: "card", cardId, boardId };
  updateBackButton();
  renderCurrentView();
}

function navigateToArchive() {
  view = { name: "archive" };
  cardOrigin = "archive";
  updateBackButton();
  renderCurrentView();
}

function navigateToSearch() {
  view = { name: "search" };
  cardOrigin = "search";
  updateBackButton();
  renderCurrentView();
}

function navigateBack() {
  if (view.name === "card") {
    if (cardOrigin === "archive") {
      view = { name: "archive" };
    } else if (cardOrigin === "search") {
      view = { name: "search" };
    } else {
      view = { name: "board", boardId: view.boardId };
    }
  } else if (view.name === "board") {
    view = { name: "list" };
  } else if (view.name === "archive" || view.name === "search") {
    view = { name: "list" };
  }
  updateBackButton();
  renderCurrentView();
}

// ---------------------------------------------------------------------------
// Sync indicator
// ---------------------------------------------------------------------------

function setSyncStatus(status) {
  els.syncIndicator.dataset.status = status;
  // Fire-and-forget: the banner reflects the queue + onLine state, both of
  // which may have changed by the time the indicator does. Cheap enough to
  // re-evaluate on every status flip.
  if (status === "synced" || status === "pending" || status === "offline") {
    refreshOfflineBanner();
  }
}

// ---------------------------------------------------------------------------
// Top-level error helper
// ---------------------------------------------------------------------------

function showError(messageText) {
  els.errorMessage.textContent = messageText;
  showScreen(els.errorScreen);
  els.backBtn.hidden = true;
}

// ---------------------------------------------------------------------------
// Render dispatcher — called on every state change.
// ---------------------------------------------------------------------------

function renderCurrentView() {
  const { data } = getState();
  if (view.name === "list") {
    renderBoardList(data);
    showScreen(els.boardsScreen);
  } else if (view.name === "board") {
    renderBoardDetail(els.boardDetailRoot, els.boardDetailHeader, data, view.boardId, boardHandlers);
    showScreen(els.boardDetailScreen);
  } else if (view.name === "card") {
    renderCardDetail(els.cardDetailRoot, els.cardDetailHeader, data, view.cardId, cardHandlers);
    showScreen(els.cardDetailScreen);
  } else if (view.name === "archive") {
    renderArchive(els.archiveRoot, els.archiveHeader, data, archiveHandlers);
    showScreen(els.archiveScreen);
  } else if (view.name === "search") {
    renderSearch(els.searchRoot, els.searchHeader, data, searchHandlers);
    showScreen(els.searchScreen);
  }
}

function renderBoardList(data) {
  while (els.boardsList.firstChild) els.boardsList.removeChild(els.boardsList.firstChild);

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
    btn.addEventListener("click", () => navigateToBoard(board.id));

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

// ---------------------------------------------------------------------------
// Edit pipeline: mutate → schedule debounced save → push to OneDrive.
// ---------------------------------------------------------------------------

let saveTimer = null;
let saveInFlight = false;

function commitEdit(mutator, { silent = false } = {}) {
  const { data, eTag } = getState();
  if (!data) return;
  mutator(data);
  stampLastModified(data);
  // Loud commits notify subscribers and re-render the current view. Silent
  // commits update the in-memory state but skip the re-render — used when
  // the user is typing into an uncontrolled text input (re-rendering would
  // destroy the focused element and break iOS dictation).
  (silent ? setStateSilent : setState)(data, eTag);
  // Snapshot to IndexedDB optimistically (fire-and-forget) so the latest
  // edits survive a tab close even before the next save completes.
  persistSnapshot(data, eTag).catch((err) =>
    console.warn("Optimistic snapshot persist failed:", err)
  );
  scheduleSave();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, config.saveDebounceMs);
}

// Errors that indicate "we couldn't reach the server" rather than "the server
// rejected the request". Treat these as offline so we queue and replay later.
function isNetworkError(err) {
  if (!err) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  // fetch() throws TypeError on DNS / connection failures.
  if (err.name === "TypeError") return true;
  // MSAL throws this when token refresh can't reach the auth endpoint.
  if (err.name === "BrowserAuthError" && /network|offline/i.test(err.message || "")) {
    return true;
  }
  return false;
}

async function doSave() {
  saveTimer = null;
  if (saveInFlight) {
    // A save is already running; reschedule so we don't drop the latest edit.
    scheduleSave();
    return;
  }
  const { data, eTag } = getState();
  if (!data) return;

  // Hard-offline shortcut — skip the network attempt entirely.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    await queuePending(data, eTag);
    setSyncStatus("pending");
    return;
  }

  saveInFlight = true;
  setSyncStatus("saving");
  try {
    const newETag = await saveBoards(data, eTag);
    // Write the same data back to state with the new eTag. SILENT — the
    // eTag is bookkeeping the user can't see, and a loud re-render here
    // (firing every save cycle, ~1s after every keystroke) would destroy
    // any focused text input mid-typing.
    setStateSilent(data, newETag);
    await persistSnapshot(data, newETag);
    // A successful save means anything we'd queued is now redundant.
    await clearPending();
    setSyncStatus("synced");
  } catch (err) {
    if (err instanceof ConflictError || err.isConflict) {
      setSyncStatus("error");
      try {
        const fresh = await fetchBoards();
        if (fresh.data) {
          setState(fresh.data, fresh.eTag);
          await persistSnapshot(fresh.data, fresh.eTag);
        }
      } catch (refetchErr) {
        console.error("Refetch after conflict failed:", refetchErr);
      }
      // Offline edits that conflicted can't be applied as-is. Drop the queue
      // so we don't keep replaying a known-bad snapshot.
      await clearPending();
      alert(
        "Heads up: this file was changed elsewhere (another device or the desktop) " +
        "while you were editing. Your view has been refreshed with the latest data. " +
        "If your edit didn't make it in, please re-apply it."
      );
    } else if (isNetworkError(err)) {
      console.warn("Save failed with network error — queueing for replay:", err);
      try {
        await queuePending(data, eTag);
      } catch (qErr) {
        console.error("Queue write failed:", qErr);
      }
      setSyncStatus("pending");
    } else {
      console.error("Save failed:", err);
      setSyncStatus("error");
      alert(`Save failed: ${err.message || String(err)}`);
    }
  } finally {
    saveInFlight = false;
  }
}

// Try to push any queued offline edits to OneDrive. Called on app startup
// (after auth) and on the window's "online" event.
async function replayPending() {
  if (saveInFlight) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  let pending;
  try {
    pending = await loadPending();
  } catch (err) {
    console.warn("Could not read pending queue:", err);
    return;
  }
  if (!pending) return;

  // Use the LATEST in-memory data (which already includes any further edits
  // the user made since the queue entry was written). The queue's baseETag
  // is what we send as If-Match — that's the eTag the file had the last time
  // we successfully read it, so a 412 here means someone else changed the
  // file while we were offline.
  const { data: currentData } = getState();
  const dataToSave = currentData || pending.data;
  setState(dataToSave, pending.baseETag);
  await doSave();
}

// ---------------------------------------------------------------------------
// View handlers — passed into board.js / card.js as the only way they
// communicate state changes back to the app.
// ---------------------------------------------------------------------------

const boardHandlers = {
  openCard: (cardId) => {
    cardOrigin = "board";
    navigateToCard(cardId, view.boardId);
  },
  addCard: (columnId) => {
    const title = prompt("New card title:");
    if (!title || !title.trim()) return;
    let newId = null;
    commitEdit((data) => {
      const card = addCard(data, columnId, title.trim());
      if (card) newId = card.id;
    });
    if (newId) {
      cardOrigin = "board";
      navigateToCard(newId, view.boardId);
    }
  },
};

const cardHandlers = {
  updateField: (field, value) => {
    // Title and description are uncontrolled text inputs — the user's
    // typed text already lives in the DOM, so re-rendering the form would
    // destroy focus and break iOS dictation. priority/due_date/etc. flip
    // visible UI state (chip-active class, Clear-button visibility), so
    // they need a loud commit to redraw.
    const silent = field === "title" || field === "description";
    commitEdit((data) => {
      updateCardFields(data, view.cardId, { [field]: value });
    }, { silent });
  },
  moveToColumn: (columnId) => {
    commitEdit((data) => {
      moveCard(data, view.cardId, columnId);
    });
  },
  toggleSubtask: (subtaskId) => {
    commitEdit((data) => {
      toggleSubtask(data, view.cardId, subtaskId);
    });
  },
  addSubtask: (title) => {
    commitEdit((data) => {
      addSubtask(data, view.cardId, title);
    });
  },
  deleteSubtask: (subtaskId) => {
    commitEdit((data) => {
      deleteSubtask(data, view.cardId, subtaskId);
    });
  },
  updateSubtaskTitle: (subtaskId, title) => {
    commitEdit((data) => {
      updateSubtaskTitle(data, view.cardId, subtaskId, title);
    });
  },
  addTag: (tag) => {
    commitEdit((data) => addTag(data, view.cardId, tag));
  },
  removeTag: (tag) => {
    commitEdit((data) => removeTag(data, view.cardId, tag));
  },
  archive: () => {
    commitEdit((data) => archiveCard(data, view.cardId));
    navigateBack();
  },
  unarchive: () => {
    commitEdit((data) => unarchiveCard(data, view.cardId));
    navigateBack();
  },
  deleteCard: () => {
    commitEdit((data) => deleteCard(data, view.cardId));
    navigateBack();
  },
};

// Archive + search both surface results that link out to a card. Setting
// cardOrigin lets navigateBack send the user back to the right list rather
// than to the parent board.
const archiveHandlers = {
  openCard: (cardId, boardId) => {
    cardOrigin = "archive";
    navigateToCard(cardId, boardId);
  },
};

const searchHandlers = {
  openCard: (cardId, boardId) => {
    cardOrigin = "search";
    navigateToCard(cardId, boardId);
  },
};

// ---------------------------------------------------------------------------
// Initial load + polling for external changes.
// ---------------------------------------------------------------------------

async function loadAndRender() {
  setSyncStatus("checking");
  try {
    const { data, eTag } = await fetchBoards();
    if (data) {
      setState(data, eTag);
      await persistSnapshot(data, eTag);
      setSyncStatus("synced");
    } else {
      setState({ boards: [], schema_version: "1.0" }, null);
      setSyncStatus("synced");
    }
  } catch (err) {
    console.error("Initial load failed:", err);
    setSyncStatus("error");
    const cached = await loadSnapshot();
    if (cached) {
      setState(cached.data, cached.eTag);
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
    // Skip if hidden, mid-save, OR the user has unsaved edits queued —
    // saveTimer !== null means they typed/tapped within the last
    // saveDebounceMs window. Polling here would `loadAndRender → setState`
    // (loud) and rebuild the form, killing focus mid-typing.
    if (document.hidden || saveInFlight || saveTimer !== null) return;
    try {
      const remoteETag = await fetchETag();
      const { eTag: localETag } = getState();
      if (remoteETag && remoteETag !== localETag) {
        await loadAndRender();
      }
    } catch (err) {
      console.warn("Poll check failed (transient):", err);
    }
  }, config.pollIntervalMs);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function showBoards() {
  els.signoutBtn.hidden = false;

  // Subscribe once for live re-render across all data changes.
  subscribe(() => renderCurrentView());

  // First paint from cache (instant), then refresh from network.
  const cached = await loadSnapshot();
  if (cached) {
    setState(cached.data, cached.eTag);
  }

  view = { name: "list" };
  updateBackButton();
  renderCurrentView();
  refreshOfflineBanner();

  // Try to replay any queued offline edits before doing the live fetch, so
  // the live fetch reflects our locally pending changes once they land.
  try {
    await replayPending();
  } catch (err) {
    console.warn("Initial replay attempt failed (non-fatal):", err);
  }

  await loadAndRender();
  startPolling();
}

// Show a thin banner above the boards content when we're offline OR
// when there are queued edits waiting to replay. Pure status — no actions.
async function refreshOfflineBanner() {
  if (!els.offlineBanner) return;
  const isOnline = typeof navigator === "undefined" ? true : navigator.onLine;
  let pending = false;
  try {
    pending = !!(await loadPending());
  } catch {
    /* ignore — banner is best-effort */
  }
  if (!isOnline) {
    els.offlineBanner.textContent = "You're offline. Edits will sync when you reconnect.";
    els.offlineBanner.dataset.tone = "offline";
    els.offlineBanner.hidden = false;
  } else if (pending) {
    els.offlineBanner.textContent = "Edits queued — syncing…";
    els.offlineBanner.dataset.tone = "pending";
    els.offlineBanner.hidden = false;
  } else {
    els.offlineBanner.hidden = true;
  }
}

async function bootstrap() {
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
    els.backBtn.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Static event wiring
// ---------------------------------------------------------------------------

els.backBtn.addEventListener("click", () => navigateBack());

if (els.searchOpenBtn) {
  els.searchOpenBtn.addEventListener("click", () => navigateToSearch());
}
if (els.archiveOpenBtn) {
  els.archiveOpenBtn.addEventListener("click", () => navigateToArchive());
}

els.signinBtn.addEventListener("click", async () => {
  els.signinError.hidden = true;
  els.signinBtn.disabled = true;
  try {
    await signIn();
    // signIn navigates away via redirect; on return, bootstrap re-runs.
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
  if (document.hidden) return;
  if (!getActiveAccount()) return;
  // Same guard as the polling loop: don't refetch / re-render if the user
  // has unsaved edits queued. They could have backgrounded the PWA while
  // typing, and a loud setState here would kill focus on return.
  if (saveInFlight || saveTimer !== null) return;
  loadAndRender().catch((err) => console.error("Refresh on focus failed:", err));
});

window.addEventListener("offline", () => {
  setSyncStatus("offline");
  refreshOfflineBanner();
});
window.addEventListener("online", async () => {
  refreshOfflineBanner();
  if (!getActiveAccount()) return;
  // Order matters: replay BEFORE pulling fresh data. Otherwise our queued
  // edits get clobbered by whatever the server (or another device) has.
  try {
    await replayPending();
  } catch (err) {
    console.warn("Replay on reconnect failed:", err);
  }
  try {
    await loadAndRender();
  } catch (err) {
    console.error("Refresh on reconnect failed:", err);
  }
  refreshOfflineBanner();
});

// Flush any pending save before the user navigates away.
window.addEventListener("beforeunload", () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    // Best-effort: the synchronous handler can't await, but kicks the save off.
    doSave();
  }
});

// ---------------------------------------------------------------------------
// Go.
// ---------------------------------------------------------------------------

bootstrap().catch((err) => {
  console.error("Bootstrap failed:", err);
  showError(`Startup error: ${err.message || String(err)}`);
});
