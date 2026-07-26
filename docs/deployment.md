# Deployment Guide

This guide covers everything needed to deploy from scratch into a new AWS account. For code changes to an existing deployment, push to `master` — CI/CD handles the rest.

## Prerequisites

### Accounts and Access
- [ ] AWS account with admin access
- [ ] Twilio account with at least one purchased phone number
- [ ] GitHub account with a fork/clone of this repository
- [ ] Domain in Route 53 (a hosted zone, e.g. `vezcore.com`)

### Local Tools
```bash
node --version   # v20.x or higher
aws --version    # AWS CLI v2
sam --version    # AWS SAM CLI
gh --version     # GitHub CLI (optional)
```

**Install links:** [Node.js](https://nodejs.org) | [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) | [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) | [GitHub CLI](https://cli.github.com)

---

## Step 1 — Store Twilio Credentials in SSM

```bash
aws ssm put-parameter \
  --name /grocerylist/twilio/accountSID \
  --value "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  --type SecureString --region us-west-2

aws ssm put-parameter \
  --name /grocerylist/twilio/apiKeySID \
  --value "SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  --type SecureString --region us-west-2

aws ssm put-parameter \
  --name /grocerylist/twilio/apiKeySecret \
  --value "your_api_key_secret" \
  --type SecureString --region us-west-2
```

You need: Account SID (`AC...`), API Key SID (`SK...`), and API Key Secret — all from the Twilio console under Account → API Keys.

---

## Step 2 — Request and Validate an ACM Certificate

```bash
aws acm request-certificate \
  --domain-name grocerylist.yourdomain.com \
  --validation-method DNS --region us-west-2
# Save the returned CertificateArn
```

Get the DNS validation CNAME and add it to Route 53:
```bash
aws acm describe-certificate --certificate-arn <arn> --region us-west-2 \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord"

aws route53 change-resource-record-sets \
  --hosted-zone-id <zone-id> \
  --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"<Name>","Type":"CNAME","TTL":300,"ResourceRecords":[{"Value":"<Value>"}]}}]}'

aws acm wait certificate-validated --certificate-arn <arn> --region us-west-2
```

---

## Step 3 — Create the GitHub Actions IAM User

```bash
aws iam create-user --user-name github-actions-grocery-list

aws iam put-user-policy \
  --user-name github-actions-grocery-list \
  --policy-name GroceryListDeploy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "cloudformation:*", "s3:*", "lambda:*", "apigateway:*", "dynamodb:*",
        "iam:CreateRole", "iam:DeleteRole", "iam:AttachRolePolicy",
        "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
        "iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies", "iam:PassRole", "iam:TagRole", "iam:UntagRole",
        "route53:ChangeResourceRecordSets", "route53:GetHostedZone",
        "route53:ListResourceRecordSets", "route53:GetChange",
        "acm:DescribeCertificate", "acm:ListCertificates", "acm:GetCertificate",
        "ssm:GetParameters", "ssm:GetParameter"
      ],
      "Resource": "*"
    }]
  }'

aws iam create-access-key --user-name github-actions-grocery-list
# Save the AccessKeyId and SecretAccessKey — you cannot retrieve the secret again
```

---

## Step 4 — Find Your Route 53 Hosted Zone ID

```bash
aws route53 list-hosted-zones \
  --query "HostedZones[?Name=='yourdomain.com.'].[Id,Name]" --output table
# Zone ID is the part after /hostedzone/
```

---

## Step 5 — Configure GitHub Secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|--------|-------|
| `AWS_ACCESS_KEY_ID` | From Step 3 |
| `AWS_SECRET_ACCESS_KEY` | From Step 3 |
| `AWS_REGION` | `us-west-2` |
| `ROUTE53_HOSTED_ZONE_ID` | From Step 4 |
| `ACM_CERTIFICATE_ARN` | From Step 2 |

---

## Step 6 — Deploy

```bash
git push origin master
gh run watch --repo youruser/groceryListTwilio   # watch it live
```

Takes 2–4 minutes. Verify:
```bash
aws cloudformation describe-stacks \
  --stack-name grocery-list-twilio --region us-west-2 \
  --query "Stacks[0].[StackStatus,Outputs]"
```

---

## Step 7 — Seed the First Tenant

Generate a UUID for `mcpApiKey`:
```bash
uuidgen
```

```bash
aws dynamodb put-item \
  --table-name GroceryTenants --region us-west-2 \
  --item '{
    "tenantId":          {"S": "+1XXXXXXXXXX"},
    "familyName":        {"S": "Your Family"},
    "authorizedNumbers": {"L": [{"S": "+1XXXXXXXXXX"}]},
    "mcpApiKey":         {"S": "your-generated-uuid"},
    "createdAt":         {"S": "2026-01-01T00:00:00Z"}
  }'
```

Then populate `mcpApiKeyHash` (required for MCP bearer auth):
```bash
bash backfill-mcp-key-hash.sh
```

---

## Step 8 — Configure Twilio Webhook

In the Twilio console:
1. **Phone Numbers → Manage → Active numbers** → click your number
2. Under **Messaging**, set **"A message comes in"**:
   - URL: `https://grocerylist.yourdomain.com/sms`
   - Method: `HTTP POST`
3. Save

---

## Step 9 — Connect ChatGPT (MCP)

1. In ChatGPT, go to **Settings → Connectors** (or Developer Mode → MCP)
2. Add a new connector with Server URL: `https://grocerylist.yourdomain.com/mcp`
3. ChatGPT will redirect you to the OAuth sign-in page
4. Enter your `mcpApiKey` UUID and sign in
5. ChatGPT should discover all 5 tools

---

## Step 10 — Smoke Test

**SMS:**
```bash
curl -s -X POST https://grocerylist.yourdomain.com/sms \
  -d "To=%2B1TWILIONUMBER&From=%2B1AUTHORIZEDNUM&Body=list"
# Expected: TwiML XML with "List is currently empty."
```

**MCP:**
```bash
curl -s -X POST https://grocerylist.yourdomain.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer your-mcpApiKey-uuid" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# Expected: JSON or SSE response listing all 5 tools
```

**OAuth discovery:**
```bash
curl -s https://grocerylist.yourdomain.com/.well-known/oauth-authorization-server
# Expected: JSON with issuer, token_endpoint, etc.
```

Or just text the number `list` from an authorized phone.
