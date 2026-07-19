# Operations Guide

Day-to-day tasks for maintaining and extending the application.

## Adding a New Family (New Tenant)

Each family needs their own Twilio phone number. Once they have one, add a record to DynamoDB.

```bash
aws dynamodb put-item \
  --table-name GroceryTenants \
  --region us-west-2 \
  --item '{
    "tenantId":          {"S": "+1XXXXXXXXXX"},
    "familyName":        {"S": "New Family Name"},
    "authorizedNumbers": {"L": [{"S": "+1XXXXXXXXXX"}]},
    "mcpApiKey":         {"S": "generate-a-uuid-here"},
    "createdAt":         {"S": "2026-01-01T00:00:00Z"}
  }'
```

Then configure the webhook on the new Twilio number to point at `https://grocerylist.vezcore.com/sms`. No code or infrastructure changes are needed.

---

## Adding or Removing an Authorized Number

To add a number to an existing family's authorized list:

```bash
aws dynamodb update-item \
  --table-name GroceryTenants \
  --region us-west-2 \
  --key '{"tenantId": {"S": "+15034448534"}}' \
  --update-expression "SET authorizedNumbers = list_append(authorizedNumbers, :new)" \
  --expression-attribute-values '{":new": {"L": [{"S": "+1NEWNUMBER"}]}}'
```

To remove a number, the simplest approach is to rewrite the whole list with a `put-item` that overwrites the existing record (use the same key):

```bash
aws dynamodb put-item \
  --table-name GroceryTenants \
  --region us-west-2 \
  --item '{
    "tenantId":          {"S": "+15034448534"},
    "familyName":        {"S": "Shavez Family"},
    "authorizedNumbers": {"L": [{"S": "+15037812714"}]},
    "mcpApiKey":         {"S": "a3f8c2d1-7e4b-4a09-b56d-9f2e1c0d3a87"},
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
    "updatedAt":       {"S": "2026-07-19T00:00:00Z"},
    "lastModifiedBy":  {"S": "manual-admin"}
  }'
```

---

## Rotating Twilio Credentials

If you need to rotate the API Key (e.g. after a suspected compromise):

1. Create a new API Key in the Twilio console (Account → API Keys → Create new key)
2. Update SSM with the new values:

```bash
aws ssm put-parameter \
  --name /grocerylist/twilio/apiKeySID \
  --value "SKnewkeyid" \
  --type SecureString \
  --overwrite \
  --region us-west-2

aws ssm put-parameter \
  --name /grocerylist/twilio/apiKeySecret \
  --value "newkeysecret" \
  --type SecureString \
  --overwrite \
  --region us-west-2
```

3. Force a Lambda redeployment so existing warm containers pick up the new values:

```bash
aws lambda update-function-configuration \
  --function-name grocery-list-twilio \
  --region us-west-2 \
  --description "force-redeploy-$(date +%s)"
```

4. Delete the old API Key in the Twilio console.

The credentials are cached per Lambda container. The forced redeploy flushes all containers, guaranteeing no container is still using the old key.

---

## Rotating GitHub Actions AWS Credentials

1. Create a new access key for the IAM user:

```bash
aws iam create-access-key --user-name github-actions-grocery-list
```

2. Update both GitHub Secrets with the new values (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).

3. Verify a deploy works successfully.

4. Delete the old access key:

```bash
aws iam delete-access-key \
  --user-name github-actions-grocery-list \
  --access-key-id AKIAOLDKEYID
```

---

## Monitoring and Logs

Lambda writes all console output to CloudWatch Logs automatically.

**View recent logs in the AWS console:**
CloudWatch → Log groups → `/aws/lambda/grocery-list-twilio`

**View logs from the CLI:**
```bash
aws logs tail /aws/lambda/grocery-list-twilio \
  --follow \
  --region us-west-2
```

**What to look for in logs:**
- `Saved!` — an item was added (legacy message, may still appear)
- Authorization failures — logged implicitly via the 200 response with "not authorized"
- DynamoDB errors — will appear as unhandled promise rejections

---

## Checking the Lambda Function

```bash
# Current function configuration
aws lambda get-function-configuration \
  --function-name grocery-list-twilio \
  --region us-west-2

# Recent invocation metrics (last 1 hour)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value=grocery-list-twilio \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 3600 \
  --statistics Sum \
  --region us-west-2
```

---

## Tearing Down the Application

To remove all AWS resources:

```bash
aws cloudformation delete-stack \
  --stack-name grocery-list-twilio \
  --region us-west-2

aws cloudformation wait stack-delete-complete \
  --stack-name grocery-list-twilio \
  --region us-west-2
```

This deletes Lambda, API Gateway, DynamoDB tables (and all data), and the Route 53 record. It does **not** delete:
- The ACM certificate (delete manually in the ACM console)
- The SSM parameters (delete manually or with `aws ssm delete-parameter`)
- The IAM user `github-actions-grocery-list` (delete manually)
- The S3 bucket created by SAM for deployment artifacts

> **Warning:** Deleting the CloudFormation stack deletes the DynamoDB tables and all grocery list data permanently. Export data first if needed.
