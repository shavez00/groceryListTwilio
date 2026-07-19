# Deployment Guide

This guide covers everything needed to deploy this application from scratch into a new AWS account or after a full teardown. If you are just making code changes to an existing deployment, push to `master` and CI/CD handles it.

## Prerequisites

### Accounts and Access

- [ ] **AWS account** with admin or sufficiently privileged access
- [ ] **Twilio account** with at least one purchased phone number
- [ ] **GitHub account** with a fork or clone of this repository
- [ ] **Domain in Route 53** — a hosted zone for your domain (e.g. `vezcore.com`)

### Local Tools

Install these on your development machine:

```bash
# Node.js 20+
node --version   # should be v20.x or higher

# AWS CLI v2
aws --version

# AWS SAM CLI
sam --version

# GitHub CLI (optional but useful)
gh --version
```

**Install links:**
- Node.js: https://nodejs.org
- AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html
- SAM CLI: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
- GitHub CLI: https://cli.github.com

### AWS CLI Configuration

```bash
aws configure
# AWS Access Key ID: <your key>
# AWS Secret Access Key: <your secret>
# Default region name: us-west-2
# Default output format: json
```

---

## Step 1 — Store Twilio Credentials in SSM

The app fetches Twilio credentials from SSM Parameter Store at runtime. Store them as `SecureString` (KMS-encrypted) values.

You need three values from your Twilio console:
- **Account SID** — starts with `AC`, found on the Twilio dashboard
- **API Key SID** — starts with `SK`, created under Account → API Keys
- **API Key Secret** — the secret shown once when you create the API key (save it)

```bash
aws ssm put-parameter \
  --name /grocerylist/twilio/accountSID \
  --value "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  --type SecureString \
  --region us-west-2

aws ssm put-parameter \
  --name /grocerylist/twilio/apiKeySID \
  --value "SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  --type SecureString \
  --region us-west-2

aws ssm put-parameter \
  --name /grocerylist/twilio/apiKeySecret \
  --value "your_api_key_secret_here" \
  --type SecureString \
  --region us-west-2
```

---

## Step 2 — Request and Validate an ACM Certificate

The custom domain requires a TLS certificate. ACM provides this for free.

```bash
aws acm request-certificate \
  --domain-name grocerylist.yourdomain.com \
  --validation-method DNS \
  --region us-west-2
```

This returns a `CertificateArn`. **Save it** — you need it in Step 5.

Now get the DNS validation record:

```bash
aws acm describe-certificate \
  --certificate-arn <your-cert-arn> \
  --region us-west-2 \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord"
```

This returns a `Name` and `Value` for a CNAME record. Add it to Route 53:

```bash
aws route53 change-resource-record-sets \
  --hosted-zone-id <your-zone-id> \
  --change-batch '{
    "Changes": [{
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "<Name from above>",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "<Value from above>"}]
      }
    }]
  }'
```

Wait for validation (usually under 5 minutes):

```bash
aws acm wait certificate-validated \
  --certificate-arn <your-cert-arn> \
  --region us-west-2
echo "Certificate validated"
```

---

## Step 3 — Create the GitHub Actions IAM User

Create a dedicated IAM user for CI/CD with least-privilege permissions:

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
```

**Save the `AccessKeyId` and `SecretAccessKey` from the last command.** You can't retrieve the secret again.

---

## Step 4 — Find Your Route 53 Hosted Zone ID

```bash
aws route53 list-hosted-zones \
  --query "HostedZones[?Name=='yourdomain.com.'].[Id,Name]" \
  --output table
```

The zone ID looks like `Z29XWUV2I47AQU` (the part after `/hostedzone/`).

---

## Step 5 — Configure GitHub Secrets

In your GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**

Add all five secrets:

| Secret Name | Value |
|-------------|-------|
| `AWS_ACCESS_KEY_ID` | From Step 3 |
| `AWS_SECRET_ACCESS_KEY` | From Step 3 |
| `AWS_REGION` | `us-west-2` |
| `ROUTE53_HOSTED_ZONE_ID` | From Step 4 |
| `ACM_CERTIFICATE_ARN` | From Step 2 |

Or use the GitHub CLI:

```bash
gh secret set AWS_ACCESS_KEY_ID      --repo youruser/groceryListTwilio --body "AKIA..."
gh secret set AWS_SECRET_ACCESS_KEY  --repo youruser/groceryListTwilio --body "..."
gh secret set AWS_REGION             --repo youruser/groceryListTwilio --body "us-west-2"
gh secret set ROUTE53_HOSTED_ZONE_ID --repo youruser/groceryListTwilio --body "Z..."
gh secret set ACM_CERTIFICATE_ARN    --repo youruser/groceryListTwilio --body "arn:aws:acm:..."
```

---

## Step 6 — Deploy

Push to `master`. GitHub Actions handles the rest.

```bash
git push origin master
```

Watch the deploy:
```bash
gh run list --repo youruser/groceryListTwilio
gh run watch <run-id> --repo youruser/groceryListTwilio
```

The deploy takes 2–4 minutes. When it succeeds, verify the stack:

```bash
aws cloudformation describe-stacks \
  --stack-name grocery-list-twilio \
  --region us-west-2 \
  --query "Stacks[0].[StackStatus,Outputs]"
```

---

## Step 7 — Seed the First Tenant

The authorization system requires at least one tenant record before the app will accept any SMS. Replace the values below with your Twilio number, family name, and authorized phone numbers.

Generate a UUID for `mcpApiKey` with `uuidgen` or https://www.uuidgenerator.net.

```bash
aws dynamodb put-item \
  --table-name GroceryTenants \
  --region us-west-2 \
  --item '{
    "tenantId":          {"S": "+1XXXXXXXXXX"},
    "familyName":        {"S": "Your Family"},
    "authorizedNumbers": {"L": [{"S": "+1XXXXXXXXXX"}, {"S": "+1XXXXXXXXXX"}]},
    "mcpApiKey":         {"S": "your-uuid-here"},
    "createdAt":         {"S": "2026-01-01T00:00:00Z"}
  }'
```

---

## Step 8 — Configure Twilio Webhook

In the Twilio console, set the webhook for your phone number:

1. Go to **Phone Numbers → Manage → Active numbers**
2. Click your number
3. Under **Messaging**, set **"A message comes in"** to:
   - Type: `Webhook`
   - URL: `https://grocerylist.yourdomain.com/sms`
   - Method: `HTTP POST`
4. Save

---

## Step 9 — Smoke Test

```bash
curl -s -X POST https://grocerylist.yourdomain.com/sms \
  -d "To=+1XXXXXXXXXX&From=+1AUTHORIZEDNUM&Body=list"
```

You should see a TwiML XML response: `<Message>List is currently empty.</Message>`

Or just text the number `list` from an authorized phone.

---

## Updating the Domain Name

If you want to use a different subdomain, edit `template.yaml`:

```yaml
Parameters:
  DomainName:
    Type: String
    Default: yournewsubdomain.yourdomain.com
```

Then request a new ACM cert for that domain, update the `ACM_CERTIFICATE_ARN` secret, and push.

## Deploying to a Different Region

The app can run in any AWS region. Update:
1. `AWS_REGION` GitHub Secret
2. The `--region` flag in all `aws` CLI commands above
3. Request the ACM cert in the new region (certs are regional for API Gateway)
