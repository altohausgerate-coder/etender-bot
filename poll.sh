#!/usr/bin/env bash
# Windows Task Scheduler hər 10 dəq bunu işə salır (etender.gov.az yalnız AZ IP-ləri buraxır)
export PATH="$HOME/.local/node/bin:$PATH"
cd "$(dirname "$0")" || exit 1
set -a; source .env; set +a
export WORKER_URL=https://etender-bot.mehsul-agent.workers.dev
{ date -Is; timeout 240 node scripts/poll.mjs 2>&1 | tail -3; } >> poll.log
# log faylı böyüməsin
tail -n 500 poll.log > poll.log.tmp && mv poll.log.tmp poll.log
