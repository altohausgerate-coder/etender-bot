const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let state = null;
let currentTab = "feed";

// ---------- köməkçilər ----------

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login" && path !== "/api/password") {
    showLogin();
    throw new Error("auth");
  }
  if (!res.ok) throw new Error(data.error || `Xəta ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Serverdəki fold() ilə eyni, amma uzunluğu saxlayır ki, vurğulama mövqeləri düz gəlsin
const FOLD = { ə: "e", ı: "i", ö: "o", ü: "u", ş: "s", ç: "c", ğ: "g" };
const foldChar = (c) => {
  if (c === "İ") return "i";
  if (c === "I") return "ı";
  const l = c.toLowerCase();
  return FOLD[l] ?? (l.length === 1 ? l : c);
};
const fold = (s) => Array.from(s, foldChar).join("");

function highlight(text, terms) {
  const t = Array.from(text);
  const f = fold(text);
  const marks = new Array(t.length).fill(false);
  for (const term of terms) {
    const q = fold(term.trim().replace(/\s+/g, " "));
    if (q.length < 2) continue;
    let i = f.indexOf(q);
    while (i !== -1) {
      for (let k = i; k < i + q.length; k++) marks[k] = true;
      i = f.indexOf(q, i + q.length);
    }
  }
  let out = "", open = false;
  t.forEach((c, i) => {
    if (marks[i] && !open) { out += "<mark>"; open = true; }
    if (!marks[i] && open) { out += "</mark>"; open = false; }
    out += esc(c);
  });
  return open ? out + "</mark>" : out;
}

const fmtDate = (iso) => {
  const [d, t] = iso.split("T");
  const [y, m, day] = d.split("-");
  return `${day}.${m}.${y}${t ? " " + t.slice(0, 5) : ""}`;
};

// etender tarixləri Bakı vaxtındadır (UTC+4)
const bakuMs = (iso) => Date.parse(iso + "+04:00");

function deadline(iso) {
  const days = (bakuMs(iso) - Date.now()) / 86400e3;
  let cls = "", rel = "";
  if (days < 0) { cls = "over"; rel = "bitib"; }
  else if (days < 1) { cls = "urgent"; rel = `${Math.max(1, Math.round(days * 24))} saat qalıb`; }
  else if (days < 3) { cls = "soon"; rel = `${Math.floor(days)} gün qalıb`; }
  else rel = `${Math.floor(days)} gün qalıb`;
  return `<span class="deadline ${cls}">⏳ ${fmtDate(iso)} · ${rel}</span>`;
}

const ago = (iso) => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return "indicə";
  if (min < 60) return `${min} dəq əvvəl`;
  if (min < 1440) return `${Math.round(min / 60)} saat əvvəl`;
  return `${Math.round(min / 1440)} gün əvvəl`;
};

const TYPES = { 2: "Açıq tender", 3: "İki mərhələli tender", 4: "Kotirovka sorğusu", 5: "Təklif sorğusu", 6: "Açıq tender", 7: "Açıq tender", 9: "RT", 10: "TST", 13: "Tək mənbə" };

function tenderCard(ev, { hits = [], terms = [], unread = false } = {}) {
  const url = `https://etender.gov.az/main/competition/detail/${ev.eventId}`;
  return `<article class="card tender${unread ? " unread" : ""}">
    <div class="chips">
      ${hits.map((h) => `<span class="chip">${esc(h)}</span>`).join("")}
      <span class="chip type">${TYPES[ev.eventType] ?? "Növ " + ev.eventType}</span>
    </div>
    <h3>${highlight(ev.eventName, terms)}</h3>
    <div class="buyer">🏛 ${highlight(ev.buyerOrganizationName, terms)}</div>
    <div class="meta">
      <span>📅 ${fmtDate(ev.publishDate)}</span>
      ${deadline(ev.endDate)}
      <a href="${url}" target="_blank" rel="noopener">etender-də aç ↗</a>
    </div>
  </article>`;
}

const empty = (title, text) => `<div class="empty"><b>${title}</b>${text}</div>`;

// ---------- giriş ----------

async function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  const { hasPassword } = await fetch("/api/auth").then((r) => r.json());
  $("#loginHint").textContent = hasPassword ? "Daxil olmaq üçün parolu yazın." : "İlk giriş: sayt üçün parol təyin edin (ən azı 8 simvol).";
  $("#loginBtn").textContent = hasPassword ? "Daxil ol" : "Parolu təyin et";
  $("#password").autocomplete = hasPassword ? "current-password" : "new-password";
  $("#password").focus();
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginError").textContent = "";
  $("#loginBtn").disabled = true;
  try {
    await api("/api/login", { password: $("#password").value });
    $("#password").value = "";
    $("#login").hidden = true;
    await start();
  } catch (err) {
    $("#loginError").textContent = err.message;
  } finally {
    $("#loginBtn").disabled = false;
  }
});

// ---------- vəziyyət ----------

async function loadState() {
  state = await api("/api/state");
  const lc = state.lastCheck;
  const stale = !lc || Date.now() - Date.parse(lc.at) > 60 * 60000;
  const st = $("#status");
  st.className = "status" + (stale ? " stale" : "");
  st.innerHTML = lc
    ? `<span class="dot"></span><span>Yoxlandı ${ago(lc.at)}<span class="long"> · ${lc.total} aktiv tender</span></span>`
    : `<span class="dot"></span><span>Hələ yoxlanmayıb</span>`;

  const u = $("#unread");
  u.hidden = !state.unread;
  u.textContent = state.unread > 99 ? "99+" : state.unread;

  const ff = $("#feedFilter");
  const sel = ff.value;
  ff.innerHTML = `<option value="">Bütün sözlər</option>` + state.keywords.map((k) => `<option>${esc(k.word)}</option>`).join("");
  ff.value = state.keywords.some((k) => k.word === sel) ? sel : "";
}

// ---------- tablar ----------

function showTab(tab) {
  currentTab = tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab));
  history.replaceState(null, "", tab === "feed" ? "/" : `#${tab}`);
  window.scrollTo(0, 0);
  ({ feed: renderFeed, all: () => runSearch(false), keywords: renderKeywords, settings: renderSettings })[tab]();
}

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});

// ---------- Bildirişlər ----------

let feedItems = [];

async function renderFeed() {
  updatePushBanner();
  const { items } = await api("/api/matches");
  feedItems = items;
  drawFeed();
  if (state?.unread) {
    await api("/api/matches/read", {});
    state.unread = 0;
    $("#unread").hidden = true;
  }
}

function drawFeed() {
  const kw = $("#feedFilter").value;
  const list = kw ? feedItems.filter((m) => m.hits.includes(kw)) : feedItems;
  if (!state.keywords.length) {
    $("#feedList").innerHTML = empty("Hələ açar söz yoxdur", `<a href="#keywords" data-goto="keywords">Açar sözlər</a> bölməsində izləmək istədiyiniz sözləri əlavə edin.`);
    return;
  }
  if (!list.length) {
    $("#feedList").innerHTML = empty("Hələ yeni tender yoxdur", "Açar sözlərinizə uyğun yeni tender çıxan kimi burada görünəcək. İndi açıq olanlara “Tenderlər” bölməsində baxa bilərsiniz.");
    return;
  }
  $("#feedList").innerHTML = list.map((m) => tenderCard(m.ev, { hits: m.hits, terms: m.hits, unread: m.unread })).join("");
}

$("#feedFilter").addEventListener("change", drawFeed);

document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) {
    e.preventDefault();
    if (g.dataset.q !== undefined) {
      $("#q").value = g.dataset.q;
      $("#mine").checked = false;
      $("#type").value = "";
    }
    showTab(g.dataset.goto);
  }
  if (e.target.closest("[data-action=enable-push]")) enablePush();
});

// ---------- Bütün tenderlər ----------

let offset = 0;
let searchSeq = 0;

async function runSearch(append) {
  if (!append) offset = 0;
  const seq = ++searchSeq;
  const q = $("#q").value.trim();
  const params = new URLSearchParams({ q, type: $("#type").value, sort: $("#sort").value, mine: $("#mine").checked ? "1" : "0", expired: $("#expired").checked ? "1" : "0", offset });
  const data = await api(`/api/search?${params}`);
  if (seq !== searchSeq) return; // köhnə cavab
  const terms = q ? [q] : [];
  const html = data.items.map((ev) => tenderCard(ev, { hits: ev.hits, terms: [...terms, ...ev.hits] })).join("");
  $("#allList").innerHTML = append ? $("#allList").innerHTML + html : html || empty("Heç nə tapılmadı", "Başqa söz yoxlayın və ya filtrləri dəyişin.");
  offset += data.items.length;
  $("#allCount").textContent = `${data.total} tender${data.total > offset ? ` · ${offset}-i göstərilir` : ""}`;
  $("#more").hidden = offset >= data.total;
}

let searchTimer;
$("#q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(false), 250);
});
["#type", "#sort", "#mine", "#expired"].forEach((s) => $(s).addEventListener("change", () => runSearch(false)));
$("#more").addEventListener("click", () => runSearch(true));

// ---------- Açar sözlər ----------

function renderKeywords() {
  const list = state.keywords;
  $("#kwList").innerHTML = list.length
    ? list.map((k) => `<div class="kw">
        <b>${esc(k.word)}</b>
        <span class="count">hazırda <button data-goto="all" data-q="${esc(k.word)}">${k.count} açıq</button></span>
        <button class="icon-btn" data-remove="${esc(k.word)}" aria-label="Sil">✕</button>
      </div>`).join("")
    : empty("Siyahı boşdur", "Yuxarıda söz yazıb “Əlavə et” basın. Bir neçəsini vergüllə ayıra bilərsiniz.");
}

$("#kwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("#kwInput").value.trim();
  if (v.length < 2) return;
  await api("/api/keywords", { add: v });
  $("#kwInput").value = "";
  await loadState();
  renderKeywords();
  toast("Əlavə edildi — yeni çıxanlar barədə xəbər verəcəyəm");
});

$("#kwList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-remove]");
  if (!b) return;
  if (!confirm(`“${b.dataset.remove}” silinsin?`)) return;
  await api("/api/keywords", { remove: b.dataset.remove });
  await loadState();
  renderKeywords();
});

// ---------- Push bildirişləri ----------

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function swReg() {
  return navigator.serviceWorker.register("/sw.js");
}

async function currentSub() {
  if (!pushSupported) return null;
  const reg = await swReg();
  return reg.pushManager.getSubscription();
}

function b64ToBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function enablePush() {
  if (!pushSupported) {
    toast(isIOS && !isStandalone ? "iPhone-da əvvəlcə saytı “Ana ekrana əlavə et” edin" : "Bu brauzer bildirişləri dəstəkləmir");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    toast("İcazə verilmədi. Brauzer ayarlarından bildirişlərə icazə verin.");
    return;
  }
  const reg = await swReg();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64ToBytes(state.vapidPublic),
  }));
  await api("/api/push/subscribe", { subscription: sub.toJSON() });
  await loadState();
  toast("Bildirişlər açıldı ✅");
  updatePushBanner();
  if (currentTab === "settings") renderSettings();
}

async function disablePush() {
  const sub = await currentSub();
  if (sub) {
    await api("/api/push/unsubscribe", { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  await loadState();
  toast("Bu cihazda bildirişlər bağlandı");
  renderSettings();
}

async function updatePushBanner() {
  const sub = await currentSub().catch(() => null);
  $("#pushBanner").hidden = !!sub || (pushSupported && Notification.permission === "denied");
}

// ---------- Ayarlar ----------

async function renderSettings() {
  const sub = await currentSub().catch(() => null);
  const info = $("#pushInfo");
  const actions = $("#pushActions");
  if (!pushSupported) {
    info.textContent = isIOS && !isStandalone
      ? "iPhone/iPad-da: Safari-də Paylaş ⎋ → “Ana ekrana əlavə et”, sonra saytı ana ekrandan açıb buradan bildirişləri aktivləşdirin."
      : "Bu brauzer push bildirişlərini dəstəkləmir. Chrome, Edge, Firefox və ya Safari istifadə edin.";
    actions.innerHTML = "";
  } else if (Notification.permission === "denied") {
    info.textContent = "Bildirişlər brauzerdə bloklanıb. Ünvan çubuğundakı kilid işarəsindən icazə verin.";
    actions.innerHTML = "";
  } else if (sub) {
    info.textContent = `Açıqdır. Ümumi qoşulmuş cihaz: ${state.pushDevices}.`;
    actions.innerHTML = `<button class="btn" id="pushTest">Sınaq göndər</button><button class="btn ghost" id="pushOff">Bağla</button>`;
    $("#pushTest").onclick = async () => { await api("/api/push/test", {}); toast("Göndərildi — bir neçə saniyəyə gəlməlidir"); };
    $("#pushOff").onclick = disablePush;
  } else {
    info.textContent = `Bu cihazda bağlıdır. Hər cihazda (telefon, kompüter) ayrıca açın. Qoşulmuş cihaz: ${state.pushDevices}.`;
    actions.innerHTML = `<button class="btn primary" data-action="enable-push">Aç</button>`;
  }

  $("#tgToggle").checked = state.settings.telegram;
  $("#tgToggle").disabled = !state.telegramLinked;
  $("#tgInfo").textContent = state.telegramLinked
    ? "Açıq olsa, bildirişlər @Juju128bot vasitəsilə Telegram-a da gələcək."
    : "Telegram-da @Juju128bot-a /start yazsanız, bu seçim aktiv olacaq.";

  const lc = state.lastCheck;
  $("#checkInfo").textContent = lc
    ? `Son yoxlama: ${ago(lc.at)} (${new Date(lc.at).toLocaleString("az")}). Aktiv tender: ${lc.total}. Hər 10 dəqiqədən bir yoxlanılır — kompüter açıq olmalıdır.`
    : "Hələ yoxlama olmayıb.";
}

$("#tgToggle").addEventListener("change", async (e) => {
  state.settings = await api("/api/settings", { telegram: e.target.checked });
  toast(e.target.checked ? "Telegram bildirişləri açıldı" : "Telegram bildirişləri bağlandı");
});

$("#pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/password", { current: $("#pwCurrent").value, next: $("#pwNext").value });
    $("#pwMsg").textContent = "Parol dəyişdirildi. Digər cihazlarda yenidən daxil olmaq lazım olacaq.";
    e.target.reset();
  } catch (err) {
    $("#pwMsg").textContent = err.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", {});
  showLogin();
});

// ---------- başlanğıc ----------

async function start() {
  await loadState();
  $("#app").hidden = false;
  const hash = location.hash.slice(1);
  showTab(["all", "keywords", "settings"].includes(hash) ? hash : "feed");
}

// Sayt açıq qalanda yenilənsin
setInterval(async () => {
  if (document.hidden || $("#app").hidden) return;
  const before = state?.lastCheck?.at;
  await loadState().catch(() => {});
  if (state?.lastCheck?.at !== before && currentTab === "feed") renderFeed();
}, 60000);

if (pushSupported) swReg().catch(() => {});

fetch("/api/auth")
  .then((r) => r.json())
  .then((a) => (a.authed ? start() : showLogin()));
