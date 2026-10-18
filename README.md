# etender-bot

etender.gov.az-da açar sözə uyğun yeni tender çıxan kimi xəbər verir. Hər şey saytdan idarə olunur:
https://etender-bot.mehsul-agent.workers.dev (bildiriş lenti, bütün tenderlərdə axtarış, açar sözlər, ayarlar).
Bildirişlər: brauzer/telefon push (PWA), istəyə görə Telegram (@Juju128bot).

- `scripts/poll.mjs` — bütün aktiv tenderləri çəkib Worker-ə göndərir. etender.gov.az yalnız Azərbaycan
  IP-lərini buraxır (Cloudflare, GitHub bloklanır), ona görə yerli kompüterdə işləyir:
  Windows Task Scheduler "etender-bot" hər 10 dəq `conhost --headless wsl.exe ... poll.sh` işə salır.
- `src/` — Cloudflare Worker: sayt API-si (parol + sessiya cookie), Web Push (`push.ts`), yeni tenderləri müqayisə edir, KV-də saxlayır.
- `public/` — sayt (vanilla JS, PWA, service worker).
  Saatda bir watchdog: 60 dəq məlumat gəlməsə Telegram-a xəbərdarlıq.

İlk girişdə sayt parol təyin etməyi istəyir.

Secrets: Worker — `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `INGEST_SECRET`, `SESSION_SECRET`, `VAPID_PUBLIC`, `VAPID_PRIVATE_JWK`; lokal `.env` — `WEBHOOK_SECRET`, `INGEST_SECRET`.
