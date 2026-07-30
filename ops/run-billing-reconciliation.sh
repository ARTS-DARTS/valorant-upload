#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE=${BILLING_ENV_FILE:-/var/www/valorant-upload/.env}
ENDPOINT=${BILLING_RECONCILIATION_URL:-http://127.0.0.1:3000/api/internal/billing/reconcile/robokassa}

if [[ ! -r "$ENV_FILE" ]]; then
  echo "billing env file is unavailable" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ ${ROBOKASSA_TEST_MODE:-true} != false ]]; then
  echo "reconciliation remains disabled in Robokassa test mode"
  exit 0
fi
if [[ ${#BILLING_RECONCILIATION_TOKEN} -lt 32 ]]; then
  echo "BILLING_RECONCILIATION_TOKEN is missing or too short" >&2
  exit 1
fi

curl --fail --silent --show-error \
  --max-time 120 \
  --request POST \
  --header "Authorization: Bearer ${BILLING_RECONCILIATION_TOKEN}" \
  "$ENDPOINT"
echo
