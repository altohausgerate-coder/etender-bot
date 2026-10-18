#!/usr/bin/env bash
# Telegram bot tokenini Cloudflare-ə yükləyir və webhook-u qoşur (token ekranda görünmür)
export PATH="$HOME/.local/node/bin:$PATH"
cd ~/etender-bot || exit 1
source .env
echo "@BotFather-dən aldığınız tokeni yapışdırın və Enter basın:"
npx wrangler secret put TELEGRAM_BOT_TOKEN || exit 1
sleep 5
echo
curl -s "https://etender-bot.mehsul-agent.workers.dev/setup?secret=$WEBHOOK_SECRET"
echo
echo
echo 'Yuxarıda "ok":true görünürsə — hazırdır. İndi botunuza Telegram-da /start yazın.'
