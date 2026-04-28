// Pure data manipulation utilities for the AZKanban data structure.
// All functions mutate the passed `data` object in place and return useful
// references or booleans. Keeping traversal/mutation logic out of UI code
// makes the UI modules thin and testable.
//
// The data shape mirrors AZKanban.py's serialize_data():
//   data.boards[].columns[].cards[].subtasks[]

function uuid() {
  // crypto.randomUUID is supported on iOS 16.4+ and all modern desktop browsers.
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

export function findBoard(data, boardId) {
  if (!data || !Array.isArray(data.boards)) return null;
  return data.boards.find((b) => b.id === boardId) || null;
}

export function findCard(data, cardId) {
  if (!data || !Array.isArray(data.boards)) return null;
  for (const board of data.boards) {
    for (const column of board.columns || []) {
      for (const card of column.cards || []) {
        if (card.id === cardId) return { card, column, board };
      }
    }
  }
  return null;
}

export function findColumn(data, columnId) {
  if (!data || !Array.isArray(data.boards)) return null;
  for (const board of data.boards) {
    for (const column of board.columns || []) {
      if (column.id === columnId) return { column, board };
    }
  }
  return null;
}

export function updateCardFields(data, cardId, fields) {
  const found = findCard(data, cardId);
  if (!found) return null;
  Object.assign(found.card, fields);
  return found.card;
}

export function moveCard(data, cardId, targetColumnId) {
  const src = findCard(data, cardId);
  if (!src) return false;
  const dst = findColumn(data, targetColumnId);
  if (!dst) return false;
  if (src.column.id === targetColumnId) return true; // no-op
  const idx = src.column.cards.indexOf(src.card);
  if (idx >= 0) src.column.cards.splice(idx, 1);
  dst.column.cards.push(src.card);
  // Auto-set/clear completed_at when moving to/from done columns.
  if (dst.column.is_done_column && !src.card.completed_at) {
    src.card.completed_at = nowIso();
  } else if (!dst.column.is_done_column && src.card.completed_at) {
    src.card.completed_at = null;
  }
  return true;
}

export function archiveCard(data, cardId) {
  const found = findCard(data, cardId);
  if (!found) return false;
  found.card.archived = true;
  found.card.archived_at = nowIso();
  found.card.original_column_id = found.column.id;
  return true;
}

export function unarchiveCard(data, cardId) {
  const found = findCard(data, cardId);
  if (!found) return false;
  found.card.archived = false;
  found.card.archived_at = null;
  // Restore to original column if it still exists and we're not already there.
  if (found.card.original_column_id && found.card.original_column_id !== found.column.id) {
    moveCard(data, cardId, found.card.original_column_id);
  }
  found.card.original_column_id = null;
  return true;
}

export function deleteCard(data, cardId) {
  const found = findCard(data, cardId);
  if (!found) return false;
  const idx = found.column.cards.indexOf(found.card);
  if (idx >= 0) {
    found.column.cards.splice(idx, 1);
    return true;
  }
  return false;
}

export function addCard(data, columnId, title) {
  const found = findColumn(data, columnId);
  if (!found) return null;
  const card = {
    id: uuid(),
    title: title || "New card",
    description: "",
    priority: 0,
    due_date: null,
    tags: [],
    created_at: nowIso(),
    completed_at: null,
    archived: false,
    archived_at: null,
    original_column_id: null,
    subtasks: [],
  };
  found.column.cards.push(card);
  return card;
}

export function toggleSubtask(data, cardId, subtaskId) {
  const found = findCard(data, cardId);
  if (!found) return null;
  const subtask = (found.card.subtasks || []).find((s) => s.id === subtaskId);
  if (!subtask) return null;
  subtask.completed = !subtask.completed;
  return subtask;
}

export function addSubtask(data, cardId, title) {
  const found = findCard(data, cardId);
  if (!found) return null;
  const subtask = { id: uuid(), title: title || "New subtask", completed: false };
  if (!found.card.subtasks) found.card.subtasks = [];
  found.card.subtasks.push(subtask);
  return subtask;
}

export function deleteSubtask(data, cardId, subtaskId) {
  const found = findCard(data, cardId);
  if (!found) return false;
  const subtasks = found.card.subtasks || [];
  const idx = subtasks.findIndex((s) => s.id === subtaskId);
  if (idx < 0) return false;
  subtasks.splice(idx, 1);
  return true;
}

export function updateSubtaskTitle(data, cardId, subtaskId, title) {
  const found = findCard(data, cardId);
  if (!found) return null;
  const subtask = (found.card.subtasks || []).find((s) => s.id === subtaskId);
  if (!subtask) return null;
  subtask.title = title;
  return subtask;
}

export function stampLastModified(data) {
  data.last_modified = nowIso();
  data.last_modified_by = "iPhone PWA";
}
