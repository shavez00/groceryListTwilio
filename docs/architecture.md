# Architecture Overview

## High-Level Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                          PUBLIC INTERNET                             │
│                                                                      │
│   📱 Phone  ──SMS──►  Twilio  ──HTTPS POST──►  /sms                 │
│                                                                      │
│   🤖 ChatGPT  ──────────────────────────────►  /mcp                 │
│   (MCP connector)                              /oauth/token          │
│                                               /.well-known/...       │
│                                                                      │
│                       grocerylist.vezcore.com                        │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │
                         ┌────────▼────────┐
                         │   Route 53      │
                         │  (DNS Alias A)  │
                         └────────┬────────┘
                                  │
                         ┌────────▼────────┐
                         │  ACM Certificate│
                         │  (TLS)          │
                         └────────┬────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────────────┐
│                           AWS (us-west-2)                            │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  API Gateway HTTP API ($default stage)                         │  │
│  │                                                                │  │
│  │  POST /sms                         → Lambda                   │  │
│  │  ANY  /mcp                         → Lambda                   │  │
│  │  POST /oauth/token                 → Lambda                   │  │
│  │  GET  /oauth/authorize             → Lambda                   │  │
│  │  POST /oauth/authorize             → Lambda                   │  │
│  │  GET  /.well-known/oauth-authorization-server  → Lambda       │  │
│  │  GET  /.well-known/oauth-protected-resource/mcp → Lambda      │  │
│  └────────────────────────┬───────────────────────────────────────┘  │
│                           │ invoke                                   │
│  ┌────────────────────────▼───────────────────────┐                  │
│  │  Lambda: grocery-list-twilio                   │──► SSM           │
│  │  Node.js 20.x / 256 MB / 29s timeout          │    (Twilio creds)│
│  │                                                │                  │
│  │  twilio.js (entry point)                       │                  │
│  │  ├── routes/sms.js   (SMS commands / TwiML)    │                  │
│  │  ├── routes/oauth.js (OAuth 2.0 endpoints)     │                  │
│  │  └── src/mcp.js      (MCP server / 5 tools)    │                  │
│  │       ├── src/service.js   (business logic)    │                  │
│  │       └── src/repository.js (DynamoDB ops)     │                  │
│  └────────────────────────┬───────────────────────┘                  │
│                           │ read/write                               │
│  ┌────────────────────────▼───────────────────────────────────────┐  │
│  │  DynamoDB                                                      │  │
│  │                                                                │  │
│  │  GroceryTenants                  GroceryLists                  │  │
│  │  ┌──────────────────────┐        ┌─────────────────────────┐  │  │
│  │  │ PK: tenantId         │        │ PK: tenantId            │  │  │
│  │  │ familyName           │        │ SK: listId              │  │  │
│  │  │ authorizedNumbers    │        │ items (List<String>)    │  │  │
│  │  │ mcpApiKey            │        │ version (Number)        │  │  │
│  │  │ mcpApiKeyHash        │        │ updatedAt               │  │  │
│  │  │   GSI: mcpApiKeyHash │        │ lastModifiedBy          │  │  │
│  │  │        -index        │        └─────────────────────────┘  │  │
│  │  └──────────────────────┘                                      │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## AWS Services Used

### Lambda (`grocery-list-twilio`)
- **Runtime:** Node.js 20.x
- **Memory:** 256 MB
- **Timeout:** 29 seconds (matches API Gateway HTTP API maximum)
- **Handler:** `twilio.handler` (exported by `twilio.js` via `serverless-http`)
- **IAM Role:** Auto-created by SAM. Grants DynamoDB CRUD on both tables and SSM read on `/grocerylist/twilio/*`.

### API Gateway (HTTP API)
- **Type:** HTTP API (API Gateway v2)
- **Stage:** `$default`
- **Routes:** See diagram above — SMS, MCP, and OAuth endpoints all route to the same Lambda
- **Custom domain:** `grocerylist.vezcore.com` via `ApiGatewayV2::ApiMapping`

### DynamoDB
- **Billing mode:** PAY_PER_REQUEST (on-demand)
- **Tables:** `GroceryTenants` and `GroceryLists`
- **GSI:** `mcpApiKeyHash-index` on `GroceryTenants` — enables O(1) bearer token lookup without a full table scan
- **DeletionPolicy:** `Retain` on both tables — stack deletion won't delete data
- See [Data Model](data-model.md) for full schema.

### ACM + Route 53 + SSM
Unchanged from original design — see original architecture notes. SSM holds Twilio credentials fetched at Lambda cold start and cached in memory.

### IAM
A least-privilege IAM user (`github-actions-grocery-list`) is used exclusively by GitHub Actions for deployment. The Lambda execution role is auto-created by SAM.

## Why Lambda and Not EC2 or a Container?

| | Lambda | EC2 | Container (ECS/Fargate) |
|---|---|---|---|
| Cost | ~$0/month at household scale | ~$8–15/month minimum | ~$15–30/month minimum |
| Maintenance | None | OS patching, reboots | Container updates, ECS config |
| Scaling | Automatic | Manual | Auto but complex |
| Fit | Perfect — stateless, event-driven | Overkill | Overkill |

## MCP Protocol Architecture

The MCP (Model Context Protocol) endpoint uses `WebStandardStreamableHTTPServerTransport` in stateless mode (no sessions). A new transport instance is created per HTTP request, which is ideal for Lambda's stateless execution model.

**Why `WebStandard` transport and not the Node.js transport:**
The Node.js `StreamableHTTPServerTransport` uses Hono's `getRequestListener` to bridge Node.js HTTP → Web Standard `Request`. It reads `rawHeaders` from the incoming request, which `serverless-http` never populates (only `headers` is set). This caused 406 errors in production. The `WebStandardStreamableHTTPServerTransport` accepts a manually-constructed `Request` built from Express's `req.headers` (always populated), bypassing the Hono bridge entirely.

**Bearer auth:** The `Authorization: Bearer <mcpApiKey>` header is validated before the MCP transport sees the request. The raw UUID is SHA-256 hashed and queried against the `mcpApiKeyHash-index` GSI to resolve the tenant. The resolved `tenantId` is passed to tool handlers via `authInfo.extra.tenantId` — tools never accept `tenantId` as an argument.

## Infrastructure as Code

All AWS resources are defined in `template.yaml` using AWS SAM. Never make manual console changes — they will be overwritten on the next deploy.
