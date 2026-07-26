'use strict';

// Mock repository before requiring service
jest.mock('../src/repository');
const repository = require('../src/repository');
const service = require('../src/service');

const TENANT = 'tenant-1';
const LIST_ID = 'grocery';

beforeEach(() => {
  jest.clearAllMocks();
});

// --- getList ---

describe('getList', () => {
  test('returns empty list', async () => {
    repository.readList.mockResolvedValue({ items: [], version: 0, updatedAt: null, lastModifiedBy: null });
    const result = await service.getList(TENANT, LIST_ID);
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.version).toBe(0);
  });

  test('returns numbered items', async () => {
    repository.readList.mockResolvedValue({ items: ['milk', 'eggs'], version: 3, updatedAt: '2026-07-01T00:00:00Z', lastModifiedBy: '+15550000001' });
    const result = await service.getList(TENANT, LIST_ID);
    expect(result.items).toEqual([
      { position: 1, value: 'milk' },
      { position: 2, value: 'eggs' },
    ]);
    expect(result.count).toBe(2);
    expect(result.version).toBe(3);
  });

  test('normalizes phone number lastModifiedBy to sms-user', async () => {
    repository.readList.mockResolvedValue({ items: ['milk'], version: 1, updatedAt: null, lastModifiedBy: '+15550000001' });
    const result = await service.getList(TENANT, LIST_ID);
    expect(result.lastModifiedBy).toBe('sms-user');
  });

  test('preserves mcp as lastModifiedBy', async () => {
    repository.readList.mockResolvedValue({ items: [], version: 1, updatedAt: null, lastModifiedBy: 'mcp' });
    const result = await service.getList(TENANT, LIST_ID);
    expect(result.lastModifiedBy).toBe('mcp');
  });

  test('rejects invalid listId', async () => {
    await expect(service.getList(TENANT, 'invalid id!')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

// --- addItems ---

describe('addItems', () => {
  function mockRead(items = [], version = 0) {
    repository.readList.mockResolvedValue({ items, version, updatedAt: null, lastModifiedBy: null });
  }

  test('adds a single item', async () => {
    mockRead();
    repository.writeList.mockResolvedValue(1);
    const result = await service.addItems(TENANT, LIST_ID, ['milk'], 'mcp');
    expect(result.addedItems).toEqual(['milk']);
    expect(result.skippedItems).toEqual([]);
    expect(result.resultCount).toBe(1);
    expect(result.version).toBe(1);
  });

  test('adds multiple items', async () => {
    mockRead();
    repository.writeList.mockResolvedValue(1);
    const result = await service.addItems(TENANT, LIST_ID, ['milk', 'eggs', 'bread'], 'mcp');
    expect(result.addedItems).toHaveLength(3);
    expect(result.resultCount).toBe(3);
  });

  test('trims whitespace from items', async () => {
    mockRead();
    repository.writeList.mockResolvedValue(1);
    const result = await service.addItems(TENANT, LIST_ID, ['  milk  ', ' eggs'], 'mcp');
    expect(result.addedItems).toEqual(['milk', 'eggs']);
  });

  test('rejects blank items', async () => {
    await expect(service.addItems(TENANT, LIST_ID, ['milk', '   '], 'mcp')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('rejects over-length item', async () => {
    await expect(service.addItems(TENANT, LIST_ID, ['a'.repeat(101)], 'mcp')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('rejects over 20 items per request', async () => {
    await expect(service.addItems(TENANT, LIST_ID, new Array(21).fill('item'), 'mcp')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('skips case-insensitive duplicates', async () => {
    mockRead(['Milk'], 1);
    repository.writeList.mockResolvedValue(2);
    const result = await service.addItems(TENANT, LIST_ID, ['milk', 'eggs'], 'mcp');
    expect(result.addedItems).toEqual(['eggs']);
    expect(result.skippedItems).toEqual(['milk']);
  });

  test('rejects when list would exceed MAX_LIST_SIZE', async () => {
    mockRead(new Array(50).fill('item'));
    await expect(service.addItems(TENANT, LIST_ID, ['one more'], 'mcp')).rejects.toMatchObject({ code: 'LIST_FULL' });
  });

  test('increments version', async () => {
    mockRead([], 5);
    repository.writeList.mockResolvedValue(6);
    const result = await service.addItems(TENANT, LIST_ID, ['milk'], 'mcp');
    expect(result.version).toBe(6);
  });

  test('retries on version conflict', async () => {
    const { ConditionalCheckFailedException } = require('@aws-sdk/client-dynamodb');
    // First read and write conflict, second attempt succeeds
    repository.readList
      .mockResolvedValueOnce({ items: [], version: 0, updatedAt: null, lastModifiedBy: null })
      .mockResolvedValueOnce({ items: [], version: 1, updatedAt: null, lastModifiedBy: null });
    const conflictErr = Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
    repository.writeList
      .mockRejectedValueOnce(conflictErr)
      .mockResolvedValueOnce(2);
    const result = await service.addItems(TENANT, LIST_ID, ['milk'], 'mcp');
    expect(result.version).toBe(2);
    expect(repository.writeList).toHaveBeenCalledTimes(2);
  });
});

// --- removeItems ---

describe('removeItems', () => {
  function mockRead(items = ['milk', 'eggs', 'bread'], version = 3) {
    repository.readList.mockResolvedValue({ items, version, updatedAt: null, lastModifiedBy: null });
  }

  test('removes by position + expectedValue', async () => {
    mockRead();
    repository.writeList.mockResolvedValue(4);
    const result = await service.removeItems(TENANT, LIST_ID, [{ position: 1, expectedValue: 'milk' }], 3, 'mcp');
    expect(result.removedItems).toEqual(['milk']);
    expect(result.resultCount).toBe(2);
  });

  test('removes by name', async () => {
    mockRead();
    repository.writeList.mockResolvedValue(4);
    const result = await service.removeItems(TENANT, LIST_ID, [{ name: 'eggs' }], 3, 'mcp');
    expect(result.removedItems).toEqual(['eggs']);
  });

  test('name match is case-insensitive', async () => {
    mockRead();
    repository.writeList.mockResolvedValue(4);
    const result = await service.removeItems(TENANT, LIST_ID, [{ name: 'MILK' }], 3, 'mcp');
    expect(result.removedItems).toEqual(['milk']);
  });

  test('reports NOT_FOUND for missing item', async () => {
    mockRead();
    const result = await service.removeItems(TENANT, LIST_ID, [{ name: 'butter' }], 3, 'mcp');
    expect(result.removedItems).toEqual([]);
    expect(result.notFoundItems).toHaveLength(1);
  });

  test('reports CONFLICT when expectedValue does not match', async () => {
    mockRead();
    repository.writeList.mockResolvedValue(4);
    const result = await service.removeItems(TENANT, LIST_ID, [{ position: 1, expectedValue: 'butter' }], 3, 'mcp');
    expect(result.conflictItems).toHaveLength(1);
    expect(result.removedItems).toEqual([]);
  });

  test('throws VERSION_CONFLICT when version does not match', async () => {
    mockRead(undefined, 5);
    await expect(service.removeItems(TENANT, LIST_ID, [{ name: 'milk' }], 3, 'mcp')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  test('removes multiple items', async () => {
    mockRead();
    repository.writeList.mockResolvedValue(4);
    const result = await service.removeItems(TENANT, LIST_ID, [{ name: 'milk' }, { name: 'eggs' }], 3, 'mcp');
    expect(result.removedItems).toHaveLength(2);
    expect(result.resultCount).toBe(1);
  });
});

// --- clearList ---

describe('clearList', () => {
  test('clears a non-empty list', async () => {
    repository.readList.mockResolvedValue({ items: ['milk', 'eggs'], version: 2, updatedAt: null, lastModifiedBy: null });
    repository.writeList.mockResolvedValue(3);
    const result = await service.clearList(TENANT, LIST_ID, 2, 'mcp');
    expect(result.clearedCount).toBe(2);
    expect(result.resultCount).toBe(0);
    expect(result.version).toBe(3);
  });

  test('clearing an empty list is idempotent', async () => {
    repository.readList.mockResolvedValue({ items: [], version: 1, updatedAt: null, lastModifiedBy: null });
    repository.writeList.mockResolvedValue(2);
    const result = await service.clearList(TENANT, LIST_ID, 1, 'mcp');
    expect(result.clearedCount).toBe(0);
    expect(result.resultCount).toBe(0);
  });

  test('throws VERSION_CONFLICT when version does not match', async () => {
    repository.readList.mockResolvedValue({ items: ['milk'], version: 5, updatedAt: null, lastModifiedBy: null });
    await expect(service.clearList(TENANT, LIST_ID, 3, 'mcp')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  test('clears without expectedVersion (unconditional)', async () => {
    repository.readList.mockResolvedValue({ items: ['milk'], version: 2, updatedAt: null, lastModifiedBy: null });
    repository.writeList.mockResolvedValue(3);
    const result = await service.clearList(TENANT, LIST_ID, undefined, 'mcp');
    expect(result.clearedCount).toBe(1);
  });
});

// --- replaceList ---

describe('replaceList', () => {
  test('replaces list with new items', async () => {
    repository.readList.mockResolvedValue({ items: ['milk'], version: 1, updatedAt: null, lastModifiedBy: null });
    repository.writeList.mockResolvedValue(2);
    const result = await service.replaceList(TENANT, LIST_ID, ['eggs', 'bread', 'butter'], 1, 'mcp');
    expect(result.previousCount).toBe(1);
    expect(result.newCount).toBe(3);
    expect(result.version).toBe(2);
  });

  test('rejects over-size replacement', async () => {
    await expect(service.replaceList(TENANT, LIST_ID, new Array(51).fill('item'), 0, 'mcp')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  test('throws VERSION_CONFLICT on mismatch', async () => {
    repository.readList.mockResolvedValue({ items: [], version: 5, updatedAt: null, lastModifiedBy: null });
    await expect(service.replaceList(TENANT, LIST_ID, ['milk'], 3, 'mcp')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  test('rejects blank items', async () => {
    await expect(service.replaceList(TENANT, LIST_ID, ['milk', ''], 0, 'mcp')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
