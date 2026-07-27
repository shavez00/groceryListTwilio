# CLAUDE.md — Grocery List Twilio

This file gives Claude Code context about this project so every session starts with full understanding.

## What This Project Is

A serverless application that lets family members manage a shared grocery list via SMS and ChatGPT. Family members text a Twilio phone number to add, remove, and view items. ChatGPT can read and write the list directly via an MCP (Model Context Protocol) server — enabling workflows like "plan five dinners and add the missing ingredients to my grocery list."

Built for multiple families (multi-tenant), each with their own Twilio number and isolated list in DynamoDB.

## Full Documentation

All architecture, data model, deployment, operations, and coding standards are in `docs/`. Read those before making changes. Key files:

- `docs/how-it-works.md` — user-facing behavior, SMS commands, MCP tools, troubleshooting
- `docs/architecture.md` — AWS services, file structure, how they connect
- `docs/data-model.md` — DynamoDB schema, multi-tenancy, GSI, optimistic locking
- `docs/codebase.md` — annotated walkthrough of all source files
- `docs/cicd.md` — how the GitHub Actions pipeline works
- `docs/deployment.md` — step-by-step from-scratch deploy guide
- `docs/operations.md` — adding tenants, rotating credentials, monitoring
- `docs/standards.md` — coding conventions, git commit format, how to add a command or MCP tool
- `docs/roadmap.md` — completed features, known limitations, potential enhancements

## Tech Stack

- **Runtime:** Node.js 20
- **Framework:** Express wrapped with `serverless-http` for Lambda compatibility
- **MCP:** `@modelcontextprotocol/sdk` v1.29.0 — Streamable HTTP transport, stateless mode
- **Infrastructure:** AWS SAM (`template.yaml`) — Lambda, API Gateway (HTTP), DynamoDB, ACM, Route 53
- **CI/CD:** GitHub Actions (`.github/workflows/deploy.yml`) — deploys on every push to `master`
- **Secrets:** SSM Parameter Store (SecureString) — never in env vars or code

## File Structure

```
twilio.js          — entry point: mounts routers, SSM cache, serverless-http export
src/
  repository.js    — all DynamoDB operations
  service.js       — business logic (shared by SMS and MCP)
  mcp.js           — MCP server, bearer auth middleware, 5 tool definitions
routes/
  sms.js           — SMS handler, TwiML responses
  oauth.js         — OAuth 2.0 endpoints for ChatGPT connector auth
twilio.test.js     — SMS endpoint tests
test/
  service.test.js  — service layer unit tests
  mcp.test.js      — MCP HTTP integration tests
```

## AWS Setup

- **Region:** us-west-2
- **Stack name:** `grocery-list-twilio`
- **Live endpoints:**
  - SMS: `https://grocerylist.vezcore.com/sms`
  - MCP: `https://grocerylist.vezcore.com/mcp`
  - OAuth: `https://grocerylist.vezcore.com/oauth/authorize`, `/oauth/token`
  - Discovery: `https://grocerylist.vezcore.com/.well-known/oauth-authorization-server`
- **DynamoDB tables:** `GroceryTenants` (one row per family), `GroceryLists` (one row per list per family)
- **DynamoDB GSI:** `mcpApiKeyHash-index` on `GroceryTenants` — enables O(1) bearer token auth lookup
- **SSM parameters:** `/grocerylist/twilio/accountSID`, `/grocerylist/twilio/apiKeySID`, `/grocerylist/twilio/apiKeySecret`
- **Twilio auth:** API Key (SK...) + Account SID (AC...) — not Auth Token. Credentials fetched from SSM at Lambda cold start and cached in-memory.

## Multi-Tenancy

The Twilio `To` field (the number the family texts) is the `tenantId`. It keys both DynamoDB tables. Adding a new family = one `aws dynamodb put-item` to `GroceryTenants` + run the backfill script. No code changes. See `docs/operations.md`.

## Key Conventions

- **Infrastructure is code.** All AWS resources are in `template.yaml`. Never make manual console changes — they get overwritten on next deploy.
- **Layered architecture.** `repository.js` → `service.js` → `routes/sms.js` or `src/mcp.js`. Don't skip layers.
- **No secrets in code or git.** Twilio credentials in SSM. `mcpApiKey` in DynamoDB — never logged.
- **`master` is always deployable.** Every push triggers a live deploy. Run `npm test` before pushing.
- **`npm ci` not `npm install`** in CI — uses exact locked versions from `package-lock.json`.
- **Commit `package-lock.json`.** Required for reproducible CI builds.
- **Never log sensitive values.** No bearer tokens, `mcpApiKey`, phone numbers, or `Authorization` headers.

## SMS Commands (current)

| Command | Behavior |
|---------|----------|
| `add milk` | Adds one item |
| `add milk, eggs, bread` | Adds multiple items (comma-split) |
| `list` | Returns numbered list |
| `remove 2` | Removes by number |
| `remove eggs` | Removes by name (case-insensitive) |
| `remove 2,3,4` | Removes multiple items (comma-split, by number or name) |
| `clear` | Empties the list |
| `announce {msg}` | Broadcasts SMS to all `authorizedNumbers` in DynamoDB |

## MCP Tools (ChatGPT)

| Tool | Description |
|------|-------------|
| `get_grocery_list` | Read the current list with version number |
| `add_grocery_items` | Add items (duplicates skipped) |
| `remove_grocery_items` | Remove by position or name (requires version) |
| `clear_grocery_list` | Empty the list (destructive) |
| `replace_grocery_list` | Atomic clear + set (for meal-plan ingredient drops) |

ChatGPT authenticates via OAuth 2.0 — sign in at `/oauth/authorize` with your `mcpApiKey` UUID.

## Common Tasks

**Deploy:** push to `master` — GitHub Actions handles it (~2 min)

**Check deploy status:**
```bash
gh run list --repo shavez00/groceryListTwilio --limit 3
```

**View live logs:**
```bash
aws logs tail /aws/lambda/grocery-list-twilio --follow --region us-west-2
```

**Add a new family (tenant):**
```bash
# 1. Generate UUID and add tenant
aws dynamodb put-item --table-name GroceryTenants --region us-west-2 \
  --item '{"tenantId":{"S":"+1XXXXXXXXXX"},"familyName":{"S":"Name"},"authorizedNumbers":{"L":[{"S":"+1XXXXXXXXXX"}]},"mcpApiKey":{"S":"uuid-here"},"createdAt":{"S":"2026-01-01T00:00:00Z"}}'

# 2. Populate mcpApiKeyHash (required for MCP bearer auth)
bash backfill-mcp-key-hash.sh
```

**Smoke test SMS:**
```bash
curl -s -X POST https://grocerylist.vezcore.com/sms \
  -d "To=%2B1TWILIONUMBER&From=%2B1AUTHORIZEDNUMBER&Body=list"
```

**Smoke test MCP:**
```bash
curl -s -X POST https://grocerylist.vezcore.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <mcpApiKey>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## MCP API Key

Each tenant in `GroceryTenants` has an `mcpApiKey` UUID and a corresponding `mcpApiKeyHash` (SHA-256). The hash is stored in a GSI for O(1) bearer token lookups — the plaintext key is never used for queries. To rotate: generate a new UUID, update both fields in DynamoDB, reconnect ChatGPT. See `docs/operations.md`.
