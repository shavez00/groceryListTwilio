# How the Application Works

## Overview

Family members can manage a shared grocery list in two ways:

1. **SMS** — text a Twilio phone number with commands like `add milk`
2. **ChatGPT (MCP)** — ask ChatGPT to add, remove, or replace items using natural language

Both channels read and write the same DynamoDB record. A change made via SMS is immediately visible to ChatGPT, and vice versa.

---

## SMS Channel

```
Family member's phone
        │
        │  SMS: "add milk"
        ▼
  Twilio (SMS carrier)
        │
        │  HTTP POST to grocerylist.vezcore.com/sms
        ▼
  AWS Lambda (routes/sms.js)
        │
        ├─► DynamoDB (read/write list)
        │
        │  TwiML XML: "Added: milk"
        ▼
  Twilio → SMS reply: "Added: milk"
        ▼
Family member's phone
```

### SMS Commands

All commands are case-insensitive.

| Command | Example | What it does |
|---------|---------|--------------|
| `add {item}` | `add milk` | Adds one item |
| `add {item}, {item}, ...` | `add milk, eggs, bread` | Adds multiple items |
| `list` | `list` | Returns the full numbered list |
| `remove {#}` | `remove 2` | Removes item by number |
| `remove {name}` | `remove eggs` | Removes item by name (case-insensitive) |
| `remove {#},{#},...` | `remove 2,3,4` | Removes multiple items by number |
| `remove {name},{name},...` | `remove eggs, bread` | Removes multiple items by name |
| `clear` | `clear` | Empties the entire list |
| `announce {message}` | `announce dinner is ready` | Broadcasts SMS to all authorized numbers |
| anything else | `hello` | Returns the help message |

### Example SMS Conversation

```
You:  add milk, eggs, bread
App:  Added: milk, eggs, bread

You:  list
App:  1. milk
      2. eggs
      3. bread

You:  remove 2
App:  Removed: eggs

You:  remove bread
App:  Removed: bread

You:  clear
App:  List cleared.
```

---

## ChatGPT (MCP) Channel

ChatGPT connects to the app via the MCP (Model Context Protocol) endpoint at `https://grocerylist.vezcore.com/mcp`. Once connected, ChatGPT has 5 tools it can call on your behalf based on natural language instructions.

```
You in ChatGPT: "Plan five dinners and add the ingredients to my grocery list"
        │
        ▼
  ChatGPT reasons through meal plan, consolidates ingredients
        │
        │  Calls MCP tool: add_grocery_items(["chicken thighs", "garlic", ...])
        ▼
  grocerylist.vezcore.com/mcp
        │
        ├─► Bearer token validated against DynamoDB
        ├─► Items written to GroceryLists
        │
        │  Returns: { addedItems: [...], resultCount: 12 }
        ▼
  ChatGPT: "I've added 12 ingredients to your grocery list."
        │
        ▼
You text "list" via SMS → same 12 items appear
```

### MCP Tools

| Tool | What to say to ChatGPT | What it does |
|------|------------------------|--------------|
| `get_grocery_list` | "What's on my grocery list?" | Returns current items and version |
| `add_grocery_items` | "Add milk, eggs, and butter" | Adds items (skips duplicates) |
| `remove_grocery_items` | "Remove milk from my list" | Removes items by name or position |
| `clear_grocery_list` | "Clear my grocery list" | Removes all items (asks confirmation) |
| `replace_grocery_list` | "Replace my list with these ingredients: ..." | Atomically replaces entire list |

You don't need to format anything — ChatGPT translates natural language into the correct tool calls automatically.

### Concurrency Safety

Both channels use **optimistic locking** (`version` field on each list). If SMS and ChatGPT write at the same moment, one will retry automatically. A version conflict on a destructive operation (remove, clear, replace) is surfaced to ChatGPT as an error with a message to re-read and retry.

---

## Authentication

### SMS
The `From` phone number on every incoming SMS is checked against `authorizedNumbers` in DynamoDB. Numbers not on the list are rejected before any list operation runs.

### MCP / ChatGPT
Every MCP request includes `Authorization: Bearer <mcpApiKey>`. The server SHA-256 hashes the token and queries the `mcpApiKeyHash-index` GSI to resolve the tenant. Invalid tokens receive a 401. The `mcpApiKey` UUID is specific to your tenant — it never appears in logs.

### OAuth (for ChatGPT connection setup)
ChatGPT uses an OAuth 2.0 authorization code flow to establish the connection. When you first connect, ChatGPT redirects you to `https://grocerylist.vezcore.com/oauth/authorize` where you enter your `mcpApiKey`. The server validates it, redirects back to ChatGPT, and ChatGPT exchanges the code for a bearer token at `/oauth/token`. After setup, ChatGPT sends the bearer token automatically on every request.

---

## Multi-Tenancy

Each family has their own Twilio phone number. The `To` field on every SMS (and the resolved `tenantId` from the bearer token for MCP) scopes all reads and writes to that family's data. Multiple families can use the same deployed instance with completely isolated lists.

---

## Troubleshooting

### SMS: "The list shows '1. milk, eggs, bread' instead of separate items"
Items were added before comma-splitting was supported. Fix: `clear`, then re-add items.

### SMS: "remove eggs says 'not found' but eggs is on the list"
The name match is exact (case-insensitive). Text `list` to see exact spellings, then use the exact name or item number.

### SMS: "Sorry, your number is not authorized"
Your `From` number is not in `authorizedNumbers`. See [Operations Guide](operations.md) to add it.

### MCP: ChatGPT shows "connection failed" or tools don't appear
1. Verify the connector is configured with Server URL `https://grocerylist.vezcore.com/mcp`
2. Verify the OAuth sign-in completed (there should be a connected indicator in ChatGPT)
3. Check Lambda logs: `aws logs tail /aws/lambda/grocery-list-twilio --follow --region us-west-2`

### MCP: "version conflict" error from ChatGPT
The list changed between when ChatGPT read it and when it tried to write. ChatGPT will automatically re-read the list and retry.

### No reply at all (SMS)
1. Check the Twilio webhook is set to `https://grocerylist.vezcore.com/sms` with method `POST`
2. Check Lambda logs: `aws logs tail /aws/lambda/grocery-list-twilio --follow --region us-west-2`
3. Check GitHub Actions for a failed deploy: `gh run list --repo shavez00/groceryListTwilio --limit 3`
