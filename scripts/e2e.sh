#!/usr/bin/env bash
# Local validator + deploy + Playwright browser tests of the web UI (burner wallets on localnet).
set -euo pipefail
cd "$(dirname "$0")/.."
LEDGER=${LEDGER:-/tmp/clauselock-e2e-ledger}
solana-test-validator --reset --quiet --ledger "$LEDGER" --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g &
VPID=$!; trap 'kill $VPID' EXIT
until solana -u localhost cluster-version >/dev/null 2>&1; do sleep 1; done; sleep 2
solana -u localhost airdrop 20 >/dev/null
solana -u localhost program deploy target/deploy/clauselock.so --program-id target/deploy/clauselock-keypair.json >/dev/null
npx playwright test -c web/playwright.config.ts "$@"
