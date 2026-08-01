'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TENANTS_TABLE = process.env.TENANTS_TABLE || 'GroceryTenants';
const LISTS_TABLE = process.env.LISTS_TABLE || 'GroceryLists';
const DEFAULT_LIST = 'grocery';

// Returns { items, version, updatedAt, lastModifiedBy }
async function readList(tenantId, listId = DEFAULT_LIST) {
  const result = await dynamo.send(new GetCommand({
    TableName: LISTS_TABLE,
    Key: { tenantId, listId },
  }));
  return {
    items: result.Item?.items ?? [],
    version: result.Item?.version ?? 0,
    updatedAt: result.Item?.updatedAt ?? null,
    lastModifiedBy: result.Item?.lastModifiedBy ?? null,
  };
}

// Conditional write — throws ConditionalCheckFailedException on version mismatch
async function writeList(tenantId, listId = DEFAULT_LIST, items, expectedVersion, modifiedBy) {
  const newVersion = expectedVersion + 1;
  await dynamo.send(new PutCommand({
    TableName: LISTS_TABLE,
    Item: {
      tenantId,
      listId,
      items,
      version: newVersion,
      updatedAt: new Date().toISOString(),
      lastModifiedBy: modifiedBy,
    },
    ConditionExpression: 'attribute_not_exists(#v) OR #v = :expected',
    ExpressionAttributeNames: { '#v': 'version' },
    ExpressionAttributeValues: { ':expected': expectedVersion },
  }));
  return newVersion;
}

// Unconditional write — used by SMS path (no version tracking required for SMS)
async function writeListUnconditional(tenantId, listId = DEFAULT_LIST, items, modifiedBy) {
  const result = await readList(tenantId, listId);
  const newVersion = result.version + 1;
  await dynamo.send(new PutCommand({
    TableName: LISTS_TABLE,
    Item: {
      tenantId,
      listId,
      items,
      version: newVersion,
      updatedAt: new Date().toISOString(),
      lastModifiedBy: modifiedBy,
    },
  }));
}

// Returns true if fromNumber is authorized for the tenant
async function isAuthorized(tenantId, fromNumber) {
  const result = await dynamo.send(new GetCommand({
    TableName: TENANTS_TABLE,
    Key: { tenantId },
  }));
  if (!result.Item) return false;
  return result.Item.authorizedNumbers?.includes(fromNumber) ?? false;
}

// Returns the full tenant record by mcpApiKeyHash, or null if not found
async function getTenantByApiKeyHash(hash) {
  const result = await dynamo.send(new QueryCommand({
    TableName: TENANTS_TABLE,
    IndexName: 'mcpApiKeyHash-index',
    KeyConditionExpression: 'mcpApiKeyHash = :h',
    ExpressionAttributeValues: { ':h': hash },
    Limit: 1,
  }));
  return result.Items?.[0] ?? null;
}

// Returns the raw tenant record by tenantId (used by SMS announce)
async function getTenant(tenantId) {
  const result = await dynamo.send(new GetCommand({
    TableName: TENANTS_TABLE,
    Key: { tenantId },
  }));
  return result.Item ?? null;
}

// Atomically add a refresh token hash to the revocation set
async function revokeRefreshToken(tenantId, tokenHash) {
  await dynamo.send(new UpdateCommand({
    TableName: TENANTS_TABLE,
    Key: { tenantId },
    UpdateExpression: 'ADD revokedRefreshTokenHashes :hash',
    ExpressionAttributeValues: { ':hash': new Set([tokenHash]) },
  }));
}

// Check if a refresh token hash has been revoked
async function isRefreshTokenRevoked(tenantId, tokenHash) {
  const result = await dynamo.send(new GetCommand({
    TableName: TENANTS_TABLE,
    Key: { tenantId },
  }));
  if (!result.Item) return false;
  const revokedSet = result.Item.revokedRefreshTokenHashes ?? new Set();
  return revokedSet.has(tokenHash);
}

module.exports = {
  readList,
  writeList,
  writeListUnconditional,
  isAuthorized,
  getTenantByApiKeyHash,
  getTenant,
  revokeRefreshToken,
  isRefreshTokenRevoked,
};
