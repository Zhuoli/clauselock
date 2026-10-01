#!/usr/bin/env bash
# Start a local validator that matches devnet/mainnet loader rules (SBPF v1 deploys allowed), deploy, run the demo.
set -euo pipefail
cd "$(dirname "$0")/.."
LEDGER=${LEDGER:-/tmp/clauselock-ledger}
# SIMD-0500 ("disable deployment of SBPF v0-v2") is active by default on test-validator 4.x but inactive on devnet.
solana-test-validator --reset --quiet --ledger "$LEDGER" --deactivate-feature B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g &
VPID=$!; trap 'kill $VPID' EXIT
until solana -u localhost cluster-version >/dev/null 2>&1; do sleep 1; done; sleep 2
solana -u localhost airdrop 20 >/dev/null
solana -u localhost program deploy target/deploy/clauselock.so --program-id target/deploy/clauselock-keypair.json
npx tsx scripts/demo.ts --cluster localnet
