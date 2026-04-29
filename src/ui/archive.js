// Archive view: every archived card across every board, newest-first.
//
// Tap a card to open the standard card detail screen; that screen already
// exposes Restore (unarchive) and Delete (permanent) actions, so we don't
// duplicate them here.

import { listArchivedCards } from "../mutations.js";

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

function formatArchivedAt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = Date.now();
  const dayMs = 86400000;
  const days = Math.floor((now - d.getTime()) / dayMs);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString();
}

export function renderArchive(root, headerEl, data, handlers) {
  emptyChildren(root);
  emptyChildren(headerEl);

  headerEl.appendChild(el(
    "div",
    { className: "screen-title-row" },
    el("span", { className: "screen-title-icon" }, "🗄"),
    el("h2", { className: "screen-title" }, "Archive")
  ));

  const archived = listArchivedCards(data);

  if (archived.length === 0) {
    root.appendChild(el("p", { className: "empty-state" }, "No archived cards."));
    return;
  }

  const note = el(
    "p",
    { className: "archive-note" },
    `${archived.length} archived card${archived.length === 1 ? "" : "s"}. ` +
    "Tap to restore or permanently delete."
  );
  root.appendChild(note);

  const list = el("div", { className: "archive-list" });
  for (const { card, board } of archived) {
    list.appendChild(renderArchiveItem(card, board, handlers));
  }
  root.appendChild(list);
}

function renderArchiveItem(card, board, handlers) {
  const item = el("button", {
    type: "button",
    className: "archive-item",
    onClick: () => handlers.openCard(card.id, board.id),
  });

  item.appendChild(el(
    "span",
    { className: "archive-item-title" },
    card.title || "Untitled"
  ));

  const meta = el("div", { className: "archive-item-meta" });
  meta.appendChild(el(
    "span",
    { className: "archive-item-board" },
    `${board.icon || "📋"} ${board.name || "Untitled board"}`
  ));
  if (card.archived_at) {
    meta.appendChild(el(
      "span",
      { className: "archive-item-date" },
      formatArchivedAt(card.archived_at)
    ));
  }
  item.appendChild(meta);

  return item;
}
