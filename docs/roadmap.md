# Roadmap

## Completed

### MCP Server Integration ✓

ChatGPT can now read and write the grocery list directly via the MCP (Model Context Protocol) endpoint at `https://grocerylist.vezcore.com/mcp`.

**What was built:**
- 5 MCP tools: `get_grocery_list`, `add_grocery_items`, `remove_grocery_items`, `clear_grocery_list`, `replace_grocery_list`
- Bearer token authentication via SHA-256 hashed `mcpApiKey` and DynamoDB GSI lookup
- OAuth 2.0 authorization code flow so ChatGPT's connector can authenticate
- Optimistic locking (`version` field) for safe concurrent writes between SMS and ChatGPT
- Shared service layer (`src/service.js`) used by both SMS and MCP channels
- 67 automated tests

**Primary use case:** "Plan five dinners and add the missing ingredients to my grocery list" — ChatGPT reasons through a meal plan, consolidates the ingredients, and calls `add_grocery_items` or `replace_grocery_list` in one shot.

---

## Potential Future Enhancements

### Multiple Named Lists via SMS

The schema already supports multiple lists via the `listId` sort key on `GroceryLists`. The SMS path currently hardcodes `listId = "grocery"`. Extending commands to address other lists:

```
add costco: paper towels, detergent
list costco
clear costco
```

No schema or infrastructure changes needed — just command parsing in `routes/sms.js`.

### Twilio Webhook Signature Validation

Twilio's `validateExpressRequest` helper rejects forged webhooks by validating an HMAC-SHA1 signature on the request. Currently deferred because it requires the Twilio Auth Token (a master credential that can send SMS from any number), which expands the credential blast radius beyond what the API Key approach allows.

The existing `isAuthorized` check — verifying `From` against `authorizedNumbers` — is a sufficient substitute at this scale. A forged request would need both the `To` Twilio number and a valid `From` from the allowlist.

**Implementation when ready:** Add `validateExpressRequest` as middleware in `routes/sms.js`. Store the Auth Token in SSM at `/grocerylist/twilio/authToken`.

### Item Check-Off State

A "picked up" flag per item for use while shopping. Would require changing `items` from `List<String>` to `List<Map>` (e.g. `[{"name": "milk", "checked": false}]`). Would need a new `check {#}` SMS command and a corresponding MCP tool.

### Read-Only Web View

A simple static page at `grocerylist.vezcore.com` showing the current list. Could be served from S3 + CloudFront with a Lambda-backed API GET endpoint for the list data. No auth needed if read-only.

---

## Known Limitations

### No Twilio Webhook Signature Validation
See above. Intentional trade-off documented here for future reference.

### SSE Buffering Through Lambda
The MCP `WebStandardStreamableHTTPServerTransport` can return either JSON or SSE (text/event-stream) responses. `serverless-http` buffers the full response before returning it to API Gateway — there is no true streaming. For tool calls, ChatGPT sends a single POST and waits for the full response, so buffered SSE works correctly. If a future use case requires true streaming (e.g. long-running operations with progress updates), the alternative is Lambda Function URLs with response streaming enabled.

### In-Memory Secrets Cache Not Shared Across Containers
Twilio credentials are fetched from SSM once per Lambda container and cached in memory. At low traffic (one or two containers), this is fine. At higher concurrency, multiple containers each make their own SSM call on cold start. At this scale this is not a problem, but worth knowing.
