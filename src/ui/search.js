// Global search view: substring match across every non-archived card,
// every board. Matches title, notes, tags, and subtask titles.
// Tap a result to open that card's detail screen.

import { searchCards } from "../mutations.js";

function emptyChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const k in props) {
      if (k === "className") e.className = props[k];
      else if (k === "onClick") e.addEventListener("click", props[k]);
      else if (k === "onInput") e.addEventListener("input", props[k]);
      else if (k === "onKeydown") e.addEventListener("keydown", props[k]);
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

// Persist the user's current query so navigating into a result and back
// doesn't lose it. Lives only for the lifetime of the page.
let lastQuery = "";

export function renderSearch(root, headerEl, data, handlers) {
  emptyChildren(root);
  emptyChildren(headerEl);

  headerEl.appendChild(el(
    "div",
    { className: "screen-title-row" },
    el("span", { className: "screen-title-icon" }, "🔍"),
    el("h2", { className: "screen-title" }, "Search")
  ));

  const input = el("input", {
    type: "search",
    className: "field-input search-input",
    placeholder: "Search title, notes, tags, subtasks…",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: false,
  });
  input.value = lastQuery;
  root.appendChild(input);

  const results = el("div", { className: "search-results" });
  root.appendChild(results);

  function refresh() {
    lastQuery = input.value;
    renderResults(results, data, lastQuery, handlers);
  }

  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      refresh();
    }
  });

  // Initial render — shows empty state if no query, otherwise re-applies
  // the persisted query.
  refresh();

  // Focus on entry so the keyboard pops up on iOS.
  setTimeout(() => input.focus(), 0);
}

function renderResults(container, data, query, handlers) {
  emptyChildren(container);
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    container.appendChild(el(
      "p",
      { className: "search-hint" },
      "Type a word or phrase to search every board."
    ));
    return;
  }

  const matches = searchCards(data, trimmed, 100);
  if (matches.length === 0) {
    container.appendChild(el(
      "p",
      { className: "empty-state" },
      `No matches for “${trimmed}”.`
    ));
    return;
  }

  const summary = el(
    "p",
    { className: "search-summary" },
    `${matches.length} result${matches.length === 1 ? "" : "s"}`
  );
  container.appendChild(summary);

  const list = el("div", { className: "search-list" });
  for (const { card, column, board } of matches) {
    list.appendChild(renderResultRow(card, column, board, trimmed, handlers));
  }
  container.appendChild(list);
}

function renderResultRow(card, column, board, query, handlers) {
  const item = el("button", {
    type: "button",
    className: "search-item",
    onClick: () => handlers.openCard(card.id, board.id),
  });

  item.appendChild(highlightedText(
    card.title || "Untitled",
    query,
    "search-item-title"
  ));

  const meta = el("div", { className: "search-item-meta" });
  meta.appendChild(el(
    "span",
    { className: "search-item-board" },
    `${board.icon || "📋"} ${board.name || "Untitled"} · ${column.title || ""}`
  ));
  item.appendChild(meta);

  if (card.description && card.description.toLowerCase().includes(query.toLowerCase())) {
    const snippet = makeSnippet(card.description, query);
    item.appendChild(highlightedText(snippet, query, "search-item-snippet"));
  }

  return item;
}

// Build a small snippet around the first match in the description so the
// user sees context rather than the entire notes blob.
function makeSnippet(text, query, radius = 50) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  let s = text.slice(start, end);
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}

// Build a span with the matched substring wrapped in <mark>. We use
// document.createElement + textContent throughout so the user's content
// can never inject markup (no innerHTML, no XSS risk).
function highlightedText(text, query, className) {
  const wrapper = el("span", { className });
  const lower = (text || "").toLowerCase();
  const q = query.toLowerCase();
  if (!q) {
    wrapper.textContent = text || "";
    return wrapper;
  }
  let cursor = 0;
  while (cursor < text.length) {
    const hit = lower.indexOf(q, cursor);
    if (hit < 0) {
      wrapper.appendChild(document.createTextNode(text.slice(cursor)));
      break;
    }
    if (hit > cursor) {
      wrapper.appendChild(document.createTextNode(text.slice(cursor, hit)));
    }
    const mark = document.createElement("mark");
    mark.textContent = text.slice(hit, hit + q.length);
    wrapper.appendChild(mark);
    cursor = hit + q.length;
  }
  return wrapper;
}
