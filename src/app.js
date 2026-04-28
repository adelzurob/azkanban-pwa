// AZKanban PWA — entry point.
//
// Handles bootstrap (auth + initial fetch), navigation between three views
// (boards list / board detail / card detail), debounced writes back to
// OneDrive via Graph with eTag-based optimistic concurrency, conflict
// recovery, and offline cache fallback.

import { initAuth, signIn, signOut, getActiveAccount } from "./auth.js";
import {
  fetchBoards, fetchETag, saveBoards, ConflictError,
} from "./graph.js";
import {
  persistSnapshot, loadSnapshot, setState, getState, subscribe,
} from "./store.js";
import { config } from "./config.js";
import {
  archiveCard, unarchiveCard, deleteCard, addCard, moveCard,
  updateCardFields, toggleSubtask, addSubtask, deleteSubtask,
  updateSubtaskTitle, stampLastModified,
} from "./mutations.js";
import { renderBoardDetail } from "./ui/board.js";
import { renderCardDetail } from "./ui/card.js";

// ---------------------------------------------------------------------------
// DOM references — gathered once at module load.
// ---------------------------------------------------------------------------

const els = {
  signinScreen:        document.getElementById("signin-screen"),
  boardsScreen:        document.getElementById("boards-screen"),
  boardDetailScreen:   document.getElementById("board-detail-screen"),
  cardDetailScreen:    document.getElementById("card-detail-screen"),
  errorScreen:         document.getElementById("error-screen"),
  signinBtn:           document.getElementById("signin-btn"),
  signinError:         document.getElementById("signin-error"),
  signoutBtn:          document.getElementById("signout-btn"),
  retryBtn:            document.getElementById("retry-btn"),
  errorMessage:        document.getElementById("error-message"),
  boardsList:          document.getElementById("boards-list"),
  boardDetailHeader:   document.getElementById("board-detail-header"),
  boardDetailRoot:     document.getElementById("board-detail-root"),
  cardDetailHeader:    document.getElementById("card-detail-header"),
  cardDetailRoot:      document.getElementById("card-detail-root"),
  syncIndicator:       document.getElementById("sync-indicator"),
  backBtn:             document.getElementById("back-btn"),
};

// ---------------------------------------------------------------------------
// View routing — simple state machine, no URL hashes.
// ---------------------------------------------------------------------------

// view = { name: "list" }
//      | { name: "board", boardId: "..." }
//      | { name: "card",  cardId: "...", boardId: "..." }
let view = { name: "list" };

const ALL_SCREENS = [
  els.signinScreen,
  els.boardsScreen,
  els.boardDetailScreen,
  els.cardDetailScreen,
  els.errorScreen,
];

function showScreen(target) {
  for (const s of ALL_SCREENS) s.hidden = s !== target;
}

function updateBackButton() {
  // Back button only meaningful on board/card detail screens.
  els.backBtn.hidden = !(view.name === "board" || view.name === "card");
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

function navigateBack() {
  if (view.name === "card") {
    view = { name: "board", boardId: view.boardId };
  } else if (view.name === "board") {
    view = { name: "list" };
  }
  updateBackButton();
  renderCurrentView();
}

function navigateToList() {
  view = { name: "list" };
  updateBackButton();
  renderCurrentView();
}

// ---------------------------------------------------------------------------
// Sync indicator
// ---------------------------------------------------------------------------

function setSyncStatus(status) {
  els.syncIndicator.dataset.status = status;
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

function commitEdit(mutator) {
  const { data, eTag } = getState();
  if (!data) return;
  mutator(data);
  stampLastModified(data);
  // Trigger subscribers so the UI re-renders immediately.
  setState(data, eTag);
  scheduleSave();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, config.saveDebounceMs);
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

  saveInFlight = true;
  setSyncStatus("saving");
  try {
    const newETag = await saveBoards(data, eTag);
    // Write the same data back to state with the new eTag.
    setState(data, newETag);
    await persistSnapshot(data, newETag);
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
      alert(
        "Heads up: this file was changed elsewhere (another device or the desktop) " +
        "while you were editing. Your view has been refreshed with the latest data. " +
        "If your edit didn't make it in, please re-apply it."
      );
    } else {
      console.error("Save failed:", err);
      setSyncStatus("error");
      alert(`Save failed: ${err.message || String(err)}`);
    }
  } finally {
    saveInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// View handlers — passed into board.js / card.js as the only way they
// communicate state changes back to the app.
// ---------------------------------------------------------------------------

const boardHandlers = {
  openCard: (cardId) => navigateToCard(cardId, view.boardId),
  addCard: (columnId) => {
    const title = prompt("New card title:");
    if (!title || !title.trim()) return;
    let newId = null;
    commitEdit((data) => {
      const card = addCard(data, columnId, title.trim());
      if (card) newId = card.id;
    });
    if (newId) navigateToCard(newId, view.boardId);
  },
};

const cardHandlers = {
  updateField: (field, value) => {
    commitEdit((data) => {
      updateCardFields(data, view.cardId, { [field]: value });
    });
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
    if (document.hidden || saveInFlight) return;
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

  await loadAndRender();
  startPolling();
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
