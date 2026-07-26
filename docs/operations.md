# Operations Guide

## Adding a New Family (New Tenant)

Each family needs their own Twilio phone number. Once you have one, add a record to DynamoDB, then run the backfill script to set `mcpApiKeyHash`.

```bash
# 1. Generate a UUID for mcpApiKey
uuidgen   # or use https://www.uuidgenerator.net

# 2. Add the tenant record
aws dynamodb put-item \
  --table-name GroceryTenants \
  --region us-west-2 \
  --item '{
    "tenantId":          {"S": "+1XXXXXXXXXX"},
    "familyName":        {"S": "New Family Name"},
    "authorizedNumbers": {"L": [{"S": "+1XXXXXXXXXX"}]},
    "mcpApiKey":         {"S": "your-generated-uuid"},
    "createdAt":         {"S": "2026-01-01T00:00:00Z"}
  }'

# 3. Populate mcpApiKeyHash (required for MCP bearer auth)
bash backfill-mcp-key-hash.sh
```

Then configure the Twilio webhook for the new number to point at `https://grocerylist.vezcore.com/sms`. No code or infrastructure changes needed.

---

## Adding or Removing an Authorized Number

**Add a number:**
```bash
aws dynamodb update-item \
  --table-name GroceryTenants \
  --region us-west-2 \
  --key '{"tenantId": {"S": "+15034448534"}}' \
  --update-expression "SET authorizedNumbers = list_append(authorizedNumbers, :new)" \
  --expression-attribute-values '{":new": {"L": [{"S": "+1NEWNUMBER"}]}}'
```

**Remove a number** (rewrite the whole list):
```bash
aws dynamodb put-item \
  --table-name GroceryTenants \
  --region us-west-2 \
  --item '{
    "tenantId":          {"S": "+15034448534"},
    "familyName":        {"S": "Shavez Family"},
    "authorizedNumbers": {"L": [{"S": "+15037812714"}]},
    "mcpApiKey":         {"S": "a3f8c2d1-7e4b-4a09-b56d-9f2e1c0d3a87"},
    "mcpApiKeyHash":     {"S": "<existing hash — get with aws dynamodb get-item>"},
    "createdAt":         {"S": "2026-07-19T22:00:00Z"}
  }'
```

---

## Viewing a Family's Current List

```bash
aws dynamodb get-item \
  --table-name GroceryLists \
  --region us-west-2 \
  --key '{"tenantId": {"S": "+15034448534"}, "listId": {"S": "grocery"}}'
```

---

## Clearing a List Manually

```bash
aws dynamodb put-item \
  --table-name GroceryLists \
  --region us-west-2 \
  --item '{
    "tenantId":        {"S": "+15034448534"},
    "listId":          {"S": "grocery"},
    "items":           {"L": []},
    "version":         {"N": "0"},
    "updatedAt":       {"S": "2026-07-26T00:00:00Z"},
    "lastModifiedBy":  {"S": "manual-admin"}
  }'
```

---

## Rotating the MCP API Key

1. Generate a new UUID: `uuidgen`
2. Update both `mcpApiKey` and `mcpApiKeyHash` in DynamoDB:

```bash
NEW_KEY="your-new-uuid"
NEW_HASH=$(echo -n "$NEW_KEY" | sha256sum | cut -d' ' -f1)

aws dynamodb update-item \
  --table-name GroceryTenants \
  --region us-west-2 \
  --key '{"tenantId": {"S": "+15034448534"}}' \
  --update-expression "SET mcpApiKey = :k, mcpApiKeyHash = :h" \
  --expression-attribute-values "{\":k\": {\"S\": \"$NEW_KEY\"}, \":h\": {\"S\": \"$NEW_HASH\"}}"
```

3. Reconnect ChatGPT with the new key (sign in again via the OAuth flow)
4. Verify ChatGPT can still call tools

---

## Rotating Twilio Credentials

1. Create a new API Key in the Twilio console (Account → API Keys)
2. Update SSM:

```bash
aws ssm put-parameter --name /grocerylist/twilio/apiKeySID \
  --value "SKnewkeyid" --type SecureString --overwrite --region us-west-2

aws ssm put-parameter --name /grocerylist/twilio/apiKeySecret \
  --value "newkeysecret" --type SecureString --overwrite --region us-west-2
```

3. Force Lambda container refresh (SSM values are cached per container):

```bash
aws lambda update-function-configuration \
  --function-name grocery-list-twilio \
  --region us-west-2 \
  --description "force-redeploy-$(date +%s)"
```

4. Delete the old API Key in the Twilio console.

---

## Monitoring and Logs

```bash
# Follow live logs
aws logs tail /aws/lambda/grocery-list-twilio --follow --region us-west-2

# Check recent deploy status
gh run list --repo shavez00/groceryListTwilio --limit 5

# Lambda configuration
aws lambda get-function-configuration \
  --function-name grocery-list-twilio --region us-west-2
```

**What to look for:**
- `MCP auth error` or `MCP handler error` — MCP authentication or transport issues
- `SMS handler error` — SMS command processing failure
- `OAuth token error` / `OAuth authorize error` — OAuth endpoint failures
- DynamoDB `ConditionalCheckFailedException` — version conflict (handled by retry logic; only a concern if appearing frequently)

---

## Smoke Testing

**SMS:**
```bash
curl -s -X POST https://grocerylist.vezcore.com/sms \
  -d "To=%2B15034448534&From=%2B15037812714&Body=list"
```

**MCP (bearer token):**
```bash
curl -s -X POST https://grocerylist.vezcore.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer a3f8c2d1-7e4b-4a09-b56d-9f2e1c0d3a87" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**OAuth discovery:**
```bash
curl -s https://grocerylist.vezcore.com/.well-known/oauth-authorization-server
```

---

## Tearing Down the Application

```bash
aws cloudformation delete-stack \
  --stack-name grocery-list-twilio --region us-west-2

aws cloudformation wait stack-delete-complete \
  --stack-name grocery-list-twilio --region us-west-2
```

**Note:** Both DynamoDB tables have `DeletionPolicy: Retain`. The stack deletion will succeed but the tables and their data will remain. Delete them separately if needed:

```bash
aws dynamodb delete-table --table-name GroceryTenants --region us-west-2
aws dynamodb delete-table --table-name GroceryLists --region us-west-2
```

This does **not** delete: the ACM certificate, SSM parameters, or the IAM user. Delete those manually.
