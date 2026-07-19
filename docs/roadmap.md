# Future Roadmap

## MCP Server Integration (Primary Next Feature)

The application is designed to support an MCP (Model Context Protocol) server that allows AI assistants like ChatGPT or Claude to read and write grocery lists directly. This was a primary motivation for the DynamoDB migration and multi-tenant architecture.

### What MCP Is

MCP is a standard protocol for giving AI assistants access to external tools and data. An MCP server exposes "tools" — functions the AI can call. In this context, the AI would have tools like `add_grocery_item`, `get_grocery_list`, and `clear_grocery_list`.

### How It Would Work

```
User in ChatGPT: "Add the ingredients for chicken marsala to my grocery list"
         │
         ▼
ChatGPT (with MCP configured)
         │
         │  Calls MCP tool: add_grocery_items(
         │    tenantId: "+15034448534",
         │    mcpApiKey: "a3f8c2d1-...",
         │    items: ["chicken breast", "mushrooms", "marsala wine", "butter", "flour"]
         │  )
         ▼
MCP Server (new Lambda function or extension of existing one)
         │
         │  Validates mcpApiKey against GroceryTenants table
         │  Writes items to GroceryLists table
         ▼
DynamoDB GroceryLists updated
         │
         ▼
Family member texts "list" → sees the new items
```

### Implementation Approach

**Option A — Extend the existing Lambda:**
Add new Express routes (e.g. `POST /mcp/tools/add_items`) to `twilio.js`. The MCP server would call these HTTP endpoints. Simple, no new infrastructure.

**Option B — Dedicated MCP Lambda:**
A second Lambda function with its own SAM resource, implementing the MCP protocol natively. More complex but cleanly separated from the SMS path.

Option A is recommended for this project's scale and complexity.

### Authentication

The `mcpApiKey` UUID already stored in `GroceryTenants` is designed for this. The MCP server call includes the `tenantId` and `mcpApiKey`. The Lambda validates the key before any read or write.

**Never use the same API key for MCP as for SMS.** SMS uses the Twilio `To`/`From` fields for identity. MCP uses the `mcpApiKey`. They are intentionally separate.

### Data Already Ready

The `GroceryLists` table already has a `lastModifiedBy` field. When MCP writes to the list, it will be set to `"mcp-server"`. When a family member texts, it is set to their phone number. This gives you a full audit trail of who (or what) changed the list.

---

## Other Potential Enhancements

### Multiple Named Lists
The `listId` sort key in `GroceryLists` already supports this. The SMS path currently defaults to `"grocery"`, but you could extend the commands to support:
```
add costco: paper towels   →  listId = "costco"
list costco                →  reads the "costco" list
```
No schema changes needed — just command parsing logic in `twilio.js`.

### Item Categories / Aisle Sorting
Items could be stored as objects with a `category` field (`{"name": "milk", "category": "dairy"}`). The `list` command could group by category. This would require a schema change in `GroceryLists.items` from `List<String>` to `List<Map>`.

### Read Receipts / Delivery Status
The old code had a disabled status webhook (`/status/`). Re-enabling it would let you log whether the SMS reply was delivered successfully. Low value for a household app but easy to add back.

### Web Interface
A simple read-only web page at `grocerylist.vezcore.com` (separate from the `/sms` endpoint) that displays the current list. Could be a plain HTML file served from S3 + CloudFront, reading from DynamoDB via a Lambda-backed API GET endpoint.

### Shared Shopping Mode
A "checked off" state per item so family members can mark items as picked up while shopping. Would require adding a `checkedBy` field to each item and a new `check {#}` command.

---

## Known Limitations

- **Announce targets are hardcoded.** The phone numbers in the `announce` command (`+15037812714`, `+15035449035`) are hardcoded in `twilio.js`. These should be moved to the `GroceryTenants` table as an `announceNumbers` attribute and read at runtime.
- **No error handling.** If DynamoDB is unavailable, the Lambda returns a 502 and Twilio retries. For a hobby app this is fine; for production, add try/catch and return a friendly TwiML error message.
- **No input length validation.** A very long item name would be stored and potentially exceed the 1600-character SMS limit when listing. Not a practical issue for a grocery list.
