# Data Model

## Overview

Two DynamoDB tables. `GroceryTenants` has one record per family. `GroceryLists` has one record per list per family.

---

## Table 1: `GroceryTenants`

**Primary key:** `tenantId` (Partition Key, String)

**GSI:** `mcpApiKeyHash-index` — partition key `mcpApiKeyHash`. Used for O(1) bearer token lookup without a table scan.

| Attribute | Type | Description |
|-----------|------|-------------|
| `tenantId` | String (PK) | The Twilio `To` number, e.g. `+15034448534`. Identifies the family. |
| `familyName` | String | Human-readable label. Not used in app logic. |
| `authorizedNumbers` | List\<String\> | Phone numbers allowed to send SMS commands. |
| `mcpApiKey` | String | UUID used as the bearer token for ChatGPT MCP auth. Treat like a password. |
| `mcpApiKeyHash` | String | SHA-256 hex of `mcpApiKey`. Queried by the `mcpApiKeyHash-index` GSI. Never the plaintext key. |
| `createdAt` | String | ISO 8601 timestamp. |

**Example:**
```json
{
  "tenantId": "+15034448534",
  "familyName": "Shavez Family",
  "authorizedNumbers": ["+15037812714", "+15035449035"],
  "mcpApiKey": "a3f8c2d1-7e4b-4a09-b56d-9f2e1c0d3a87",
  "mcpApiKeyHash": "e3b0c44298fc1c149afbf4c8996fb924...",
  "createdAt": "2026-07-19T22:00:00Z"
}
```

**Security note:** `mcpApiKey` (plaintext) is stored in DynamoDB at rest (encrypted by AWS managed keys). `mcpApiKeyHash` is what the application queries — a compromise of the hash alone cannot reconstruct the original key.

---

## Table 2: `GroceryLists`

**Primary key:** `tenantId` (Partition Key) + `listId` (Sort Key), both Strings

| Attribute | Type | Description |
|-----------|------|-------------|
| `tenantId` | String (PK) | The Twilio `To` number — links to `GroceryTenants`. |
| `listId` | String (SK) | List name. Defaults to `"grocery"` for all SMS and MCP operations. |
| `items` | List\<String\> | Ordered list of grocery items. Index 0 = item 1. |
| `version` | Number | Optimistic locking counter. Incremented on every write. |
| `updatedAt` | String | ISO 8601 timestamp of last write. |
| `lastModifiedBy` | String | `"mcp"` for ChatGPT writes, `"sms-user"` for SMS writes (phone numbers are normalized, never stored raw). |

**Example:**
```json
{
  "tenantId": "+15034448534",
  "listId": "grocery",
  "items": ["milk", "bread", "eggs"],
  "version": 7,
  "updatedAt": "2026-07-26T23:00:00Z",
  "lastModifiedBy": "mcp"
}
```

---

## Optimistic Locking

The `version` field prevents lost updates when SMS and ChatGPT write concurrently.

Every write uses a DynamoDB conditional expression:
```
attribute_not_exists(version) OR version = :expected
```

- If the list was never written: `attribute_not_exists` passes, `version` is set to `1`
- If version matches: write succeeds, version increments
- If version doesn't match: `ConditionalCheckFailedException` is thrown

**Lazy migration:** Lists written before the `version` field was added have no `version` attribute. The `attribute_not_exists` branch handles them on first write — no batch migration needed.

**Retry behavior by operation:**
- `addItems` — retries up to 3× automatically (duplicate skipping makes it safe)
- `removeItems`, `clearList`, `replaceList` — returns `VERSION_CONFLICT` to the caller (ChatGPT re-reads and retries via tool description guidance)
- SMS path — uses `writeListUnconditional`, which reads the current version before each write

---

## Multi-Tenancy

The `tenantId` in both tables is always the Twilio `To` number. Every read and write is scoped to `tenantId` — families can never see each other's data.

```
Family A texts +15034448534  →  tenantId = "+15034448534"  →  Family A's list
Family B texts +15039990000  →  tenantId = "+15039990000"  →  Family B's list
```

Adding a new family = one `put-item` to `GroceryTenants`. No code changes.

---

## DynamoDB Billing

Both tables use `PAY_PER_REQUEST`. At household grocery list usage, monthly cost is effectively **$0.00**.

Both tables have `DeletionPolicy: Retain` — deleting the CloudFormation stack will **not** delete the tables or data.

---

## Adding or Modifying a Tenant

See [Operations Guide](operations.md) for exact AWS CLI commands.
