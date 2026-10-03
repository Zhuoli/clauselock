#!/usr/bin/env bash
# Spaced-out devnet airdrop retries (public faucet only, no accounts). When the deployer has enough
# devnet SOL, deploy and run the devnet demo once. Log: /tmp/clauselock-airdrop.log
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
ADDR=$(solana address); NEED=${NEED:-1.6}; INTERVAL=${INTERVAL:-1200}; TRIES=${TRIES:-36}
for i in $(seq 1 "$TRIES"); do
  BAL=$(solana balance -u devnet "$ADDR" | awk '{print $1}')
  echo "$(date '+%F %T %Z') try $i balance=$BAL"
  if awk "BEGIN{exit !($BAL >= $NEED)}"; then
    echo "funded; deploying"; ./scripts/deploy-devnet.sh && npx tsx scripts/demo.ts --cluster devnet; exit $?
  fi
  for amt in 1 0.5; do
    out=$(solana airdrop "$amt" "$ADDR" -u devnet 2>&1 | tail -1); echo "  airdrop $amt: $out"
    case "$out" in *Signature*|*SOL) break;; esac
  done
  sleep "$INTERVAL"
done
echo "gave up after $TRIES tries"
