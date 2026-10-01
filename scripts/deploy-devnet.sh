#!/usr/bin/env bash
# Deploy to devnet (needs ~1.4 devnet SOL in ~/.config/solana/id.json; devnet SOL only, never mainnet).
set -euo pipefail
cd "$(dirname "$0")/.."
BAL=$(solana balance -u devnet | awk '{print $1}')
echo "deployer $(solana address) has $BAL devnet SOL"
solana program deploy -u devnet target/deploy/clauselock.so --program-id target/deploy/clauselock-keypair.json
solana program show -u devnet "$(solana address -k target/deploy/clauselock-keypair.json)"
echo "Upgrade authority is retained during development. To freeze: solana program set-upgrade-authority -u devnet <PROGRAM_ID> --final"
