# CI/CD Pipeline

## Overview

Every push to `master` automatically deploys the application to AWS. Pushes that only change `docs/` or `*.md` files are skipped (path filter). The pipeline is defined in `.github/workflows/deploy.yml`.

```
Push to master (non-docs)
         │
         ▼
  GitHub Actions (ubuntu-latest)
         │
    ┌────▼──────────────────────────────────────┐
    │  1. Checkout code                          │
    │  2. Set up Node.js 20 (npm cache)          │
    │  3. npm ci                                 │
    │  4. Syntax check (node --check)            │
    │  5. npm test (67 tests must pass)          │
    │  6. Configure AWS credentials              │
    │  7. Set up SAM CLI                         │
    │  8. sam validate                           │
    │  9. sam build                              │
    │  10. sam deploy                            │
    └────────────────────────────────────────────┘
         │
         ▼
  CloudFormation applies changeset
         │
         ▼
  Lambda updated, API Gateway routes updated
```

## Pipeline Steps

### Syntax check
```yaml
- run: node --check twilio.js && find src routes -name '*.js' -exec node --check {} \;
```
Catches syntax errors in all JS files before running tests or touching AWS.

### Tests
```yaml
- run: npm test
```
All 67 tests must pass. A failing test blocks the deploy.

### SAM validate
```yaml
- run: sam validate --region us-west-2
```
Validates `template.yaml` against the CloudFormation schema before deploying.

### SAM deploy
```yaml
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

- `--no-fail-on-empty-changeset` — exits 0 if nothing changed (prevents spurious failures)
- `--resolve-s3` — auto-creates an S3 bucket for deployment artifacts

## Path Filter

Pushes that only change files in `docs/` or `*.md` files at the repo root are skipped entirely:

```yaml
on:
  push:
    branches: [master]
    paths-ignore:
      - 'docs/**'
      - '*.md'
```

If a push includes both docs and code changes, the deploy runs normally.

## GitHub Secrets

Configured in **Settings → Secrets and variables → Actions**.

| Secret | Value |
|--------|-------|
| `AWS_ACCESS_KEY_ID` | IAM user access key |
| `AWS_SECRET_ACCESS_KEY` | IAM user secret key |
| `AWS_REGION` | `us-west-2` |
| `ROUTE53_HOSTED_ZONE_ID` | `Z29XWUV2I47AQU` |
| `ACM_CERTIFICATE_ARN` | ARN of the validated cert |

## Viewing Deploy Status

```bash
# List recent runs
gh run list --repo shavez00/groceryListTwilio --limit 5

# Watch a run live
gh run watch <run-id> --repo shavez00/groceryListTwilio

# View logs for a failed run
gh run view <run-id> --repo shavez00/groceryListTwilio --log-failed
```

Or: `https://github.com/shavez00/groceryListTwilio/actions`

## Deploy Duration

Typical: **1.5–2.5 minutes**
- ~30s: checkout, Node setup, npm install, syntax check, tests
- ~15s: SAM build
- ~60–90s: CloudFormation changeset (Lambda-only changes are fast; API Gateway or DynamoDB changes take longer)

## Rollback

If a deployment succeeds but introduces a bug:
```bash
git revert HEAD
git push origin master   # triggers a fresh deploy of the reverted code
```

CloudFormation also automatically rolls back on mid-deploy failures.
