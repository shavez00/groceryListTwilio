# Coding & Documentation Standards

## General Principles

- **Infrastructure is code.** Every AWS resource lives in `template.yaml`. Never create or modify resources manually — they will be overwritten on the next deploy.
- **Secrets never touch the codebase.** Twilio credentials go in SSM. The `mcpApiKey` lives in DynamoDB (not SSM) but is never logged or committed to git.
- **`master` is always deployable.** Run `npm test` before pushing. The CI/CD pipeline also runs tests, but a broken `master` blocks all deploys.
- **Never log sensitive values.** No bearer tokens, `mcpApiKey` values, phone numbers, or `Authorization` headers in logs. Phone numbers in `lastModifiedBy` are normalized to `"sms-user"`. Tenant IDs in error logs use a SHA-256 hash, not the phone number.

---

## File Organization

The application is split across focused files:

| File | Rule |
|------|------|
| `twilio.js` | Entry point only. Mounts routers, owns SSM cache. No business logic. |
| `src/repository.js` | DynamoDB operations only. No business logic, no Express, no MCP concepts. |
| `src/service.js` | Business logic only. No Express, no TwiML, no MCP. Both SMS and MCP call this. |
| `src/mcp.js` | MCP server, bearer auth, tool definitions. Calls `service.js`. |
| `routes/sms.js` | SMS handler, TwiML responses. Calls `service.js`. |
| `routes/oauth.js` | OAuth 2.0 endpoints. No list logic. |

If `twilio.js` or any file grows significantly, extract further — but don't split without a reason.

---

## JavaScript Style

- 2-space indentation, single quotes, semicolons, `const` by default
- All DynamoDB and SSM calls are `async/await` — no raw `.then()` chains
- No comments for obvious code. Comments only for non-obvious WHY (hidden constraint, subtle invariant, workaround):

```js
// Good: explains WHY
// attribute_not_exists handles items written before the version field was added
ConditionExpression: 'attribute_not_exists(#v) OR #v = :expected'

// Bad: explains WHAT (the code already says this)
// Create a new response
const twiml = new MessagingResponse();
```

---

## Adding a New SMS Command

1. Add a new `else if` branch in the command parser in `routes/sms.js`
2. Add a `case` block in the `switch` statement
3. Call the appropriate function in `src/service.js` (or add one if needed)
4. Update the `default` help message
5. Update [how-it-works.md](how-it-works.md) with the new command

---

## Adding a New MCP Tool

1. Add a `server.registerTool(...)` call in `buildMcpServer()` in `src/mcp.js`
2. Add or reuse a function in `src/service.js` for the logic
3. Set tool annotations accurately (`readOnlyHint`, `destructiveHint`, `idempotentHint`)
4. Add tests in `test/mcp.test.js`
5. Update [how-it-works.md](how-it-works.md)

---

## Adding Infrastructure

Edit `template.yaml`. Common patterns:

| Need | Type |
|------|------|
| New API route | Add an `Events` entry under `GroceryListFunction` |
| New DynamoDB table | `AWS::DynamoDB::Table` — always add `DeletionPolicy: Retain` |
| New GSI | Add to `AttributeDefinitions` and `GlobalSecondaryIndexes` in the table resource |
| New env variable | Add to `Globals.Function.Environment.Variables` |
| New IAM permission | Add a SAM policy to `GroceryListFunction.Properties.Policies` |

---

## Dependencies

```bash
npm install some-package    # updates package.json + package-lock.json
git add package.json package-lock.json
```

Always commit `package-lock.json` — CI uses `npm ci` which requires it.

Keep dependencies minimal. Every dependency is bundled into the Lambda package and increases cold start time. New production dependencies (non-dev) are included in the Lambda deployment.

---

## Git Workflow

Direct commits to `master`. Each commit should leave the app deployable and tests passing.

**Commit message format:**
```
Short summary in imperative mood (under 72 chars)

Optional explanation of WHY, not WHAT. Include context that won't be
obvious from reading the code.
```

**Good:**
```
Fix 406 on live MCP endpoint by bypassing Hono header bridge
Add OAuth client_credentials endpoint for ChatGPT MCP connector
Increase Lambda timeout to 29s to match API Gateway maximum
```

**Bad:**
```
fix bug
updated code
WIP
```

---

## Testing

Run `npm test` before pushing. The suite must be green.

```bash
npm test          # run all 67 tests
npm run lint      # syntax check all JS files
```

**Test files:**
- `twilio.test.js` — SMS endpoint tests (root, not in `test/`)
- `test/service.test.js` — service layer unit tests with mocked repository
- `test/mcp.test.js` — MCP HTTP integration tests with mocked repository

**Adding tests:** Any new command, tool, or behavior needs a test. Mock DynamoDB at the repository layer (not at the AWS SDK level) — see existing tests for the pattern.

---

## Documentation Standards

- Write for a developer who has never seen this project
- When you change application behavior → update [how-it-works.md](how-it-works.md)
- When you add AWS resources → update [architecture.md](architecture.md)
- When you change the data schema → update [data-model.md](data-model.md)
- When you change the deployment process → update [deployment.md](deployment.md)
- When you add a new file → update [codebase.md](codebase.md)

Out-of-date docs are worse than no docs.
