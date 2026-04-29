// Board detail view: vertical scroll of columns with cards inside each.
//
// Optimized for phone: columns are stacked sections rather than horizontal
// scroll. Tap a card to open its detail view. Tap "+ Add card" to insert.
// No drag-and-drop — moves are done from the card detail screen.
//
// Tag filter: a row of chips above the columns lists every tag in the board.
// Tapping a chip toggles it on/off; cards are shown only if they carry at
// least one selected tag (OR semantics). Selection is kept per-board for
// the lifetime of the page so the filter survives re-renders triggered by
// edits.

import { findBoard, collectBoardTags } from "../mutations.js";

const PRIORITY_LABELS = ["", "Low", "Med", "High"];

// Per-board tag filter state: boardId -> Set<lowercased tag>. Lives only in
// memory; resets when the user closes the PWA. Lower-casing the keys lets
// us treat "Urgent" and "urgent" as the same filter regardless of source.
const tagFilters = new Map();

function getFilter(boardId) {
  if (!tagFilters.has(boardId)) tagFilters.set(boardId, new Set());
  return tagFilters.get(boardId);
}

function cardMatchesFilter(card, filterSet) {
  if (filterSet.size === 0) return true;
  for (const t of card.tags || []) {
    if (filterSet.has(String(t).toLowerCase())) return true;
  }
  return false;
}

function emptyChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const k in props) {
      if (k === "className") e.className = props[k];
      else if (k === "onClick") e.addEventListener("click", props[k]);
      else if (k === "dataset") Object.assign(e.dataset, props[k]);
      else if (k.startsWith("aria-")) e.setAttribute(k, props[k]);
      else e[k] = props[k];
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === "string") e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

export function renderBoardDetail(root, headerEl, data, boardId, handlers) {
  emptyChildren(root);
  emptyChildren(headerEl);

  const board = findBoard(data, boardId);
  if (!board) {
    headerEl.appendChild(el("h2", { className: "screen-title" }, "Board not found"));
    root.appendChild(el("p", { className: "empty-state" }, "This board no longer exists."));
    return;
  }

  // Screen header: board icon + name
  headerEl.appendChild(el(
    "div",
    { className: "screen-title-row" },
    el("span", { className: "screen-title-icon" }, board.icon || "📋"),
    el("h2", { className: "screen-title" }, board.name || "Untitled")
  ));

  // Tag filter row (only if the board has any tags at all). Re-renders the
  // body inline when a chip is toggled — no need to round-trip through the
  // global app dispatcher because filter state isn't part of the data model.
  const filter = getFilter(boardId);
  const tags = collectBoardTags(data, boardId);
  if (tags.length > 0) {
    root.appendChild(renderTagFilterRow(boardId, tags, filter, () => {
      // Hot-reload everything below the header without re-running auth/fetch.
      renderBoardDetail(root, headerEl, data, boardId, handlers);
    }));
  }

  for (const column of board.columns || []) {
    const activeCards = (column.cards || []).filter(
      (c) => !c.archived && cardMatchesFilter(c, filter)
    );

    const colSection = el("section", { className: "column-section" });

    colSection.appendChild(el(
      "div",
      { className: "column-header" + (column.is_done_column ? " column-done" : "") },
      el("span", { className: "column-icon" }, column.icon || "📋"),
      el("span", { className: "column-title" }, column.title || "Untitled"),
      el("span", { className: "column-count" }, String(activeCards.length))
    ));

    if (activeCards.length === 0) {
      const msg = filter.size > 0
        ? "No cards match the current tag filter"
        : "No cards";
      colSection.appendChild(el("p", { className: "column-empty" }, msg));
    } else {
      for (const card of activeCards) {
        colSection.appendChild(renderCardItem(card, handlers));
      }
    }

    colSection.appendChild(el("button", {
      className: "add-card-btn",
      onClick: () => handlers.addCard(column.id),
    }, "+ Add card"));

    root.appendChild(colSection);
  }
}

function renderTagFilterRow(boardId, tags, filter, rerender) {
  const wrap = el("div", { className: "tag-filter-row" });

  const label = el("span", { className: "tag-filter-label" },
    filter.size > 0 ? `Filtering: ${filter.size} tag${filter.size === 1 ? "" : "s"}` : "Filter by tag");
  wrap.appendChild(label);

  const chipBox = el("div", { className: "tag-filter-chips" });
  for (const tag of tags) {
    const lower = String(tag).toLowerCase();
    const active = filter.has(lower);
    chipBox.appendChild(el("button", {
      type: "button",
      className: "tag-chip" + (active ? " tag-chip-active" : ""),
      onClick: () => {
        if (active) filter.delete(lower); else filter.add(lower);
        rerender();
      },
    }, "#" + tag));
  }
  wrap.appendChild(chipBox);

  if (filter.size > 0) {
    wrap.appendChild(el("button", {
      type: "button",
      className: "tag-filter-clear",
      onClick: () => {
        filter.clear();
        rerender();
      },
    }, "Clear"));
  }

  return wrap;
}

function renderCardItem(card, handlers) {
  const item = el("button", {
    type: "button",
    className: "card-item"
      + (card.completed_at ? " card-completed" : "")
      + (card.priority > 0 ? " priority-" + card.priority : ""),
    onClick: () => handlers.openCard(card.id),
  });

  const title = el("span", { className: "card-item-title" }, card.title || "Untitled");
  item.appendChild(title);

  const meta = el("div", { className: "card-item-meta" });

  if (card.priority > 0) {
    meta.appendChild(el(
      "span",
      { className: "card-priority priority-text-" + card.priority },
      PRIORITY_LABELS[card.priority]
    ));
  }

  const subtasks = card.subtasks || [];
  if (subtasks.length > 0) {
    const done = subtasks.filter((s) => s.completed).length;
    meta.appendChild(el("span", { className: "card-subtasks" }, `${done}/${subtasks.length} ✓`));
  }

  if (card.due_date) {
    const due = formatDueDate(card.due_date);
    meta.appendChild(el(
      "span",
      { className: "card-due" + (due.urgent ? " card-due-urgent" : "") + (due.overdue ? " card-due-overdue" : "") },
      due.text
    ));
  }

  for (const tag of (card.tags || []).slice(0, 3)) {
    meta.appendChild(el("span", { className: "card-tag" }, tag));
  }

  if (meta.children.length > 0) item.appendChild(meta);

  return item;
}

function formatDueDate(dueValue) {
  if (!dueValue) return { text: "", urgent: false, overdue: false };
  // due_date may be a YYYY-MM-DD string or full ISO datetime.
  const d = new Date(dueValue);
  if (isNaN(d.getTime())) return { text: String(dueValue), urgent: false, overdue: false };
  const now = new Date();
  // Compare at day granularity (set both to start-of-day).
  const dayMs = 86400000;
  const dueDay = Math.floor(d.getTime() / dayMs);
  const todayDay = Math.floor(now.getTime() / dayMs);
  const days = dueDay - todayDay;

  let text;
  if (days < -1) text = `${Math.abs(days)}d ago`;
  else if (days === -1) text = "Yesterday";
  else if (days === 0) text = "Today";
  else if (days === 1) text = "Tomorrow";
  else if (days <= 7) text = `${days}d`;
  else text = d.toLocaleDateString();

  return { text, urgent: days >= 0 && days <= 1, overdue: days < 0 };
}
