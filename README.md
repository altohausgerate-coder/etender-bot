# etender-bot

etender.gov.az-da açar sözə uyğun yeni tender çıxan kimi Telegram-a bildiriş göndərir.

- `scripts/poll.mjs` — GitHub Actions-da hər 10 dəqiqə bütün aktiv tenderləri çəkir və Worker-ə göndərir
  (etender.gov.az Cloudflare IP-lərini bloklayır).
- `src/` — Cloudflare Worker: Telegram botu, yeni tenderləri müqayisə edib bildiriş göndərir, KV-də saxlayır.

Bot əmrləri: `/elave`, `/sil`, `/siyahi`, `/axtar`.

Secrets: Worker — `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `INGEST_SECRET`; GitHub — `WORKER_URL`, `INGEST_SECRET`.
