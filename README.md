# etender-bot

etender.gov.az-da açar sözə uyğun yeni tender çıxan kimi Telegram-a bildiriş göndərir.

- `scripts/poll.mjs` — bütün aktiv tenderləri çəkib Worker-ə göndərir. etender.gov.az yalnız Azərbaycan
  IP-lərini buraxır (Cloudflare, GitHub bloklanır), ona görə yerli kompüterdə işləyir:
  Windows Task Scheduler "etender-bot" hər 10 dəq `conhost --headless wsl.exe ... poll.sh` işə salır.
- `src/` — Cloudflare Worker: Telegram botu, yeni tenderləri müqayisə edib bildiriş göndərir, KV-də saxlayır.
  Saatda bir watchdog: 60 dəq məlumat gəlməsə Telegram-a xəbərdarlıq.

Bot əmrləri: `/elave`, `/sil`, `/siyahi`, `/axtar`.

Secrets: Worker — `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `INGEST_SECRET`; lokal `.env` — `WEBHOOK_SECRET`, `INGEST_SECRET`.
