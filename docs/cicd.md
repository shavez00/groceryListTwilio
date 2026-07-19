# CI/CD Pipeline

## Overview

Every push to the `master` branch automatically deploys the application to AWS. There is no manual deploy step. The pipeline is defined in `.github/workflows/deploy.yml` and runs on GitHub's hosted infrastructure.

```
Developer pushes to master
         │
         ▼
  GitHub Actions triggered
         │
    ┌────▼────────────────────────────────────────────┐
    │  Job: deploy (ubuntu-latest runner)             │
    │                                                 │
    │  1. Checkout code                               │
    │  2. Set up Node.js 20 (with npm cache)          │
    │  3. npm ci  (install exact locked deps)         │
    │  4. Configure AWS credentials                   │
    │  5. Set up SAM CLI                              │
    │  6. sam build  (bundle Lambda code)             │
    │  7. sam deploy (update CloudFormation stack)    │
    └─────────────────────────────────────────────────┘
         │
         ▼
  AWS CloudFormation applies changes
         │
         ▼
  Lambda updated, infrastructure changes applied
```

## Pipeline Steps Explained

### Step 1 — Checkout
```yaml
- uses: actions/checkout@v4
```
Clones the repository onto the runner.

### Step 2 — Set up Node.js
```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'
```
Installs Node.js 20 and enables npm caching so subsequent runs don't re-download packages if `package-lock.json` hasn't changed.

### Step 3 — Install dependencies
```yaml
- run: npm ci
```
`npm ci` installs exactly the versions recorded in `package-lock.json`. Unlike `npm install`, it never silently upgrades packages and will fail if `package-lock.json` is out of sync with `package.json`. This makes builds reproducible.

### Step 4 — Configure AWS credentials
```yaml
- uses: aws-actions/configure-aws-credentials@v4
  with:
    aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
    aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
    aws-region: ${{ secrets.AWS_REGION }}
```
Injects temporary AWS credentials from GitHub Secrets into the runner environment. The IAM user (`github-actions-grocery-list`) has a least-privilege policy — only the permissions needed to deploy this specific stack.

### Step 5 — Set up SAM CLI
```yaml
- uses: aws-actions/setup-sam@v2
```
Installs the AWS SAM CLI on the runner.

### Step 6 — SAM build
```yaml
- run: sam build
```
SAM bundles the Lambda function code and its `node_modules` into a `.aws-sam/build/` directory, ready for upload to S3. This step resolves the `CodeUri: .` in `template.yaml` into a deployable artifact.

### Step 7 — SAM deploy
```yaml
- run: |
    sam deploy \
      --no-confirm-changeset \
      --no-fail-on-empty-changeset \
      --stack-name grocery-list-twilio \
      --parameter-overrides \
        HostedZoneId=${{ secrets.ROUTE53_HOSTED_ZONE_ID }} \
        AcmCertificateArn=${{ secrets.ACM_CERTIFICATE_ARN }} \
      --capabilities CAPABILITY_IAM \
      --resolve-s3
```

- `--no-confirm-changeset` — deploys without asking for confirmation (required for automation)
- `--no-fail-on-empty-changeset` — exits 0 if nothing changed (prevents spurious pipeline failures on empty commits)
- `--stack-name grocery-list-twilio` — the CloudFormation stack to create or update
- `--parameter-overrides` — passes in the hosted zone ID and ACM cert ARN from GitHub Secrets
- `--capabilities CAPABILITY_IAM` — grants CloudFormation permission to create IAM roles (needed for the Lambda execution role)
- `--resolve-s3` — automatically creates an S3 bucket for the deployment artifact if one doesn't exist

## GitHub Secrets

These are configured in the GitHub repository under **Settings → Secrets and variables → Actions**.

| Secret Name | What it contains |
|-------------|-----------------|
| `AWS_ACCESS_KEY_ID` | Access key for the `github-actions-grocery-list` IAM user |
| `AWS_SECRET_ACCESS_KEY` | Secret key for the `github-actions-grocery-list` IAM user |
| `AWS_REGION` | `us-west-2` |
| `ROUTE53_HOSTED_ZONE_ID` | `Z29XWUV2I47AQU` (the vezcore.com hosted zone) |
| `ACM_CERTIFICATE_ARN` | ARN of the validated ACM cert for grocerylist.vezcore.com |

**Secrets are never printed in logs.** GitHub Actions automatically masks any value that matches a registered secret.

## What Triggers a Deployment

- Any `git push` to the `master` branch — code changes, infrastructure changes, or even an empty commit

## What Does NOT Trigger a Deployment

- Pushes to any other branch
- Pull requests (there is no PR workflow configured — this is a solo project)
- Changes to files in `docs/` still trigger a deploy (the entire branch is built). If this becomes a concern, a path filter can be added.

## Viewing Deploy Status

```bash
# List recent runs
gh run list --repo shavez00/groceryListTwilio

# Watch a run live
gh run watch <run-id> --repo shavez00/groceryListTwilio

# View logs for a failed run
gh run view <run-id> --repo shavez00/groceryListTwilio --log-failed
```

Or visit: `https://github.com/shavez00/groceryListTwilio/actions`

## Deployment Duration

A typical deploy takes **2–3 minutes**:
- ~30s for checkout, Node setup, npm install
- ~15s for SAM build
- ~90–120s for CloudFormation to apply changes (Lambda update is fast; infrastructure changes like DynamoDB or API Gateway take longer)

If nothing changed in the CloudFormation template, `--no-fail-on-empty-changeset` causes the deploy step to skip the CloudFormation update and exit immediately after SAM validates the template.

## Rollback

SAM deploy uses CloudFormation changesets. If a deployment fails mid-way, CloudFormation automatically rolls back to the previous known-good state. Lambda functions are versioned — the previous code is restored.

If a deployment succeeds but introduces a bug, roll back by reverting the commit and pushing:
```bash
git revert HEAD
git push origin master
```
This creates a new commit that undoes the change and triggers a fresh deploy.
