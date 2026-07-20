# CLAUDE.md — Grocery List Twilio

This file gives Claude Code context about this project so every session starts with full understanding.

## What This Project Is

A serverless SMS-driven grocery list application. Family members text a Twilio phone number to add, remove, and view items on a shared grocery list. Built to support multiple families (multi-tenant), each with their own Twilio number and isolated list in DynamoDB.

The long-term plan is to add an MCP server so ChatGPT or Claude can write ingredients directly to the list (e.g. "plan chicken marsala for dinner" → ingredients automatically added to the grocery list).

## Full Documentation

All architecture, data model, deployment, operations, and coding standards are in `docs/`. Read those before making changes. Key files:

- `docs/how-it-works.md` — user-facing behavior, SMS commands, troubleshooting
- `docs/architecture.md` — AWS services, how they connect, why Lambda was chosen
- `docs/data-model.md` — DynamoDB schema, multi-tenancy design
- `docs/codebase.md` — annotated walkthrough of twilio.js
- `docs/cicd.md` — how the GitHub Actions pipeline works
- `docs/deployment.md` — step-by-step from-scratch deploy guide
- `docs/operations.md` — adding tenants, rotating credentials, monitoring
- `docs/standards.md` — coding conventions, git commit format, how to add a command
- `docs/roadmap.md` — MCP server integration design, known limitations

## Tech Stack

- **Runtime:** Node.js 20, single file (`twilio.js`)
- **Framework:** Express wrapped with `serverless-http` for Lambda compatibility
- **Infrastructure:** AWS SAM (`template.yaml`) — Lambda, API Gateway (HTTP), DynamoDB, ACM, Route 53
- **CI/CD:** GitHub Actions (`.github/workflows/deploy.yml`) — deploys on every push to `master`
- **Secrets:** SSM Parameter Store (SecureString) — never in env vars or code

## AWS Setup

- **Region:** us-west-2
- **Stack name:** `grocery-list-twilio`
- **Live endpoint:** `https://grocerylist.vezcore.com/sms`
- **DynamoDB tables:** `GroceryTenants` (one row per family), `GroceryLists` (one row per list per family)
- **SSM parameters:** `/grocerylist/twilio/accountSID`, `/grocerylist/twilio/apiKeySID`, `/grocerylist/twilio/apiKeySecret`
- **Twilio auth:** API Key (SK...) + Account SID (AC...) — not Auth Token. Credentials fetched from SSM at Lambda cold start and cached in-memory.

## Multi-Tenancy

The Twilio `To` field (the number the family texts) is the `tenantId`. It keys both DynamoDB tables. Adding a new family = one `aws dynamodb put-item` to `GroceryTenants`, no code changes. See `docs/operations.md`.

## Key Conventions

- **Infrastructure is code.** All AWS resources are in `template.yaml`. Never make manual console changes — they get overwritten on next deploy.
- **One application file.** All logic stays in `twilio.js` unless it grows beyond ~300 lines.
- **No secrets in code or git.** Credentials go in SSM.
- **`master` is always deployable.** Every push triggers a live deploy.
- **`npm ci` not `npm install`** in CI — uses exact locked versions from `package-lock.json`.
- **Commit `package-lock.json`.** Required for reproducible CI builds.

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
aws dynamodb put-item --table-name GroceryTenants --region us-west-2 \
  --item '{"tenantId":{"S":"+1XXXXXXXXXX"},"familyName":{"S":"Name"},"authorizedNumbers":{"L":[{"S":"+1XXXXXXXXXX"}]},"mcpApiKey":{"S":"uuid-here"},"createdAt":{"S":"2026-01-01T00:00:00Z"}}'
```

**Smoke test the live endpoint:**
```bash
curl -s -X POST https://grocerylist.vezcore.com/sms \
  -d "To=%2B1TWILIONUMBER&From=%2B1AUTHORIZEDNUMBER&Body=list"
```

## MCP API Key

Each tenant in `GroceryTenants` has an `mcpApiKey` UUID. This is reserved for the future MCP server integration — it will authenticate ChatGPT/Claude tool calls to read and write the list without SMS. Keep it secret; treat it like a password. See `docs/roadmap.md` for the full design.
