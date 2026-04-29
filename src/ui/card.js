// Card detail / edit form. Single full-screen view with editable fields:
// title, notes, priority chips, due date, column dropdown (move-to), tags
// (read-only in v1), subtasks (check / edit / add / delete), and Archive /
// Restore / Delete actions at the bottom.
//
// All edits call handlers passed by app.js, which mutates the model and
// schedules a debounced save back to OneDrive.

import { findCard } from "../mutations.js";

const PRIORITY_OPTIONS = [
  { value: 0, label: "None" },
  { value: 1, label: "Low" },
  { value: 2, label: "Medium" },
  { value: 3, label: "High" },
];

function emptyChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const k in props) {
      if (k === "className") e.className = props[k];
      else if (k === "onClick") e.addEventListener("click", props[k]);
      else if (k === "onChange") e.addEventListener("change", props[k]);
      else if (k === "onInput") e.addEventListener("input", props[k]);
      else if (k === "onKeydown") e.addEventListener("keydown", props[k]);
      else if (k === "onBlur") e.addEventListener("blur", props[k]);
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

export function renderCardDetail(root, headerEl, data, cardId, handlers) {
  emptyChildren(root);
  emptyChildren(headerEl);

  const found = findCard(data, cardId);
  if (!found) {
    headerEl.appendChild(el("h2", { className: "screen-title" }, "Card not found"));
    root.appendChild(el("p", { className: "empty-state" }, "This card no longer exists. It may have been deleted."));
    return;
  }
  const { card, column, board } = found;

  // Screen header
  headerEl.appendChild(el(
    "div",
    { className: "screen-title-row" },
    el("h2", { className: "screen-title" }, card.archived ? "Archived card" : "Edit card")
  ));

  // ---- Title ----
  root.appendChild(fieldLabel("Title"));
  const titleInput = el("input", {
    type: "text",
    className: "field-input",
    onInput: (e) => handlers.updateField("title", e.target.value),
  });
  titleInput.value = card.title || "";
  root.appendChild(titleInput);

  // ---- Description / notes ----
  root.appendChild(fieldLabel("Notes"));
  const descTextarea = el("textarea", {
    className: "field-textarea",
    rows: 5,
    onInput: (e) => handlers.updateField("description", e.target.value),
  });
  descTextarea.value = card.description || "";
  root.appendChild(descTextarea);

  // ---- Priority ----
  root.appendChild(fieldLabel("Priority"));
  const priorityRow = el("div", { className: "chip-row" });
  for (const opt of PRIORITY_OPTIONS) {
    const isActive = (card.priority || 0) === opt.value;
    const chip = el("button", {
      type: "button",
      className: "chip" + (isActive ? " chip-active priority-bg-" + opt.value : ""),
      onClick: () => handlers.updateField("priority", opt.value),
    }, opt.label);
    priorityRow.appendChild(chip);
  }
  root.appendChild(priorityRow);

  // ---- Due date ----
  root.appendChild(fieldLabel("Due date"));
  const dueRow = el("div", { className: "date-row" });
  const dueInput = el("input", {
    type: "date",
    className: "field-input",
    onChange: (e) => handlers.updateField("due_date", e.target.value || null),
  });
  // Trim ISO datetime to YYYY-MM-DD if needed.
  dueInput.value = (card.due_date || "").substring(0, 10);
  dueRow.appendChild(dueInput);

  if (card.due_date) {
    dueRow.appendChild(el("button", {
      type: "button",
      className: "icon-btn",
      onClick: () => {
        dueInput.value = "";
        handlers.updateField("due_date", null);
      },
    }, "Clear"));
  }
  root.appendChild(dueRow);

  // ---- Move to column ----
  root.appendChild(fieldLabel("Column"));
  const columnSelect = el("select", {
    className: "field-input",
    onChange: (e) => handlers.moveToColumn(e.target.value),
  });
  for (const col of board.columns || []) {
    const opt = el("option", { value: col.id }, `${col.icon || "📋"} ${col.title || "Untitled"}`);
    if (col.id === column.id) opt.selected = true;
    columnSelect.appendChild(opt);
  }
  root.appendChild(columnSelect);

  // ---- Tags (editable: add via input, remove by tapping × on the chip) ----
  root.appendChild(fieldLabel("Tags"));
  const tagSection = el("div", { className: "tag-edit-section" });

  const tagRow = el("div", { className: "chip-row" });
  const tags = card.tags || [];
  if (tags.length === 0) {
    tagRow.appendChild(el("span", { className: "tag-empty" }, "No tags yet."));
  } else {
    for (const tag of tags) {
      const chip = el("span", { className: "chip chip-tag chip-tag-removable" });
      chip.appendChild(document.createTextNode(tag));
      chip.appendChild(el("button", {
        type: "button",
        className: "chip-remove",
        "aria-label": `Remove tag ${tag}`,
        onClick: () => handlers.removeTag(tag),
      }, "×"));
      tagRow.appendChild(chip);
    }
  }
  tagSection.appendChild(tagRow);

  const tagAddRow = el("div", { className: "tag-add-row" });
  const tagInput = el("input", {
    type: "text",
    className: "field-input",
    placeholder: "Add tag…",
    autocapitalize: "none",
    spellcheck: false,
    onKeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const v = tagInput.value.trim();
        if (v) {
          handlers.addTag(v);
          tagInput.value = "";
        }
      }
    },
  });
  tagAddRow.appendChild(tagInput);
  tagAddRow.appendChild(el("button", {
    type: "button",
    className: "primary-btn-small",
    onClick: () => {
      const v = tagInput.value.trim();
      if (v) {
        handlers.addTag(v);
        tagInput.value = "";
      }
    },
  }, "Add"));
  tagSection.appendChild(tagAddRow);

  root.appendChild(tagSection);

  // ---- Subtasks ----
  root.appendChild(fieldLabel("Subtasks"));
  const subtasks = card.subtasks || [];
  if (subtasks.length === 0) {
    root.appendChild(el("p", { className: "subtask-empty" }, "No subtasks yet."));
  } else {
    const list = el("div", { className: "subtask-list" });
    // Sort: incomplete first, then completed.
    const sorted = [...subtasks].sort((a, b) => Number(a.completed) - Number(b.completed));
    for (const subtask of sorted) {
      list.appendChild(renderSubtaskRow(subtask, handlers));
    }
    root.appendChild(list);
  }

  // Add subtask inline
  const addRow = el("div", { className: "subtask-add-row" });
  const addInput = el("input", {
    type: "text",
    className: "field-input",
    placeholder: "Add subtask…",
    onKeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const v = addInput.value.trim();
        if (v) {
          handlers.addSubtask(v);
          addInput.value = "";
        }
      }
    },
  });
  addRow.appendChild(addInput);
  addRow.appendChild(el("button", {
    type: "button",
    className: "primary-btn-small",
    onClick: () => {
      const v = addInput.value.trim();
      if (v) {
        handlers.addSubtask(v);
        addInput.value = "";
      }
    },
  }, "Add"));
  root.appendChild(addRow);

  // ---- Action buttons ----
  const actionRow = el("div", { className: "card-actions" });

  if (!card.archived) {
    actionRow.appendChild(el("button", {
      type: "button",
      className: "secondary-btn",
      onClick: () => {
        if (confirm("Archive this card? You can restore it later from the archive view.")) {
          handlers.archive();
        }
      },
    }, "Archive"));
  } else {
    actionRow.appendChild(el("button", {
      type: "button",
      className: "secondary-btn",
      onClick: () => handlers.unarchive(),
    }, "Restore"));
  }

  actionRow.appendChild(el("button", {
    type: "button",
    className: "danger-btn",
    onClick: () => {
      if (confirm("Permanently delete this card? This cannot be undone.")) {
        handlers.deleteCard();
      }
    },
  }, "Delete"));

  root.appendChild(actionRow);
}

function fieldLabel(text) {
  return el("label", { className: "field-label" }, text);
}

function renderSubtaskRow(subtask, handlers) {
  const row = el("div", {
    className: "subtask-row" + (subtask.completed ? " subtask-done" : ""),
  });

  const checkbox = el("input", {
    type: "checkbox",
    className: "subtask-checkbox",
    onChange: () => handlers.toggleSubtask(subtask.id),
  });
  checkbox.checked = !!subtask.completed;
  row.appendChild(checkbox);

  const titleInput = el("input", {
    type: "text",
    className: "subtask-title",
    onChange: (e) => handlers.updateSubtaskTitle(subtask.id, e.target.value),
    onBlur: (e) => handlers.updateSubtaskTitle(subtask.id, e.target.value),
  });
  titleInput.value = subtask.title || "";
  row.appendChild(titleInput);

  row.appendChild(el("button", {
    type: "button",
    className: "subtask-delete",
    "aria-label": "Delete subtask",
    onClick: () => {
      if (confirm("Delete this subtask?")) {
        handlers.deleteSubtask(subtask.id);
      }
    },
  }, "×"));

  return row;
}
