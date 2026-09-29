#!/usr/bin/env bash
# One benchmark round, sequential so runs never compete for provider capacity.
#
#   bench/round.sh LABEL MABS_CHECKOUT SAMPLES HARNESS... [-- FIXTURE...]
#
# Example: bench/round.sh v4-step1 ~/worktrees/mabs-bench-step1 1 mabs-claude mabs-codex
# Samples are interleaved across harnesses and fixtures so drift in provider
# latency spreads evenly instead of landing on one configuration.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
label=$1 mabs=$2 samples=$3
shift 3
harnesses=()
fixtures=(parse-duration pocket-ledger)
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; fixtures=("$@"); break; fi
  harnesses+=("$1"); shift
done
for sample in $(seq 1 "$samples"); do
  for fixture in "${fixtures[@]}"; do
    for harness in "${harnesses[@]}"; do
      node "$here/run.ts" --fixture="$fixture" --harness="$harness" --mabs="$mabs" --label="$label" --sample="$sample" \
        || echo "run failed: $label $fixture $harness #$sample" >&2
    done
  done
done
