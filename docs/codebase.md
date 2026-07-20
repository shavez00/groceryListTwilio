# Codebase Guide

## File Structure

```
groceryListTwilio/
├── twilio.js                        # The entire application (one file)
├── package.json                     # Node.js dependencies and scripts
├── package-lock.json                # Locked dependency versions (committed)
├── template.yaml                    # AWS SAM / CloudFormation infrastructure definition
├── .gitignore                       # Files excluded from git
├── .github/
│   └── workflows/
│       └── deploy.yml               # GitHub Actions CI/CD pipeline
└── docs/                            # This documentation
    ├── README.md
    ├── how-it-works.md
    ├── architecture.md
    ├── data-model.md
    ├── codebase.md                  # (this file)
    ├── cicd.md
    ├── deployment.md
    ├── operations.md
    ├── standards.md
    └── roadmap.md
```

## twilio.js — Annotated Walkthrough

The entire application lives in a single file. Here is what each section does.

### 1. Imports

```js
const http = require('http');
const express = require('express');
const MessagingResponse = require('twilio').twiml.MessagingResponse;
const bodyParser = require('body-parser');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
```

- `express` — minimal web framework that handles the HTTP routing
- `twilio` — official Twilio SDK, used here only for building TwiML XML responses and sending outbound SMS
- `body-parser` — parses the URL-encoded form body that Twilio sends in its webhook POST
- `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` — AWS SDK for DynamoDB. `lib-dynamodb` is the Document Client, which automatically marshals/unmarshals JavaScript types to DynamoDB's internal format (e.g. converts `["milk", "eggs"]` to `{"L": [{"S": "milk"}, {"S": "eggs"}]}`)
- `@aws-sdk/client-ssm` — AWS SDK for reading encrypted credentials from SSM Parameter Store

### 2. DynamoDB and SSM Client Initialization

```js
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const TENANTS_TABLE = process.env.TENANTS_TABLE || 'GroceryTenants';
const LISTS_TABLE = process.env.LISTS_TABLE || 'GroceryLists';
```

These are initialized once when the Lambda container starts (the "cold start"). Each subsequent invocation reuses these clients. The table names come from environment variables injected by CloudFormation — this lets the same code work across different deployments without hardcoding names.

### 3. Secrets Caching

```js
let twilioSecrets = null;
async function getTwilioSecrets() {
  if (twilioSecrets) return twilioSecrets;
  // ... fetch from SSM and cache ...
}
```

Twilio credentials (Account SID, API Key SID, API Key Secret) are stored encrypted in SSM Parameter Store. This function fetches all three in a single SSM API call and caches the result in the `twilioSecrets` variable. Because Lambda containers are reused across warm invocations, this means SSM is only called once per container lifetime — reducing latency and SSM API costs.

The `if (twilioSecrets) return twilioSecrets;` guard is the cache check. On the first invocation (cold start) it's `null` and SSM is called. On all subsequent warm invocations it returns immediately.

### 4. DynamoDB Helper Functions

```js
async function readList(tenantId, listId = DEFAULT_LIST) { ... }
async function writeList(tenantId, items, modifiedBy, listId = DEFAULT_LIST) { ... }
async function isAuthorized(tenantId, fromNumber) { ... }
```

Three thin wrappers around DynamoDB:

- **`readList`** — fetches the `items` array for a given tenant and list. Returns an empty array if no list exists yet (first use).
- **`writeList`** — overwrites the entire list with a new `items` array. Also records `updatedAt` and `lastModifiedBy`.
- **`isAuthorized`** — fetches the tenant record and checks if `fromNumber` is in `authorizedNumbers`. Returns `false` if the tenant doesn't exist at all.

> **Why `writeList` overwrites the whole array instead of using a DynamoDB update expression:**
> At grocery list scale (dozens of items), reading the full array, modifying it in JavaScript, and writing it back is simpler and just as fast as a DynamoDB update expression. It also makes the remove-by-index and remove-by-name logic straightforward native array operations.

### 5. Express Route Handler

```js
app.post('/sms', async (req, res) => {
  const tenantId = req.body.To;
  const userId = req.body.From;
  const body = req.body.Body ?? '';
  ...
});
```

This is the single HTTP endpoint. All SMS commands flow through here.

**Flow:**
1. Extract `To`, `From`, `Body` from the Twilio POST body
2. Check authorization — reject immediately if not authorized
3. Parse the first word of `Body` to determine the command
4. Execute the command (read/write DynamoDB as needed)
5. Return a TwiML XML response that Twilio converts to an SMS

**Command-specific notes:**

- **`add`** — splits the input on commas (`"milk, eggs, bread"` → `["milk", "eggs", "bread"]`) and pushes all items onto the array in one write.
- **`remove`** — splits on commas to support multi-remove (`"2,3,4"` or `"eggs, bread"`). Each target is resolved to a 0-based array index — either by parsing it as a number, or by case-insensitive name match. Indices are then sorted highest-to-lowest before splicing so that removing index 4 doesn't shift index 2's position before it is removed. Duplicate indices are deduplicated with `Set`.
- **`announce`** — reads `authorizedNumbers` from the `GroceryTenants` table at runtime and sends the broadcast to all of them. This means adding a new family member to `authorizedNumbers` automatically includes them in future announcements — no code change needed.

### 6. Dual-Mode Entry Point

```js
// Lambda handler
const serverless = require('serverless-http');
module.exports.handler = serverless(app);

// Local dev entrypoint
if (require.main === module) {
  http.createServer(app).listen(8080, () => {
    console.log('Express server listening on port 8080');
  });
}
```

`serverless-http` wraps the Express app so Lambda can invoke it — Lambda passes an event object, `serverless-http` translates it into a fake HTTP request Express understands, then translates Express's response back into a Lambda response object.

`if (require.main === module)` is true only when you run the file directly with `node twilio.js`. It is `false` when Lambda imports it as a module (via `require('twilio')`). This means the same file runs locally as a plain HTTP server and in production as a Lambda function with no code changes.

## Dependencies (package.json)

| Package | Version | Purpose |
|---------|---------|---------|
| `@aws-sdk/client-dynamodb` | ^3.600.0 | Base DynamoDB client |
| `@aws-sdk/client-ssm` | ^3.600.0 | SSM Parameter Store client |
| `@aws-sdk/lib-dynamodb` | ^3.600.0 | Document Client — auto-marshals JS types |
| `body-parser` | ^1.20.3 | Parses URL-encoded form bodies |
| `express` | ^4.19.2 | HTTP routing |
| `serverless-http` | ^3.2.0 | Wraps Express for Lambda |
| `twilio` | ^5.3.0 | TwiML builder + outbound SMS |

## template.yaml — SAM Infrastructure

The `template.yaml` file defines every AWS resource the app needs. SAM (Serverless Application Model) is a CloudFormation extension that adds shorthand types like `AWS::Serverless::Function` that expand into multiple CloudFormation resources during deployment.

**Key sections:**

- **`Parameters`** — values passed in at deploy time (domain name, hosted zone ID, ACM cert ARN). These are supplied via GitHub Secrets in CI/CD.
- **`Globals`** — default settings applied to all Lambda functions (runtime, timeout, memory, environment variables).
- **`Resources`** — every AWS resource: Lambda, API Gateway, custom domain, Route 53 record, two DynamoDB tables.
- **`Outputs`** — values printed after a successful deploy (the live endpoint URLs, Lambda ARN).

Any infrastructure change — new environment variable, different timeout, new IAM permission — is made by editing `template.yaml`. Never change infrastructure through the AWS console; those changes will be overwritten on the next deploy.
