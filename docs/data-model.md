# Data Model

## Overview

The application uses two DynamoDB tables. DynamoDB is a NoSQL key-value and document store — there are no SQL joins, no schemas to migrate, and no servers to manage. You read and write items by their primary key.

## Table 1: `GroceryTenants`

Stores one record per family. The **tenant** is identified by their Twilio phone number — the number a family texts to manage their list.

**Primary key:** `tenantId` (Partition Key, String)

| Attribute | Type | Description |
|-----------|------|-------------|
| `tenantId` | String (PK) | The Twilio `To` number, e.g. `+15034448534`. This is what identifies which family owns the list. |
| `familyName` | String | Human-readable label, e.g. `"Smith Family"`. Not used in app logic — for your reference only. |
| `authorizedNumbers` | List of Strings | Phone numbers allowed to send commands. Anyone not on this list is rejected. |
| `mcpApiKey` | String | A UUID used to authenticate future MCP server requests (e.g. from ChatGPT). Treat this like a password. |
| `createdAt` | String | ISO 8601 timestamp of when this tenant was added. |

**Example item:**
```json
{
  "tenantId": "+15034448534",
  "familyName": "Shavez Family",
  "authorizedNumbers": ["+15037812714", "+15035449035"],
  "mcpApiKey": "a3f8c2d1-7e4b-4a09-b56d-9f2e1c0d3a87",
  "createdAt": "2026-07-19T22:00:00Z"
}
```

## Table 2: `GroceryLists`

Stores the actual list items. The composite key (tenantId + listId) means one family can have multiple lists (e.g. `grocery`, `costco`, `hardware`).

**Primary key:** `tenantId` (Partition Key) + `listId` (Sort Key), both Strings

| Attribute | Type | Description |
|-----------|------|-------------|
| `tenantId` | String (PK) | The Twilio `To` number — same value as `GroceryTenants.tenantId`. Links back to the tenant. |
| `listId` | String (SK) | The list name. Defaults to `"grocery"` for all SMS commands. |
| `items` | List of Strings | The ordered list of grocery items. Index 0 = item 1 in the SMS reply. |
| `updatedAt` | String | ISO 8601 timestamp of the last write. |
| `lastModifiedBy` | String | The `From` phone number (for SMS changes) or `"mcp-server"` (for future MCP changes). Audit trail. |

**Example item:**
```json
{
  "tenantId": "+15034448534",
  "listId": "grocery",
  "items": ["milk", "bread", "eggs"],
  "updatedAt": "2026-07-19T22:15:00Z",
  "lastModifiedBy": "+15037812714"
}
```

## How Multi-Tenancy Works

The `tenantId` in both tables is always the **Twilio `To` number** — the number that received the SMS. Twilio includes this in every webhook POST as `req.body.To`.

```
Family A texts +15034448534  →  tenantId = "+15034448534"  →  Family A's list
Family B texts +15039990000  →  tenantId = "+15039990000"  →  Family B's list
```

Because every DynamoDB read and write is scoped to `tenantId`, families can never see each other's data. Adding a new family is just adding a new row to `GroceryTenants` — no code changes needed.

## How the Lists Are Stored

Items are stored as a native DynamoDB `List<String>`, not a comma-separated string (that was the old `list.txt` approach). This means:

- Items can contain commas, spaces, and special characters without breaking parsing
- Removing item #2 is a simple `Array.splice(1, 1)` on the JavaScript array — no string manipulation
- The order of items is preserved

## DynamoDB Billing

Both tables use `PAY_PER_REQUEST` (on-demand) billing. There is no capacity to provision or estimate. You pay per read/write unit consumed. At household grocery list usage (dozens of requests per week), the monthly cost is effectively **$0.00** — well within the free tier.

## Adding or Modifying a Tenant

See [Operations Guide](operations.md) for the exact AWS CLI commands to add a new family, update authorized numbers, or rotate the MCP API key.
