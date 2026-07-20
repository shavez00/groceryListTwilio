'use strict';

const request = require('supertest');

// --- AWS SDK mocks ---

const mockDynamoSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDynamoSend })) },
  GetCommand: jest.fn(input => ({ input })),
  PutCommand: jest.fn(input => ({ input })),
  UpdateCommand: jest.fn(input => ({ input })),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({})),
  GetParametersCommand: jest.fn(input => ({ input })),
}));

// SSM always returns test credentials
const { SSMClient } = require('@aws-sdk/client-ssm');
SSMClient.mockImplementation(() => ({
  send: jest.fn().mockResolvedValue({
    Parameters: [
      { Name: '/grocerylist/twilio/accountSID', Value: 'ACtest' },
      { Name: '/grocerylist/twilio/apiKeySID',  Value: 'SKtest' },
      { Name: '/grocerylist/twilio/apiKeySecret', Value: 'secret' },
    ],
  }),
}));

const { app } = require('./twilio.js');

// Helper: build a form-encoded POST to /sms
function sms(to, from, body) {
  return request(app)
    .post('/sms')
    .type('form')
    .send({ To: to, From: from, Body: body });
}

// Helper: configure DynamoDB responses for a request
// authorizedNumbers: array of phone numbers (or null to simulate missing tenant)
// items: current list items
function setupDynamo({ authorizedNumbers = ['+15550000001'], items = [] } = {}) {
  mockDynamoSend.mockImplementation(cmd => {
    const table = cmd.input?.TableName;
    if (table === 'GroceryTenants') {
      if (authorizedNumbers === null) return Promise.resolve({ Item: undefined });
      return Promise.resolve({
        Item: { tenantId: '+15550000000', authorizedNumbers, familyName: 'Test' },
      });
    }
    if (table === 'GroceryLists') {
      // PutCommand has no Key
      if (cmd.input?.Item) return Promise.resolve({});
      return Promise.resolve({ Item: { items } });
    }
    return Promise.resolve({});
  });
}

const TO   = '+15550000000';
const FROM = '+15550000001';

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the cached twilioSecrets so SSM is re-fetched if needed
  const mod = require('./twilio.js');
  // secrets are module-scoped; resetting requires re-requiring or exposing reset — instead
  // we rely on the SSM mock always returning the same values.
});

// --- Tests ---

describe('authorization', () => {
  test('unauthorized number returns rejection message', async () => {
    setupDynamo({ authorizedNumbers: ['+15559999999'] });
    const res = await sms(TO, FROM, 'list');
    expect(res.status).toBe(200);
    expect(res.text).toContain('not authorized');
  });

  test('missing tenant returns rejection message', async () => {
    setupDynamo({ authorizedNumbers: null });
    const res = await sms(TO, FROM, 'list');
    expect(res.status).toBe(200);
    expect(res.text).toContain('not authorized');
  });
});

describe('list command', () => {
  test('empty list returns empty message', async () => {
    setupDynamo({ items: [] });
    const res = await sms(TO, FROM, 'list');
    expect(res.text).toContain('List is currently empty');
  });

  test('non-empty list returns numbered items', async () => {
    setupDynamo({ items: ['milk', 'eggs'] });
    const res = await sms(TO, FROM, 'list');
    expect(res.text).toContain('1. milk');
    expect(res.text).toContain('2. eggs');
  });
});

describe('add command', () => {
  test('add with no item returns guidance', async () => {
    setupDynamo({ items: [] });
    const res = await sms(TO, FROM, 'add');
    expect(res.text).toContain('Please specify an item');
  });

  test('add single item succeeds', async () => {
    setupDynamo({ items: [] });
    const res = await sms(TO, FROM, 'add milk');
    expect(res.text).toContain('Added: milk');
  });

  test('add multiple comma-separated items succeeds', async () => {
    setupDynamo({ items: [] });
    const res = await sms(TO, FROM, 'add milk, eggs, bread');
    expect(res.text).toContain('Added: milk, eggs, bread');
  });

  test('item name over MAX_ITEM_LENGTH is rejected', async () => {
    setupDynamo({ items: [] });
    const longItem = 'a'.repeat(101);
    const res = await sms(TO, FROM, `add ${longItem}`);
    expect(res.text).toContain('100 characters or fewer');
  });

  test('adding beyond MAX_LIST_SIZE is rejected', async () => {
    setupDynamo({ items: new Array(50).fill('item') });
    const res = await sms(TO, FROM, 'add one more');
    expect(res.text).toContain('List is full');
  });
});

describe('remove command', () => {
  test('remove by valid number removes item', async () => {
    setupDynamo({ items: ['milk', 'eggs'] });
    const res = await sms(TO, FROM, 'remove 1');
    expect(res.text).toContain('Removed: milk');
  });

  test('remove by name (case-insensitive) removes item', async () => {
    setupDynamo({ items: ['milk', 'eggs'] });
    const res = await sms(TO, FROM, 'remove Eggs');
    expect(res.text).toContain('Removed: eggs');
  });

  test('remove with out-of-range number returns error', async () => {
    setupDynamo({ items: ['milk'] });
    const res = await sms(TO, FROM, 'remove 5');
    expect(res.text).toContain('out of range');
  });

  test('remove by name not on list returns error', async () => {
    setupDynamo({ items: ['milk'] });
    const res = await sms(TO, FROM, 'remove bread');
    expect(res.text).toContain('not found');
  });
});

describe('clear command', () => {
  test('clear empties the list', async () => {
    setupDynamo({ items: ['milk', 'eggs'] });
    const res = await sms(TO, FROM, 'clear');
    expect(res.text).toContain('List cleared');
  });
});

describe('unknown command', () => {
  test('unknown command returns help text', async () => {
    setupDynamo({ items: [] });
    const res = await sms(TO, FROM, 'hello');
    expect(res.text).toContain('Commands:');
  });
});

describe('error handling', () => {
  test('DynamoDB failure returns friendly TwiML error', async () => {
    mockDynamoSend.mockRejectedValue(new Error('DynamoDB unavailable'));
    const res = await sms(TO, FROM, 'list');
    expect(res.status).toBe(200);
    expect(res.text).toContain('something went wrong');
  });
});
