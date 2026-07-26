#!/usr/bin/env bash
# Run once after deploying the mcpApiKeyHash GSI to GroceryTenants.
# Populates mcpApiKeyHash for all existing tenants so bearer auth works.
set -euo pipefail

REGION=${AWS_REGION:-us-west-2}
TABLE=GroceryTenants

echo "Scanning $TABLE in $REGION..."

aws dynamodb scan \
  --table-name "$TABLE" \
  --region "$REGION" \
  --projection-expression "tenantId, mcpApiKey" \
  --output json \
| jq -r '.Items[] | [.tenantId.S, .mcpApiKey.S] | @tsv' \
| while IFS=$'\t' read -r tenantId mcpApiKey; do
    if [[ -z "$mcpApiKey" ]]; then
      echo "SKIP $tenantId — no mcpApiKey set"
      continue
    fi
    hash=$(echo -n "$mcpApiKey" | sha256sum | cut -d' ' -f1)
    aws dynamodb update-item \
      --table-name "$TABLE" \
      --region "$REGION" \
      --key "{\"tenantId\": {\"S\": \"$tenantId\"}}" \
      --update-expression "SET mcpApiKeyHash = :h" \
      --expression-attribute-values "{\":h\": {\"S\": \"$hash\"}}"
    echo "Updated $tenantId"
  done

echo "Backfill complete."
