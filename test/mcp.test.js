'use strict';

const request = require('supertest');
const crypto = require('crypto');

// Mock AWS SDK before loading any app modules
const mockDynamoSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDynamoSend })) },
  GetCommand: jest.fn(input => ({ input })),
  PutCommand: jest.fn(input => ({ input })),
  QueryCommand: jest.fn(input => ({ input })),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({ Parameters: [] }) })),
  GetParametersCommand: jest.fn(input => ({ input })),
}));

const { app } = require('../twilio.js');

// Test tenants
const TENANT_A_ID = '+15550000000';
const TENANT_A_KEY = 'test-api-key-tenant-a-1234567890';
const TENANT_A_HASH = crypto.createHash('sha256').update(TENANT_A_KEY).digest('hex');

const TENANT_B_ID = '+15550001111';
const TENANT_B_KEY = 'test-api-key-tenant-b-9876543210';
const TENANT_B_HASH = crypto.createHash('sha256').update(TENANT_B_KEY).digest('hex');

function makeTenant(tenantId, hash) {
  return { tenantId, mcpApiKeyHash: hash, familyName: 'Test', authorizedNumbers: [] };
}

// Helper: setup DynamoDB mocks for MCP tests
function setupMcpDynamo({ tenantA = true, tenantB = false, items = [], version = 0 } = {}) {
  mockDynamoSend.mockImplementation(cmd => {
    const table = cmd.input?.TableName;
    const indexName = cmd.input?.IndexName;

    // GSI query for tenant lookup by hash
    if (table === 'GroceryTenants' && indexName === 'mcpApiKeyHash-index') {
      const hashValue = cmd.input?.ExpressionAttributeValues?.[':h'];
      if (tenantA && hashValue === TENANT_A_HASH) {
        return Promise.resolve({ Items: [makeTenant(TENANT_A_ID, TENANT_A_HASH)] });
      }
      if (tenantB && hashValue === TENANT_B_HASH) {
        return Promise.resolve({ Items: [makeTenant(TENANT_B_ID, TENANT_B_HASH)] });
      }
      return Promise.resolve({ Items: [] });
    }

    // GetCommand for GroceryLists
    if (table === 'GroceryLists') {
      if (cmd.input?.Item) return Promise.resolve({}); // PutCommand
      return Promise.resolve({ Item: { items, version } });
    }

    return Promise.resolve({});
  });
}

// Helper: send a JSON-RPC MCP request with required Accept header
function mcpPost(body, token = TENANT_A_KEY) {
  const req = request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

// Parse SSE or JSON response body into a JSON-RPC response object
function parseMcpResponse(res) {
  const text = res.text;
  // If the response is plain JSON (e.g., 401 error), parse directly
  if (res.headers['content-type']?.includes('application/json')) {
    return JSON.parse(text);
  }
  // SSE format: extract the last "data:" line
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('data: ')) {
      return JSON.parse(lines[i].slice(6));
    }
  }
  // Fallback: try raw JSON
  return JSON.parse(text);
}

beforeEach(() => {
  jest.clearAllMocks();
  setupMcpDynamo();
});

// --- Authentication ---

describe('authentication', () => {
  test('missing Authorization header returns 401', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    expect(res.status).toBe(401);
  });

  test('invalid bearer token returns 401', async () => {
    const res = await mcpPost(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
      'invalid-token'
    );
    expect(res.status).toBe(401);
  });

  test('valid bearer token returns 200', async () => {
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    expect(res.status).toBe(200);
  });
});

// --- CORS ---

describe('CORS', () => {
  test('OPTIONS returns 200 with CORS headers', async () => {
    const res = await request(app).options('/mcp');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

// --- Initialize ---

describe('initialize', () => {
  test('returns protocol version', async () => {
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    expect(body.result).toBeDefined();
    expect(body.result.protocolVersion).toBeDefined();
  });
});

// --- Tool discovery ---

describe('tools/list', () => {
  test('returns all 5 tools', async () => {
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    });
    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    const toolNames = body.result.tools.map(t => t.name);
    expect(toolNames).toContain('get_grocery_list');
    expect(toolNames).toContain('add_grocery_items');
    expect(toolNames).toContain('remove_grocery_items');
    expect(toolNames).toContain('clear_grocery_list');
    expect(toolNames).toContain('replace_grocery_list');
  });

  test('get_grocery_list has readOnlyHint: true', async () => {
    const res = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const body = parseMcpResponse(res);
    const tool = body.result.tools.find(t => t.name === 'get_grocery_list');
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  test('clear_grocery_list has destructiveHint: true', async () => {
    const res = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const body = parseMcpResponse(res);
    const tool = body.result.tools.find(t => t.name === 'clear_grocery_list');
    expect(tool.annotations.destructiveHint).toBe(true);
  });
});

// --- get_grocery_list ---

describe('get_grocery_list tool', () => {
  test('returns empty list', async () => {
    setupMcpDynamo({ items: [], version: 0 });
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_grocery_list', arguments: {} },
    });
    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.version).toBe(0);
  });

  test('returns items with positions', async () => {
    setupMcpDynamo({ items: ['milk', 'eggs'], version: 3 });
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_grocery_list', arguments: {} },
    });
    const body = parseMcpResponse(res);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.items).toEqual([
      { position: 1, value: 'milk' },
      { position: 2, value: 'eggs' },
    ]);
    expect(result.version).toBe(3);
  });
});

// --- add_grocery_items ---

describe('add_grocery_items tool', () => {
  test('adds items successfully', async () => {
    setupMcpDynamo({ items: [], version: 0 });
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'add_grocery_items', arguments: { items: ['milk', 'eggs'] } },
    });
    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.addedItems).toEqual(['milk', 'eggs']);
    expect(result.skippedItems).toEqual([]);
  });

  test('skips duplicate items', async () => {
    setupMcpDynamo({ items: ['milk'], version: 1 });
    mockDynamoSend.mockImplementation(cmd => {
      if (cmd.input?.IndexName === 'mcpApiKeyHash-index') {
        return Promise.resolve({ Items: [makeTenant(TENANT_A_ID, TENANT_A_HASH)] });
      }
      if (cmd.input?.TableName === 'GroceryLists') {
        if (cmd.input?.Item) return Promise.resolve({});
        return Promise.resolve({ Item: { items: ['milk'], version: 1 } });
      }
      return Promise.resolve({});
    });

    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'add_grocery_items', arguments: { items: ['Milk', 'eggs'] } },
    });
    const body = parseMcpResponse(res);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.skippedItems).toContain('Milk');
    expect(result.addedItems).toContain('eggs');
  });
});

// --- remove_grocery_items ---

describe('remove_grocery_items tool', () => {
  test('removes item by name', async () => {
    setupMcpDynamo({ items: ['milk', 'eggs'], version: 2 });
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'remove_grocery_items',
        arguments: { items: [{ name: 'milk' }], expectedVersion: 2 },
      },
    });
    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.removedItems).toContain('milk');
  });

  test('returns not-found for missing item', async () => {
    setupMcpDynamo({ items: ['milk'], version: 1 });
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'remove_grocery_items',
        arguments: { items: [{ name: 'eggs' }], expectedVersion: 1 },
      },
    });
    const body = parseMcpResponse(res);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.notFoundItems).toHaveLength(1);
  });

  test('returns isError on version conflict', async () => {
    setupMcpDynamo({ items: ['milk'], version: 5 });
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'remove_grocery_items',
        arguments: { items: [{ name: 'milk' }], expectedVersion: 2 },
      },
    });
    const body = parseMcpResponse(res);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('changed since read');
  });
});

// --- clear_grocery_list ---

describe('clear_grocery_list tool', () => {
  test('clears the list', async () => {
    setupMcpDynamo({ items: ['milk', 'eggs'], version: 3 });
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'clear_grocery_list', arguments: { expectedVersion: 3 } },
    });
    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.clearedCount).toBe(2);
    expect(result.resultCount).toBe(0);
  });
});

// --- replace_grocery_list ---

describe('replace_grocery_list tool', () => {
  test('replaces list atomically', async () => {
    setupMcpDynamo({ items: ['milk'], version: 2 });
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'replace_grocery_list',
        arguments: { items: ['chicken', 'pasta', 'olive oil'], expectedVersion: 2 },
      },
    });
    expect(res.status).toBe(200);
    const body = parseMcpResponse(res);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.previousCount).toBe(1);
    expect(result.newCount).toBe(3);
  });
});

// --- Tenant isolation ---

describe('tenant isolation', () => {
  test('tenant B cannot read tenant A list', async () => {
    // Set up both tenants in the GSI, but lists are isolated by tenantId
    mockDynamoSend.mockImplementation(cmd => {
      const indexName = cmd.input?.IndexName;
      const table = cmd.input?.TableName;

      if (indexName === 'mcpApiKeyHash-index') {
        const hashValue = cmd.input?.ExpressionAttributeValues?.[':h'];
        if (hashValue === TENANT_A_HASH) return Promise.resolve({ Items: [makeTenant(TENANT_A_ID, TENANT_A_HASH)] });
        if (hashValue === TENANT_B_HASH) return Promise.resolve({ Items: [makeTenant(TENANT_B_ID, TENANT_B_HASH)] });
        return Promise.resolve({ Items: [] });
      }

      if (table === 'GroceryLists') {
        if (cmd.input?.Item) return Promise.resolve({});
        const tenantId = cmd.input?.Key?.tenantId;
        if (tenantId === TENANT_A_ID) {
          return Promise.resolve({ Item: { items: ['secret item'], version: 1 } });
        }
        return Promise.resolve({ Item: { items: [], version: 0 } });
      }

      return Promise.resolve({});
    });

    // Tenant B calls get_grocery_list — should see their own empty list, not tenant A's
    const res = await mcpPost(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_grocery_list', arguments: {} } },
      TENANT_B_KEY
    );
    const body = parseMcpResponse(res);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
  });
});

// --- Cross-channel consistency ---

describe('cross-channel consistency', () => {
  test('item added via SMS (writeListUnconditional) appears in MCP get_grocery_list', async () => {
    // Simulate: SMS added 'milk' to DynamoDB, now MCP reads it
    setupMcpDynamo({ items: ['milk'], version: 1 });
    const res = await mcpPost({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_grocery_list', arguments: {} },
    });
    const body = parseMcpResponse(res);
    const result = JSON.parse(body.result.content[0].text);
    expect(result.items[0].value).toBe('milk');
  });
});
