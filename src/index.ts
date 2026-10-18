import { type EventItem, eventUrl, matches, search, typeName } from "./tender";

interface Env {
  KV: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  INGEST_SECRET: string;
}

const SEEN_CAP = 30000; // aktiv tender ~6000-dir, bu bir neçə aylıq tarixçədir
const STALE_MIN = 60; // bu qədər dəqiqə məlumat gəlməsə sahibə xəbərdarlıq

// ---------- KV ----------

const getJson = async <T>(env: Env, key: string, def: T): Promise<T> => (await env.KV.get<T>(key, "json")) ?? def;
const putJson = (env: Env, key: string, val: unknown) => env.KV.put(key, JSON.stringify(val));

const getOwner = (env: Env) => env.KV.get("owner");
const getKeywords = (env: Env) => getJson<string[]>(env, "keywords", []);
const getSnapshot = (env: Env) => getJson<EventItem[]>(env, "snapshot", []);

interface LastCheck {
  at: string;
  total: number;
  fresh: number;
  notified: number;
}

// ---------- Telegram ----------

async function tg(env: Env, method: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  if (!data.ok) console.error("telegram", method, data);
  return data;
}

const send = (env: Env, chatId: string | number, text: string) =>
  tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const fmtDate = (iso: string) => {
  const [d, t] = iso.split("T");
  const [y, m, day] = d.split("-");
  return `${day}.${m}.${y} ${t?.slice(0, 5) ?? ""}`;
};

// etender tarixləri artıq Bakı vaxtındadır; bizim ISO vaxtlarımız UTC-dir
const bakuNow = (iso: string) => fmtDate(new Date(new Date(iso).getTime() + 4 * 3600e3).toISOString());

function card(ev: EventItem, hits?: string[]): string {
  return [
    hits?.length ? `🔔 <b>Yeni tender</b> — ${hits.map((h) => `#${esc(h.replace(/\s+/g, "_"))}`).join(" ")}` : "",
    `<b>${esc(ev.eventName)}</b>`,
    `🏛 ${esc(ev.buyerOrganizationName)}`,
    `📋 ${typeName(ev.eventType)}`,
    `📅 Dərc: ${fmtDate(ev.publishDate)}  ⏳ Son: <b>${fmtDate(ev.endDate)}</b>`,
    `🔗 <a href="${eventUrl(ev.eventId)}">etender.gov.az/${ev.eventId}</a>`,
  ]
    .filter(Boolean)
    .join("\n");
}

const HELP = `<b>eTender botu</b>
etender.gov.az-da yeni tender çıxan kimi, açar sözünüzə uyğundursa, sizə yazacağam (hər ~10 dəq yoxlanılır).

/elave <i>söz</i> — açar söz əlavə et (vergüllə bir neçəsi: <code>/elave mebel, kompüter</code>)
/sil <i>söz</i> — açar sözü sil
/siyahi — açar sözlərim və son yoxlama
/axtar <i>söz</i> — hazırda aktiv olan tenderlərdə axtar

Söz həm tenderin adında, həm də satınalan təşkilatın adında axtarılır. "ə, ş, ç…" yazmasanız da tapır.`;

// ---------- Gələn məlumat (GitHub Actions-dan) ----------

async function ingest(env: Env, items: EventItem[], total: number): Promise<LastCheck> {
  const seenArr = await getJson<number[]>(env, "seen", []);
  const seen = new Set(seenArr);
  const firstRun = seenArr.length === 0;
  const fresh = items.filter((e) => !seen.has(e.eventId));

  let notified = 0;
  const owner = await getOwner(env);
  const keywords = await getKeywords(env);
  if (!firstRun && owner && keywords.length) {
    // köhnədən yeniyə doğru göndər ki, çatda xronoloji olsun
    const ordered = [...fresh].sort((a, b) => a.publishDate.localeCompare(b.publishDate));
    for (const ev of ordered) {
      const hits = matches(ev, keywords);
      if (!hits.length) continue;
      await send(env, owner, card(ev, hits));
      notified++;
    }
  }

  if (fresh.length) await putJson(env, "seen", [...fresh.map((e) => e.eventId), ...seenArr].slice(0, SEEN_CAP));
  await putJson(env, "snapshot", items);

  const last: LastCheck = { at: new Date().toISOString(), total, fresh: firstRun ? 0 : fresh.length, notified };
  await putJson(env, "lastCheck", last);
  if (owner && (await env.KV.get("staleWarned"))) {
    await env.KV.delete("staleWarned");
    await send(env, owner, "✅ Tender yoxlaması yenidən işləyir.");
  }
  return last;
}

// Saatda bir: məlumat gəlmirsə (GitHub Actions dayanıbsa) sahibə bir dəfə yaz
async function watchdog(env: Env) {
  const owner = await getOwner(env);
  const last = await getJson<LastCheck | null>(env, "lastCheck", null);
  if (!owner || !last || (await env.KV.get("staleWarned"))) return;
  const ageMin = (Date.now() - new Date(last.at).getTime()) / 60000;
  if (ageMin < STALE_MIN) return;
  await env.KV.put("staleWarned", "1");
  await send(
    env,
    owner,
    `⚠️ ${Math.round(ageMin)} dəqiqədir etender.gov.az-dan məlumat gəlmir (son: ${bakuNow(last.at)}). ` +
      `GitHub Actions və ya sayt dayanmış ola bilər.`,
  );
}

// ---------- Əmrlər ----------

const splitWords = (s: string) =>
  s
    .split(/[,\n;]/)
    .map((w) => w.trim().replace(/\s+/g, " "))
    .filter((w) => w.length >= 2);

async function onMessage(env: Env, msg: any) {
  const chatId = String(msg.chat.id);
  const text: string = (msg.text ?? "").trim();
  const owner = await getOwner(env);

  if (!owner) {
    await env.KV.put("owner", chatId);
    await send(env, chatId, `✅ Bu çat bota sahib kimi bağlandı.\n\n${HELP}`);
    return;
  }
  if (owner !== chatId) {
    await send(env, chatId, "⛔ Bu bot şəxsidir.");
    return;
  }

  const m = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  const cmd = m?.[1].toLowerCase() ?? "";
  const arg = m?.[2].trim() ?? text;

  switch (cmd) {
    case "elave":
    case "add": {
      const words = splitWords(arg);
      if (!words.length) return send(env, chatId, "Nümunə: <code>/elave mebel, kompüter avadanlığı</code>");
      const kw = await getKeywords(env);
      const lower = new Set(kw.map((k) => k.toLowerCase()));
      const added = words.filter((w) => !lower.has(w.toLowerCase()));
      await putJson(env, "keywords", [...kw, ...added]);
      const snap = await getSnapshot(env);
      const counts = words.map((w) => `• <b>${esc(w)}</b> — hazırda ${search(snap, w).length} aktiv tender`).join("\n");
      return send(
        env,
        chatId,
        `✅ Yadda saxladım. Bundan sonra yeni çıxanları göndərəcəyəm.\n${counts}\n\nİndikiləri görmək üçün: <code>/axtar ${esc(words[0])}</code>`,
      );
    }

    case "sil":
    case "remove": {
      const words = splitWords(arg).map((w) => w.toLowerCase());
      if (!words.length) return send(env, chatId, "Nümunə: <code>/sil mebel</code>");
      const kw = await getKeywords(env);
      const left = kw.filter((k) => !words.includes(k.toLowerCase()));
      await putJson(env, "keywords", left);
      return send(env, chatId, `🗑 Silindi: ${kw.length - left.length} söz. Qalan: ${left.length}`);
    }

    case "siyahi":
    case "list": {
      const kw = await getKeywords(env);
      const last = await getJson<LastCheck | null>(env, "lastCheck", null);
      return send(
        env,
        chatId,
        (kw.length ? `<b>Açar sözlər (${kw.length}):</b>\n${kw.map((k) => `• ${esc(k)}`).join("\n")}` : "Hələ açar söz yoxdur. /elave ilə əlavə edin.") +
          (last ? `\n\n<i>Son yoxlama: ${bakuNow(last.at)} — ${last.total} aktiv tender</i>` : "\n\n<i>Hələ yoxlama olmayıb.</i>"),
      );
    }

    case "axtar":
    case "search": {
      if (arg.length < 2) return send(env, chatId, "Nümunə: <code>/axtar mebel</code>");
      const found = search(await getSnapshot(env), arg).sort((a, b) => b.publishDate.localeCompare(a.publishDate));
      if (!found.length) return send(env, chatId, `"${esc(arg)}" üzrə aktiv tender tapılmadı.`);
      await send(env, chatId, `🔎 "${esc(arg)}" — aktiv tender: <b>${found.length}</b>${found.length > 10 ? " (ən yeni 10-u)" : ""}`);
      for (const ev of found.slice(0, 10)) await send(env, chatId, card(ev));
      return;
    }

    default:
      return send(env, chatId, HELP);
  }
}

// ---------- Worker ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/webhook" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const update: any = await req.json();
      const msg = update.message ?? update.edited_message;
      if (msg?.text) {
        try {
          await onMessage(env, msg);
        } catch (e) {
          console.error(e);
          await send(env, msg.chat.id, `⚠️ Xəta: ${esc(String(e))}`);
        }
      }
      return new Response("ok");
    }

    if (url.pathname === "/ingest" && req.method === "POST") {
      if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) return new Response("forbidden", { status: 403 });
      const { items, total } = (await req.json()) as { items: EventItem[]; total: number };
      if (!Array.isArray(items) || !items.length) return new Response("empty", { status: 400 });
      return Response.json(await ingest(env, items, total));
    }

    if (url.pathname === "/setup") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const hook = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "edited_message"],
      });
      await tg(env, "setMyCommands", {
        commands: [
          { command: "elave", description: "Açar söz əlavə et" },
          { command: "sil", description: "Açar sözü sil" },
          { command: "siyahi", description: "Açar sözlərim" },
          { command: "axtar", description: "Aktiv tenderlərdə axtar" },
        ],
      });
      return Response.json(hook);
    }

    return new Response("etender-bot");
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(watchdog(env));
  },
};
