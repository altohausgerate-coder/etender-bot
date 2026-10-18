import {
  type AuthEnv,
  bumpPwVersion,
  checkPassword,
  clearCookie,
  hasPassword,
  isAuthed,
  recordFail,
  sessionCookie,
  setPassword,
  tooManyAttempts,
} from "./auth";
import { type PushSub, sendPush } from "./push";
import { type EventItem, eventUrl, matches, search, typeName } from "./tender";

interface Env extends AuthEnv {
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  INGEST_SECRET: string;
  VAPID_PUBLIC: string;
  VAPID_PRIVATE_JWK: string;
}

const SEEN_CAP = 30000; // aktiv tender ~6000-dir, bu bir neçə aylıq tarixçədir
const MATCHES_CAP = 500; // saytdakı bildiriş lenti
const STALE_MIN = 60; // bu qədər dəqiqə məlumat gəlməsə xəbərdarlıq

// ---------- KV ----------

const getJson = async <T>(env: Env, key: string, def: T): Promise<T> => (await env.KV.get<T>(key, "json")) ?? def;
const putJson = (env: Env, key: string, val: unknown) => env.KV.put(key, JSON.stringify(val));

const getOwner = (env: Env) => env.KV.get("owner");
const getKeywords = (env: Env) => getJson<string[]>(env, "keywords", []);

interface LastCheck {
  at: string;
  total: number;
  fresh: number;
  notified: number;
}
interface Match {
  ev: EventItem;
  hits: string[];
  at: string;
}
interface Settings {
  telegram: boolean;
}

const getLastCheck = (env: Env) => getJson<LastCheck | null>(env, "lastCheck", null);
const getMatches = (env: Env) => getJson<Match[]>(env, "matches", []);
const getSettings = (env: Env) => getJson<Settings>(env, "settings", { telegram: false });
const getSubs = (env: Env) => getJson<PushSub[]>(env, "pushSubs", []);

// Snapshot ~2MB-dır; eyni isolate-də hər sorğuda yenidən parse etməmək üçün yaddaşda saxlanılır
let snapCache: { at: string; items: EventItem[] } | undefined;
async function getSnapshot(env: Env): Promise<EventItem[]> {
  const last = await getLastCheck(env);
  if (snapCache && last && snapCache.at === last.at) return snapCache.items;
  const items = await getJson<EventItem[]>(env, "snapshot", []);
  if (last) snapCache = { at: last.at, items };
  return items;
}

// ---------- Telegram (istəyə bağlı) ----------

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

const TG_HELP = `<b>eTender botu</b>
Açar sözləri və ayarları saytdan idarə edin: https://etender-bot.mehsul-agent.workers.dev
Saytda "Ayarlar → Telegram" açıqdırsa, bildirişlər bura da gələcək.`;

async function onTelegram(env: Env, msg: any) {
  const chatId = String(msg.chat.id);
  const owner = await getOwner(env);
  if (!owner) {
    await env.KV.put("owner", chatId);
    return send(env, chatId, `✅ Bu çat bağlandı.\n\n${TG_HELP}`);
  }
  if (owner !== chatId) return send(env, chatId, "⛔ Bu bot şəxsidir.");
  return send(env, chatId, TG_HELP);
}

// ---------- Bildiriş ----------

async function pushAll(env: Env, payload: { title: string; body: string; url: string; tag?: string }) {
  const subs = await getSubs(env);
  if (!subs.length) return;
  const alive = await Promise.all(subs.map((s) => sendPush(env, s, payload).catch((e) => (console.error(e), true))));
  if (alive.includes(false)) await putJson(env, "pushSubs", subs.filter((_, i) => alive[i]));
}

async function notify(env: Env, found: Match[]) {
  if (!found.length) return;
  const first = found[0];
  await pushAll(
    env,
    found.length === 1
      ? { title: `Yeni tender · ${first.hits.join(", ")}`, body: first.ev.eventName, url: eventUrl(first.ev.eventId), tag: String(first.ev.eventId) }
      : {
          title: `${found.length} yeni tender`,
          body: found
            .slice(0, 4)
            .map((m) => `• ${m.ev.eventName}`)
            .join("\n"),
          url: "/",
        },
  );

  const owner = await getOwner(env);
  if (owner && (await getSettings(env)).telegram) {
    for (const m of found) await send(env, owner, card(m.ev, m.hits));
  }
}

// ---------- Gələn məlumat (lokal poller-dən) ----------

async function ingest(env: Env, items: EventItem[], total: number): Promise<LastCheck> {
  const seenArr = await getJson<number[]>(env, "seen", []);
  const seen = new Set(seenArr);
  const firstRun = seenArr.length === 0;
  const fresh = items.filter((e) => !seen.has(e.eventId));

  const found: Match[] = [];
  const keywords = await getKeywords(env);
  if (!firstRun && keywords.length) {
    const now = new Date().toISOString();
    for (const ev of [...fresh].sort((a, b) => b.publishDate.localeCompare(a.publishDate))) {
      const hits = matches(ev, keywords);
      if (hits.length) found.push({ ev, hits, at: now });
    }
  }
  if (found.length) await putJson(env, "matches", [...found, ...(await getMatches(env))].slice(0, MATCHES_CAP));
  await notify(env, found);

  if (fresh.length) await putJson(env, "seen", [...fresh.map((e) => e.eventId), ...seenArr].slice(0, SEEN_CAP));
  await putJson(env, "snapshot", items);

  const last: LastCheck = { at: new Date().toISOString(), total, fresh: firstRun ? 0 : fresh.length, notified: found.length };
  await putJson(env, "lastCheck", last);
  if (await env.KV.get("staleWarned")) await env.KV.delete("staleWarned");
  return last;
}

// Saatda bir: məlumat gəlmirsə (kompüter sönülüdür və ya sayt dayanıb) bir dəfə xəbərdarlıq
async function watchdog(env: Env) {
  const last = await getLastCheck(env);
  if (!last || (await env.KV.get("staleWarned"))) return;
  const ageMin = (Date.now() - new Date(last.at).getTime()) / 60000;
  if (ageMin < STALE_MIN) return;
  await env.KV.put("staleWarned", "1");
  const text = `${Math.round(ageMin)} dəqiqədir etender.gov.az yoxlanılmır. Kompüter sönülü ola bilər.`;
  await pushAll(env, { title: "⚠️ Yoxlama dayanıb", body: text, url: "/", tag: "stale" });
  const owner = await getOwner(env);
  if (owner && (await getSettings(env)).telegram) await send(env, owner, `⚠️ ${text}`);
}

// ---------- Sayt API ----------

const json = (data: unknown, init: ResponseInit = {}) => Response.json(data, init);
const bad = (msg: string, status = 400) => json({ error: msg }, { status });

const splitWords = (s: string) =>
  s
    .split(/[,\n;]/)
    .map((w) => w.trim().replace(/\s+/g, " "))
    .filter((w) => w.length >= 2);

// etender tarixləri Bakı vaxtındadır; müraciət müddəti bitməmiş tenderlər
const bakuNowIso = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 19);
const isOpen = (e: EventItem, now = bakuNowIso()) => e.endDate >= now;

const TYPE_GROUPS: Record<string, number[]> = { open: [2, 3, 6, 7], quote: [4], offer: [5], single: [13] };

async function api(req: Request, env: Env, path: string): Promise<Response> {
  const body = async <T>() => (req.method === "POST" ? ((await req.json().catch(() => ({}))) as T) : ({} as T));

  // --- giriş (sessiyasız) ---
  if (path === "/api/auth") return json({ hasPassword: await hasPassword(env), authed: await isAuthed(env, req) });

  if (path === "/api/login" && req.method === "POST") {
    const ip = req.headers.get("cf-connecting-ip") ?? "?";
    if (await tooManyAttempts(env, ip)) return bad("Çox cəhd. 1 saat sonra yenidən yoxlayın.", 429);
    const { password } = await body<{ password?: string }>();
    if (!password) return bad("Parol yazın");
    if (!(await hasPassword(env))) {
      // İlk giriş: parol təyin edilir
      if (password.length < 8) return bad("Parol ən azı 8 simvol olmalıdır");
      await setPassword(env, password);
    } else if (!(await checkPassword(env, password))) {
      await recordFail(env, ip);
      return bad("Parol yanlışdır", 401);
    }
    return json({ ok: true }, { headers: { "set-cookie": await sessionCookie(env) } });
  }

  if (path === "/api/logout" && req.method === "POST") return json({ ok: true }, { headers: { "set-cookie": clearCookie() } });

  if (!(await isAuthed(env, req))) return bad("Giriş tələb olunur", 401);

  // --- sessiyalı ---
  switch (path) {
    case "/api/state": {
      const [keywords, snap, last, list, readAt, settings, owner, subs] = await Promise.all([
        getKeywords(env),
        getSnapshot(env),
        getLastCheck(env),
        getMatches(env),
        env.KV.get("readAt"),
        getSettings(env),
        getOwner(env),
        getSubs(env),
      ]);
      return json({
        keywords: keywords.map((word) => ({ word, count: search(snap, word).filter((e) => isOpen(e)).length })),
        lastCheck: last,
        unread: list.filter((m) => m.at > (readAt ?? "")).length,
        settings,
        telegramLinked: !!owner,
        pushDevices: subs.length,
        vapidPublic: env.VAPID_PUBLIC,
      });
    }

    case "/api/keywords": {
      const { add, remove } = await body<{ add?: string; remove?: string }>();
      let kw = await getKeywords(env);
      if (add) {
        const lower = new Set(kw.map((k) => k.toLowerCase()));
        kw = [...kw, ...splitWords(add).filter((w) => !lower.has(w.toLowerCase()))];
      }
      if (remove) kw = kw.filter((k) => k.toLowerCase() !== remove.toLowerCase());
      await putJson(env, "keywords", kw);
      return json({ ok: true });
    }

    case "/api/matches": {
      const [list, readAt] = await Promise.all([getMatches(env), env.KV.get("readAt")]);
      return json({ items: list.map((m) => ({ ...m, unread: m.at > (readAt ?? "") })) });
    }

    case "/api/matches/read":
      await env.KV.put("readAt", new Date().toISOString());
      return json({ ok: true });

    case "/api/search": {
      const u = new URL(req.url);
      const q = (u.searchParams.get("q") ?? "").trim();
      const type = u.searchParams.get("type") ?? "";
      const sort = u.searchParams.get("sort") ?? "new";
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const [snap, keywords] = await Promise.all([getSnapshot(env), getKeywords(env)]);
      let items = q ? search(snap, q) : snap;
      if (TYPE_GROUPS[type]) items = items.filter((e) => TYPE_GROUPS[type].includes(e.eventType));
      if (u.searchParams.get("mine") === "1") items = items.filter((e) => matches(e, keywords).length);
      // etender müddəti bitmiş tenderləri qiymətləndirmə bitənə qədər "davam edən" saxlayır
      if (u.searchParams.get("expired") !== "1") {
        const now = bakuNowIso();
        items = items.filter((e) => isOpen(e, now));
      }
      if (sort === "deadline") items = [...items].sort((a, b) => a.endDate.localeCompare(b.endDate));
      else items = [...items].sort((a, b) => b.publishDate.localeCompare(a.publishDate));
      return json({
        total: items.length,
        items: items.slice(offset, offset + 50).map((ev) => ({ ...ev, hits: matches(ev, keywords) })),
      });
    }

    case "/api/settings": {
      const patch = await body<Partial<Settings>>();
      const s = { ...(await getSettings(env)), ...(typeof patch.telegram === "boolean" ? { telegram: patch.telegram } : {}) };
      await putJson(env, "settings", s);
      return json(s);
    }

    case "/api/password": {
      const { current, next } = await body<{ current?: string; next?: string }>();
      if (!current || !(await checkPassword(env, current))) return bad("Hazırkı parol yanlışdır", 401);
      if (!next || next.length < 8) return bad("Yeni parol ən azı 8 simvol olmalıdır");
      await setPassword(env, next);
      await bumpPwVersion(env); // digər cihazlardakı sessiyalar bağlanır
      return json({ ok: true }, { headers: { "set-cookie": await sessionCookie(env) } });
    }

    case "/api/push/subscribe": {
      const { subscription } = await body<{ subscription?: PushSub }>();
      if (!subscription?.endpoint || !subscription.keys?.p256dh) return bad("Abunəlik yanlışdır");
      const subs = (await getSubs(env)).filter((s) => s.endpoint !== subscription.endpoint);
      await putJson(env, "pushSubs", [...subs, { endpoint: subscription.endpoint, keys: subscription.keys }]);
      return json({ ok: true, devices: subs.length + 1 });
    }

    case "/api/push/unsubscribe": {
      const { endpoint } = await body<{ endpoint?: string }>();
      await putJson(env, "pushSubs", (await getSubs(env)).filter((s) => s.endpoint !== endpoint));
      return json({ ok: true });
    }

    case "/api/push/test":
      await pushAll(env, { title: "eTender izləyici", body: "Bildirişlər işləyir ✅", url: "/", tag: "test" });
      return json({ ok: true });
  }
  return bad("Tapılmadı", 404);
}

// ---------- Worker ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await api(req, env, url.pathname);
      } catch (e) {
        console.error(e);
        return bad(String(e), 500);
      }
    }

    if (url.pathname === "/ingest" && req.method === "POST") {
      if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) return new Response("forbidden", { status: 403 });
      const { items, total } = (await req.json()) as { items: EventItem[]; total: number };
      if (!Array.isArray(items) || !items.length) return new Response("empty", { status: 400 });
      return json(await ingest(env, items, total));
    }

    if (url.pathname === "/webhook" && req.method === "POST") {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const update: any = await req.json();
      const msg = update.message ?? update.edited_message;
      if (msg?.text) await onTelegram(env, msg).catch((e) => console.error(e));
      return new Response("ok");
    }

    if (url.pathname === "/setup") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const hook = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "edited_message"],
      });
      await tg(env, "deleteMyCommands", {});
      return json(hook);
    }

    return env.ASSETS.fetch(req);
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(watchdog(env));
  },
};
