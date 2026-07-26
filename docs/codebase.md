# Codebase Guide

## File Structure

```
groceryListTwilio/
├── twilio.js                        # Entry point: Express app, route mounts, Lambda export
├── package.json
├── package-lock.json                # Locked deps (committed — required for npm ci)
├── template.yaml                    # AWS SAM / CloudFormation infrastructure
├── backfill-mcp-key-hash.sh         # One-time script: populate mcpApiKeyHash on existing tenants
├── .github/
│   └── workflows/
│       └── deploy.yml               # GitHub Actions CI/CD
├── routes/
│   ├── sms.js                       # SMS command handler (TwiML responses)
│   └── oauth.js                     # OAuth 2.0 endpoints (for ChatGPT connection)
├── src/
│   ├── repository.js                # All DynamoDB operations
│   ├── service.js                   # Business logic (shared by SMS and MCP)
│   └── mcp.js                       # MCP server: 5 tools + bearer auth
├── test/
│   ├── service.test.js              # Unit tests for service layer
│   └── mcp.test.js                  # Integration tests for MCP HTTP endpoint
├── twilio.test.js                   # Integration tests for SMS endpoint
└── docs/
```

---

## twilio.js — Entry Point

Thin file. Sets up Express, mounts routers, exports the Lambda handler.

```js
app.use(oauthRouter);           // /.well-known/*, /oauth/*
app.use('/mcp', mcpRouter);     // MCP server
app.use('/sms', smsRouter);     // SMS webhook
```

Also owns the SSM secrets cache for Twilio credentials (Account SID, API Key SID, API Key Secret). Shares the cache with `routes/sms.js` via `smsRouter.setSecretsProvider(getTwilioSecrets)`.

The dual-mode entry point pattern is preserved: `module.exports.handler = serverless(app)` for Lambda, and `if (require.main === module) http.createServer(app).listen(8080)` for local dev.

---

## src/repository.js — DynamoDB Operations

All DynamoDB reads and writes. No business logic.

| Function | What it does |
|----------|-------------|
| `readList(tenantId, listId)` | Returns `{ items, version, updatedAt, lastModifiedBy }`. Empty items array if list doesn't exist. |
| `writeList(tenantId, listId, items, expectedVersion, modifiedBy)` | Conditional PutCommand — throws `ConditionalCheckFailedException` if version doesn't match. Increments version. |
| `writeListUnconditional(tenantId, listId, items, modifiedBy)` | Reads current version then writes without a condition check. Used by the SMS path. |
| `isAuthorized(tenantId, fromNumber)` | Checks `authorizedNumbers` list in `GroceryTenants`. Returns boolean. |
| `getTenant(tenantId)` | Returns the full tenant record. |
| `getTenantByApiKeyHash(hash)` | Queries `mcpApiKeyHash-index` GSI. Returns tenant or null. Used for bearer token auth. |

**Lazy version migration:** Items added before the `version` field existed have no `version` attribute in DynamoDB. `readList` treats a missing `version` as `0`. The first conditional write uses `attribute_not_exists(#v) OR #v = :expected`, so version `0` items get a `version: 1` on first write — no batch migration needed.

---

## src/service.js — Business Logic

Pure functions. No Express, no TwiML, no MCP. Both `routes/sms.js` and `src/mcp.js` call this.

| Function | Behavior |
|----------|----------|
| `getList(tenantId, listId)` | Returns `{ items: [{position, value}], version, updatedAt, lastModifiedBy }` |
| `addItems(tenantId, listId, items, modifiedBy)` | Validates, deduplicates (case-insensitive), retries up to 3× on version conflict. Returns `{ addedItems, skippedItems, resultCount, version }` |
| `removeItems(tenantId, listId, selectors, expectedVersion, modifiedBy)` | Throws `VERSION_CONFLICT` if version changed. Returns `{ removedItems, notFoundItems, conflictItems, resultCount, version }` |
| `clearList(tenantId, listId, expectedVersion, modifiedBy)` | `expectedVersion` optional — omit for unconditional clear. Returns `{ clearedCount, resultCount, version, listId }` |
| `replaceList(tenantId, listId, items, expectedVersion, modifiedBy)` | Validates items (max 50), conditional write. Returns `{ previousCount, newCount, version, listId }` |

**Validation limits:**
- Max 100 chars per item
- Max 20 items per `add` request
- Max 50 items per `replace` request
- Max 50 items total on list

---

## src/mcp.js — MCP Server

Exports an Express `Router` mounted at `/mcp` in `twilio.js`.

**Auth middleware** runs on every request before the MCP transport sees it:
1. Extracts bearer token from `Authorization` header
2. SHA-256 hashes it
3. Queries `mcpApiKeyHash-index` GSI via `repository.getTenantByApiKeyHash(hash)`
4. Injects `req.mcpTenant` on success; returns 401 with `WWW-Authenticate` header on failure

**Transport:** `WebStandardStreamableHTTPServerTransport` in stateless mode (`sessionIdGenerator: undefined`). A new instance is created per request. `buildWebRequest()` manually constructs a Web Standard `Request` from Express's `req.headers` — this is required because `serverless-http` doesn't populate `rawHeaders`, which the Node.js transport's Hono bridge needs.

**5 MCP tools registered:**

| Tool | Annotations | Notes |
|------|-------------|-------|
| `get_grocery_list` | readOnly, idempotent | Call first to get current version before any write |
| `add_grocery_items` | idempotent | Duplicate items skipped — safe to retry |
| `remove_grocery_items` | destructive | Requires `expectedVersion` from prior `get_grocery_list` |
| `clear_grocery_list` | destructive, idempotent | `expectedVersion` optional |
| `replace_grocery_list` | destructive | Requires `expectedVersion` |

The `tenantId` is sourced from `authInfo.extra.tenantId` (set by the auth middleware). Tools never accept `tenantId` as an argument.

---

## routes/sms.js — SMS Handler

Handles `POST /sms`. Validates the Twilio `From`/`To` fields, parses the SMS command, calls `src/service.js`, and returns TwiML XML.

Uses `repository.js` directly for the `announce` command (needs the full tenant record to broadcast to `authorizedNumbers`). All list operations go through `service.js`.

Exports `setSecretsProvider(fn)` so `twilio.js` can inject the SSM cache without creating a circular dependency.

---

## routes/oauth.js — OAuth Endpoints

Implements a minimal OAuth 2.0 authorization server so ChatGPT's MCP connector can authenticate.

| Route | Purpose |
|-------|---------|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata — ChatGPT fetches this to discover the token endpoint |
| `GET /.well-known/oauth-protected-resource/mcp` | RFC 9728 metadata — points clients at the auth server |
| `GET /oauth/authorize` | Renders an API key entry form |
| `POST /oauth/authorize` | Validates the key, redirects to ChatGPT callback with `code=<apiKey>` |
| `POST /oauth/token` | Exchanges code or client_secret for access_token (the key itself, validated via GSI) |

The `mcpApiKey` UUID is used directly as both the authorization code and the access token. Since it's a 122-bit secret and is re-validated at every step via the GSI hash lookup, no server-side session state is needed — which is ideal for Lambda.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@aws-sdk/client-dynamodb` + `lib-dynamodb` | DynamoDB Document Client |
| `@aws-sdk/client-ssm` | SSM Parameter Store (Twilio creds) |
| `@modelcontextprotocol/sdk` `1.29.0` (exact) | MCP server + WebStandard transport |
| `body-parser` | URL-encoded form body parsing (SMS) |
| `express` | HTTP routing |
| `serverless-http` | Wraps Express for Lambda |
| `twilio` | TwiML builder + outbound SMS (announce) |
| `zod` | MCP tool input schema validation |

---

## Tests

| File | What it covers |
|------|---------------|
| `twilio.test.js` | SMS endpoint: auth, all commands, DynamoDB errors, announce |
| `test/service.test.js` | Service layer: all functions, edge cases, version conflict/retry |
| `test/mcp.test.js` | MCP HTTP endpoint: auth, all 5 tools, version conflicts, tenant isolation |

Run: `npm test` (67 tests, Jest + supertest)
