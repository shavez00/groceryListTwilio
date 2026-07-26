'use strict';

const repository = require('./repository');

const MAX_ITEM_LENGTH = 100;
const MAX_LIST_SIZE = 50;
const MAX_ITEMS_PER_REQUEST = 20;
const LIST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
const MAX_RETRIES = 3;

function validateListId(listId) {
  if (!LIST_ID_PATTERN.test(listId)) {
    throw Object.assign(new Error(`Invalid listId "${listId}". Use letters, numbers, hyphens, underscores (1-32 chars).`), { code: 'VALIDATION_ERROR' });
  }
}

function validateItems(items, { maxCount = MAX_ITEMS_PER_REQUEST } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw Object.assign(new Error('items must be a non-empty array'), { code: 'VALIDATION_ERROR' });
  }
  if (items.length > maxCount) {
    throw Object.assign(new Error(`Too many items. Max ${maxCount} per request.`), { code: 'VALIDATION_ERROR' });
  }
  const trimmed = items.map(i => (typeof i === 'string' ? i.trim() : ''));
  const blank = trimmed.find(i => i.length === 0);
  if (blank !== undefined) {
    throw Object.assign(new Error('Items cannot be blank.'), { code: 'VALIDATION_ERROR' });
  }
  const longItem = trimmed.find(i => i.length > MAX_ITEM_LENGTH);
  if (longItem) {
    throw Object.assign(new Error(`Item too long. Max ${MAX_ITEM_LENGTH} characters.`), { code: 'VALIDATION_ERROR' });
  }
  return trimmed;
}

// Returns { items: [{position, value}], version, updatedAt, lastModifiedBy }
async function getList(tenantId, listId = 'grocery') {
  validateListId(listId);
  const data = await repository.readList(tenantId, listId);
  const normalized = normalizeModifiedBy(data.lastModifiedBy);
  return {
    listId,
    items: data.items.map((value, i) => ({ position: i + 1, value })),
    count: data.items.length,
    version: data.version,
    updatedAt: data.updatedAt,
    lastModifiedBy: normalized,
  };
}

// Returns { addedItems, skippedItems, resultCount, version }
async function addItems(tenantId, listId = 'grocery', items, modifiedBy) {
  validateListId(listId);
  const trimmed = validateItems(items);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await repository.readList(tenantId, listId);
    const existing = current.items;

    const lowerExisting = existing.map(i => i.toLowerCase());
    const addedItems = [];
    const skippedItems = [];

    for (const item of trimmed) {
      if (lowerExisting.includes(item.toLowerCase())) {
        skippedItems.push(item);
      } else {
        addedItems.push(item);
        lowerExisting.push(item.toLowerCase());
      }
    }

    if (existing.length + addedItems.length > MAX_LIST_SIZE) {
      throw Object.assign(
        new Error(`List is full. Max ${MAX_LIST_SIZE} items allowed.`),
        { code: 'LIST_FULL' }
      );
    }

    const newItems = [...existing, ...addedItems];

    try {
      const newVersion = await repository.writeList(tenantId, listId, newItems, current.version, modifiedBy);
      return { addedItems, skippedItems, resultCount: newItems.length, version: newVersion };
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException' && attempt < MAX_RETRIES - 1) {
        continue; // retry with fresh read
      }
      throw err;
    }
  }
  throw Object.assign(new Error('Write conflict after retries. Please try again.'), { code: 'VERSION_CONFLICT' });
}

// selectors: array of { position, expectedValue } or { name }
// Returns { removedItems, notFoundItems, conflictItems, resultCount, version }
async function removeItems(tenantId, listId = 'grocery', selectors, expectedVersion, modifiedBy) {
  validateListId(listId);
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw Object.assign(new Error('selectors must be a non-empty array'), { code: 'VALIDATION_ERROR' });
  }

  const current = await repository.readList(tenantId, listId);

  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw Object.assign(
      new Error('List changed since read — call get_grocery_list and retry.'),
      { code: 'VERSION_CONFLICT' }
    );
  }

  const items = [...current.items];
  const removedItems = [];
  const notFoundItems = [];
  const conflictItems = [];

  // Collect indices to remove, highest first
  const indicesToRemove = new Set();

  for (const selector of selectors) {
    if (selector.position !== undefined) {
      const idx = selector.position - 1;
      if (idx < 0 || idx >= items.length) {
        notFoundItems.push(selector);
        continue;
      }
      if (selector.expectedValue && items[idx].toLowerCase() !== selector.expectedValue.toLowerCase()) {
        conflictItems.push({ selector, actual: items[idx] });
        continue;
      }
      indicesToRemove.add(idx);
    } else if (selector.name !== undefined) {
      const idx = items.findIndex(i => i.toLowerCase() === selector.name.toLowerCase());
      if (idx === -1) {
        notFoundItems.push(selector);
        continue;
      }
      indicesToRemove.add(idx);
    }
  }

  if (indicesToRemove.size === 0 && conflictItems.length === 0 && notFoundItems.length > 0) {
    return { removedItems: [], notFoundItems, conflictItems: [], resultCount: items.length, version: current.version };
  }

  const sortedIndices = [...indicesToRemove].sort((a, b) => b - a);
  for (const idx of sortedIndices) {
    removedItems.unshift(items.splice(idx, 1)[0]);
  }

  const newVersion = await repository.writeList(tenantId, listId, items, current.version, modifiedBy);
  return { removedItems, notFoundItems, conflictItems, resultCount: items.length, version: newVersion };
}

// Returns { clearedCount, resultCount, version, listId }
async function clearList(tenantId, listId = 'grocery', expectedVersion, modifiedBy) {
  validateListId(listId);
  const current = await repository.readList(tenantId, listId);

  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw Object.assign(
      new Error('List changed since read — call get_grocery_list and retry.'),
      { code: 'VERSION_CONFLICT' }
    );
  }

  const clearedCount = current.items.length;
  const newVersion = await repository.writeList(tenantId, listId, [], current.version, modifiedBy);
  return { clearedCount, resultCount: 0, version: newVersion, listId };
}

// Returns { previousCount, newCount, version, listId }
async function replaceList(tenantId, listId = 'grocery', items, expectedVersion, modifiedBy) {
  validateListId(listId);
  const trimmed = validateItems(items, { maxCount: MAX_LIST_SIZE });

  if (trimmed.length > MAX_LIST_SIZE) {
    throw Object.assign(
      new Error(`Too many items. Max ${MAX_LIST_SIZE} items allowed.`),
      { code: 'LIST_FULL' }
    );
  }

  const current = await repository.readList(tenantId, listId);

  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw Object.assign(
      new Error('List changed since read — call get_grocery_list and retry.'),
      { code: 'VERSION_CONFLICT' }
    );
  }

  const newVersion = await repository.writeList(tenantId, listId, trimmed, current.version, modifiedBy);
  return { previousCount: current.items.length, newCount: trimmed.length, version: newVersion, listId };
}

// Normalize lastModifiedBy to avoid exposing phone numbers
function normalizeModifiedBy(value) {
  if (!value) return null;
  if (value === 'mcp') return 'mcp';
  // Phone numbers start with +
  if (value.startsWith('+')) return 'sms-user';
  return value;
}

module.exports = {
  getList,
  addItems,
  removeItems,
  clearList,
  replaceList,
};
