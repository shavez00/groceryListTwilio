# Architecture Overview

## High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          PUBLIC INTERNET                            │
│                                                                     │
│   📱 Phone  ──SMS──►  Twilio  ──HTTPS POST──►  grocerylist.        │
│                                               vezcore.com/sms      │
└────────────────────────────────────┬────────────────────────────────┘
                                     │
                            ┌────────▼────────┐
                            │   Route 53      │
                            │  (DNS Alias A   │
                            │   Record)       │
                            └────────┬────────┘
                                     │
                            ┌────────▼────────┐
                            │  ACM Certificate│
                            │  (TLS for       │
                            │  grocerylist.   │
                            │  vezcore.com)   │
                            └────────┬────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────┐
│                            AWS (us-west-2)                          │
│                                                                     │
│   ┌──────────────────────┐                                          │
│   │  API Gateway (HTTP)  │  POST /sms                               │
│   │  $default stage      │                                          │
│   └──────────┬───────────┘                                          │
│              │  invoke                                              │
│   ┌──────────▼───────────┐      ┌─────────────────────────────┐    │
│   │  Lambda Function     │─────►│  SSM Parameter Store        │    │
│   │  grocery-list-twilio │      │  /grocerylist/twilio/       │    │
│   │  Node.js 20.x        │      │  accountSID (SecureString)  │    │
│   │  128 MB / 15s timeout│      │  apiKeySID  (SecureString)  │    │
│   └──────────┬───────────┘      │  apiKeySecret (SecureString)│    │
│              │                  └─────────────────────────────┘    │
│              │ read/write                                           │
│   ┌──────────▼───────────────────────────────────────────────┐     │
│   │                      DynamoDB                             │     │
│   │                                                           │     │
│   │  GroceryTenants          GroceryLists                     │     │
│   │  ┌──────────────┐        ┌──────────────────────────┐    │     │
│   │  │ PK: tenantId │        │ PK: tenantId             │    │     │
│   │  │ familyName   │        │ SK: listId               │    │     │
│   │  │ authorized   │        │ items (List<String>)     │    │     │
│   │  │   Numbers    │        │ updatedAt                │    │     │
│   │  │ mcpApiKey    │        │ lastModifiedBy           │    │     │
│   │  └──────────────┘        └──────────────────────────┘    │     │
│   └───────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

## AWS Services Used

### Lambda (`grocery-list-twilio`)
- **Runtime:** Node.js 20.x
- **Memory:** 128 MB
- **Timeout:** 15 seconds
- **Purpose:** Processes incoming Twilio webhooks. Reads the SMS command, authorizes the sender, reads/writes DynamoDB, and returns a TwiML XML response.
- **Handler:** `twilio.handler` (exported by `twilio.js` via `serverless-http`)
- **IAM Role:** Automatically created by SAM. Grants DynamoDB CRUD on both tables and SSM read on `/grocerylist/twilio/*`.

### API Gateway (HTTP API)
- **Type:** HTTP API (API Gateway v2) — lower cost and latency than REST API
- **Stage:** `$default`
- **Route:** `POST /sms` → Lambda
- **Custom domain:** `grocerylist.vezcore.com` mapped via `ApiGatewayV2::ApiMapping`
- **Why HTTP API over REST API:** This app only needs a single POST route with no API keys, usage plans, or complex request transformation. HTTP API is simpler and cheaper.

### DynamoDB
- **Billing mode:** PAY_PER_REQUEST (on-demand) — no capacity to provision or manage. At household traffic levels this costs effectively nothing.
- **Two tables:** `GroceryTenants` (one row per family/Twilio number) and `GroceryLists` (one row per list per family).
- See [Data Model](data-model.md) for full schema detail.

### ACM (AWS Certificate Manager)
- **Certificate:** `grocerylist.vezcore.com` (regional, us-west-2)
- **Validation:** DNS validation via a CNAME record in Route 53
- **Purpose:** Provides TLS for the custom domain. API Gateway won't serve a custom domain without a validated cert.

### Route 53
- **Hosted zone:** `vezcore.com` (Zone ID: `Z29XWUV2I47AQU`)
- **Record:** `grocerylist.vezcore.com` → Alias A record pointing at the API Gateway regional domain name
- **Why Alias vs CNAME:** Alias records are free in Route 53 and resolve faster. AWS requires an Alias (not CNAME) for the zone apex anyway; using Alias here is consistent best practice.

### SSM Parameter Store
- **Parameters (all SecureString / KMS-encrypted):**
  - `/grocerylist/twilio/accountSID` — Twilio Account SID (`AC...`)
  - `/grocerylist/twilio/apiKeySID` — Twilio API Key SID (`SK...`)
  - `/grocerylist/twilio/apiKeySecret` — Twilio API Key Secret
- **Why SSM and not Lambda env vars:** Environment variables in Lambda are stored in plaintext in the function configuration. SSM SecureString encrypts at rest with KMS and the value is never visible in the AWS console or CloudFormation. Credentials are fetched at Lambda cold start and cached in memory for the lifetime of the container.

### IAM
- A least-privilege IAM user (`github-actions-grocery-list`) is used exclusively by GitHub Actions to deploy. It has no console access, only the permissions needed for CloudFormation, Lambda, API Gateway, DynamoDB, IAM role management, Route 53, ACM, and SSM reads.
- The Lambda execution role is auto-created by SAM with only the permissions needed: DynamoDB CRUD on the two tables, and SSM read on the Twilio parameter path.

## Why Lambda and Not EC2 or a Container?

| | Lambda | EC2 | Container (ECS/Fargate) |
|---|---|---|---|
| Cost | ~$0/month at household scale | ~$8-15/month minimum | ~$15-30/month minimum |
| Maintenance | None | OS patching, reboots | Container updates, ECS config |
| Scaling | Automatic | Manual | Auto but complex to configure |
| Fit for this app | Perfect — stateless webhook | Overkill | Overkill |

This app receives one HTTP request per SMS message. It is inherently stateless (state lives in DynamoDB) and event-driven. Lambda was designed exactly for this pattern.

## Infrastructure as Code

All AWS resources are defined in `template.yaml` using AWS SAM (Serverless Application Model), which is a superset of CloudFormation. Changing infrastructure means editing `template.yaml` and pushing to `master` — the CI/CD pipeline handles the rest. No manual console changes should ever be made to provisioned resources.
