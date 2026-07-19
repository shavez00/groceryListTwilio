# Coding & Documentation Standards

Standards to follow when making changes to this project. These keep the codebase consistent and the CI/CD pipeline reliable.

---

## General Principles

- **One file for the application.** `twilio.js` contains all application logic. Don't split it into multiple files unless the file grows beyond ~300 lines.
- **Infrastructure is code.** Every AWS resource lives in `template.yaml`. Never create or modify AWS resources manually through the console — they will be overwritten on the next deploy.
- **Secrets never touch the codebase.** Credentials go in SSM Parameter Store. No secrets in code, `.env` files, or git history.
- **The `master` branch is always deployable.** Never push broken code to `master`. Test locally before pushing.

---

## JavaScript Style

**Formatting:**
- 2-space indentation
- Single quotes for strings (except template literals)
- Semicolons at end of statements
- `const` by default; `let` when reassignment is needed; never `var`

**Async:**
- All DynamoDB and SSM calls are `async/await` — no raw `.then()` chains
- The Express route handler is `async` — unhandled rejections will crash the Lambda invocation and return a 502, so always `await` async calls inside the handler

**Error handling:**
- The application currently does not have try/catch around DynamoDB calls. For a hobby project this is acceptable — Lambda will return a 502 and Twilio will retry. If you add error handling, return a valid TwiML response so Twilio doesn't retry unnecessarily.

**No comments for obvious code.** Comments are only for non-obvious behavior:
```js
// Good: explains WHY (caching to avoid SSM latency on warm invocations)
let twilioSecrets = null;

// Bad: explains WHAT (the code already says this)
// Create a new MessagingResponse object
const twiml = new MessagingResponse();
```

---

## Adding a New SMS Command

1. Add a new `else if (response.startsWith('yourcommand'))` block in the command parser section
2. Add a `case 'yourcommand':` block in the `switch` statement
3. Follow the existing pattern: `async` operations with `await`, always `break` at the end of each case
4. Update the `default` case help message to include the new command
5. Update [how-it-works.md](how-it-works.md) with the new command in the commands table

**Example pattern:**
```js
// In the command parser
else if (response.startsWith('mycommand')) command = 'mycommand';

// In the switch statement
case 'mycommand': {
  const arg = body.substring('mycommand'.length + 1).trim();
  // ... do something with DynamoDB ...
  twiml.message(`Done: ${arg}`);
  break;
}
```

---

## Adding Infrastructure

Edit `template.yaml`. SAM/CloudFormation resource types to know:

| Need | CloudFormation / SAM type |
|------|--------------------------|
| New Lambda function | `AWS::Serverless::Function` |
| New API route | Add an `Events` entry to an existing function |
| New DynamoDB table | `AWS::DynamoDB::Table` |
| New environment variable | Add to `Globals.Function.Environment.Variables` |
| New IAM permission for Lambda | Add a SAM policy to the function's `Policies` list |

After editing `template.yaml`, push to `master`. CloudFormation will compute a changeset and apply only the diff — it won't recreate resources that haven't changed.

---

## Dependencies

**Adding a new npm package:**
```bash
npm install some-package
# This updates both package.json and package-lock.json
git add package.json package-lock.json
```

Always commit `package-lock.json`. The CI/CD pipeline uses `npm ci` which requires it.

**Do not add devDependencies** unless you add a local test runner. The Lambda deployment bundles everything in `dependencies` — devDependencies are excluded by SAM's build process (which is a feature, not a bug, since they'd bloat the Lambda package).

**Keep dependencies minimal.** Every dependency is bundled into the Lambda deployment package and increases cold start time. Prefer AWS SDK packages (already in the Lambda runtime) and avoid large utility libraries when a few lines of native JavaScript will do.

---

## Git Workflow

This is a single-developer project with direct commits to `master`.

**Commit message format:**
```
Short summary in imperative mood (under 72 chars)

Optional longer explanation of WHY the change was made, not WHAT
it does (the diff shows what). Include context that won't be
obvious from reading the code.
```

**Good examples:**
```
Add remove-by-name command as alternative to remove-by-number

Fix authorization check returning true for unknown tenants

Increase Lambda timeout from 15s to 30s for slow DynamoDB cold starts
```

**Bad examples:**
```
fix bug
updated code
WIP
```

---

## Documentation Standards

- Keep docs in the `docs/` folder
- Write for a junior developer who has never seen this project
- When you change application behavior, update [how-it-works.md](how-it-works.md)
- When you add AWS resources, update [architecture.md](architecture.md)
- When you change the data schema, update [data-model.md](data-model.md)
- When you change the deployment process, update [deployment.md](deployment.md)

Documentation is committed and pushed just like code. Out-of-date docs are worse than no docs.

---

## Testing

There are no automated tests in this project. Before pushing:

1. **Syntax check:** `node --check twilio.js` — catches syntax errors without running the code
2. **Dependency check:** `npm ci` — verifies the lockfile is consistent
3. **Local run:** `node twilio.js` — verifies the server starts on port 8080
4. **Smoke test** against the live endpoint after deploy (see [Operations Guide](operations.md))

If you add tests in the future, add a `test` script to `package.json` and add a test step to `.github/workflows/deploy.yml` before the SAM deploy step.
