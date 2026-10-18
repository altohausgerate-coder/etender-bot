// GitHub Actions-da işləyir: etender.gov.az-dan bütün aktiv tenderləri çəkib Worker-ə göndərir.
// (etender.gov.az Cloudflare IP-lərini bloklayır, ona görə Worker özü çəkə bilmir.)
// Sayt hər sorğuya X-Origin-Token tələb edir: {endpoint,id,keyword} JSON-u
// saytın öz frontend bundle-ındakı AES-128-CBC açarı ilə şifrələnir.
import crypto from "node:crypto";

const KEY = Buffer.from("md8cAexvSSDC6RN64V44kQ==", "base64");
const IV = Buffer.from("sACJX5ONP3sySbMvzkNO6g==", "base64");
const PAGE_SIZE = 1000;

const { WORKER_URL, INGEST_SECRET } = process.env;
if (!WORKER_URL || !INGEST_SECRET) throw new Error("WORKER_URL və INGEST_SECRET lazımdır");

function originToken(endpoint) {
  const c = crypto.createCipheriv("aes-128-cbc", KEY, IV);
  const body = JSON.stringify({ endpoint, id: crypto.randomUUID(), keyword: "esat_public_front" });
  return Buffer.concat([c.update(body), c.final()]).toString("base64");
}

async function getPage(page) {
  const qs = new URLSearchParams({
    EventType: "", PageSize: PAGE_SIZE, PageNumber: page, EventStatus: 1, Keyword: "",
    buyerOrganizationName: "", documentNumber: "", publishDateFrom: "", publishDateTo: "",
    AwardedparticipantName: "", AwardedparticipantVoen: "", DocumentViewType: "", IsArchived: "false",
  });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://etender.gov.az/api/events?${qs}`, {
      headers: {
        "X-Origin-Token": originToken("/api//events"),
        "X-Recaptcha-Token": "",
        "X-XSRF-TOKEN": "",
        Referer: "https://etender.gov.az/",
        "User-Agent": "Mozilla/5.0 (etender-bot)",
      },
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ ok: false, status: String(e) }));
    if (res.ok) return res.json();
    if (attempt >= 3) throw new Error(`etender səhifə ${page}: ${res.status}`);
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
}

const items = [];
let total = 0;
for (let page = 1; ; page++) {
  const p = await getPage(page);
  total = p.totalItems;
  for (const e of p.items)
    items.push({
      eventId: e.eventId, eventType: e.eventType, eventName: e.eventName,
      buyerOrganizationName: e.buyerOrganizationName, publishDate: e.publishDate, endDate: e.endDate,
    });
  if (!p.hasNextPage) break;
}
console.log(`çəkildi: ${items.length}/${total}`);

const res = await fetch(`${WORKER_URL}/ingest`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-ingest-secret": INGEST_SECRET },
  body: JSON.stringify({ items, total }),
});
const out = await res.text();
console.log(`worker: ${res.status} ${out}`);
if (!res.ok) process.exit(1);
