// LINN Price List Bot — Cloudflare Worker + Telegram
// ════════════════════════════════════════════════════════════════════════════════════════════
//  WORKFLOWS AT A GLANCE
// ════════════════════════════════════════════════════════════════════════════════════════════
//  WHO            WHERE            WHAT THEY DO
//  Member         Group            type a price word (list, price, game, rate, ဈေး, ဘယ်လောက် …) or tap "📋 Price List"
//                                  -> Game -> (Server) -> bordered price tables.  Read only.
//  Admin          Group / private  BUY:   type  ID + amount  (123456789 2001 86)  -> bot replies with the order -> ✅ Confirm
//                                         or   🛒 ဝယ်ယူရန် -> Game -> (Server) -> Package -> ID -> ✅ Confirm
//                                  QUOTE: in a group type an amount / package / tab (86 | wp 2 | 86 172 wp | diamond) -> price card
//                                  📊 ယနေ့ အရောင်း = today's own orders.   ℹ️ အကူအညီ = step by step guide.
//  Owner          private          everything an Admin does, plus
//                                  👥 Group စီမံရန်  pick a group -> tick up to MAX_GAMES games -> ✅ ပြီးပြီ
//                                  📋 သတ်မှတ်ထားတာများ  table of what each group may see
//                                  🎨 Card ပြင်ရန်  edit the order / quote / price-table cards      🔄 Game list refresh  reload the store
//  Owner keyboard : 🛒 ဝယ်ယူရန် | 👥 Group စီမံရန် · 📋 သတ်မှတ်ထားတာများ | 🎨 Card ပြင်ရန် · 🔄 Game list refresh | 📊 ယနေ့ အရောင်း · ℹ️ အကူအညီ
//  Admin keyboard : 🛒 ဝယ်ယူရန် · 📊 ယနေ့ အရောင်း | ℹ️ အကူအညီ        Group keyboard : 📋 Price List
//
//  ORDER STEPS (shown in the bot as  Game › Package › ID › Confirm):
//    pick game/package  ->  send Player ID (+ Server / Character if the game needs it)  ->  bot checks the ID  ->  ✅ Confirm
//    -> bought from the game's provider (G2Bulk / FazerCards)  -> card shows ⏳ Processing -> ✅ Completed / ❌ Failed / ❓ Unknown
//    Unknown / Processing that never ends = do NOT buy again; check the provider first.
//  In a group the bot asks for the ID by a card: the admin must REPLY to that card.
//
//  GUIDE: ℹ️ အကူအညီ (or /start) opens a topic menu (buttons) — each topic is a short step-by-step page.  Edit the texts in GUIDE below.
//
// ════════════════════════════════════════════════════════════════════════════════════════════
//  SETUP CHECKLIST (once)
// ════════════════════════════════════════════════════════════════════════════════════════════
//  1. Secrets   : BOT_TOKEN, WEBHOOK_SECRET, G2BULK_KEY (same key as the store worker), FAZERCARD_KEY (only if FazerCards games are bought here)
//  2. KV binding: STATE (required)
//  3. Variables : OWNER_IDS  (comma separated user IDs — send /id to the bot to get yours)
//                 ADMIN_IDS  (optional, extra admins: may buy, quote and see their own sales; cannot manage groups or cards)
//     Optional  : LOG_CHAT_ID (private group / channel: every finished order is logged there without codes; owners are always told about Failed / Unknown)
//                 MENU_TTL_MIN (menu auto-delete, default 5), PRICE_TTL_MIN (price list auto-delete, default 10), FIREBASE_API_KEY (public store key is built in)
//  4. wrangler.toml:  [triggers] crons = ["*/5 * * * *"]   (G2Bulk game orders finish through the /g2hook callback within seconds; the cron is only the safety net + voucher orders.
//     "* * * * *" also works: with no open order it is ONE KV read, cleanup + balance run only every 5th minute)
//  5. Deploy, then open once:  https://YOUR-WORKER.workers.dev/setup?key=WEBHOOK_SECRET
//  6. Add the bot to each group as ADMIN (or switch off Privacy Mode in BotFather) so it can read the word "List".
//     "Delete messages" permission is needed only for the bot's cleanup of OTHER people's messages (its own need nothing).
//  7. Owner: private chat -> 👥 Group စီမံရန် -> choose the games for every group.
//  /list and /admin list still work silently (they are not in the menu).
//
const FS_PROJECT = "linngametopupstore";
const FS_KEY = "AIzaSyC9soIo8J-NP5bc4STi_eOB1oP94IvcOL8"; // public web key, same one the store page uses
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/(default)/documents`;
const FS_FIELDS = [
  "name", "serverName", "order", "createdAt", "fulfillProvider", "g2bulkVoucherCategory", "fazercardGiftCategoryId",
  "packages", "packageTabLabels",
  "fazercardCategoryId", "g2bulkCode", "g2bulkIdCheckCode", "g2bulkServerMode", "g2bulkServerOptions", "fazercardServerMode", "fazercardServerOptions",
  "playerIdRequired", "serverIdRequired", "charNameRequired", "jcplaysProduct", "fazercardFields",
];
const PAGE = 10;            // games per page (2 columns x 5 rows)
const TABLE_CHUNK = 40;     // rows per table message
const STORE_TTL_MS = 5 * 60 * 1000;

let KV = null;
let LAST_SWEEP = 0;
let LAST_HEAVY = 0;
let ORIGIN = "";             // https://YOUR-WORKER... (learned from the incoming request) — used for the G2Bulk callback_url

/* ---------- helpers ---------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const stripPremium = (s) => String(s).replace(/<tg-emoji\b[^>]*>([\s\S]*?)<\/tg-emoji>/g, "$1");   // premium emoji -> the plain emoji inside it
const idList = (s) => String(s || "").split(/[\s,]+/).filter(Boolean);
const isOwner = (env, uid) => idList(env.OWNER_IDS).includes(String(uid));
const isAdmin = (env, uid) => isOwner(env, uid) || idList(env.ADMIN_IDS).includes(String(uid));
const menuMs = (env) => (Number(env.MENU_TTL_MIN) > 0 ? Number(env.MENU_TTL_MIN) : 5) * 60 * 1000;
const priceMs = (env) => (Number(env.PRICE_TTL_MIN) > 0 ? Number(env.PRICE_TTL_MIN) : 10) * 60 * 1000;
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
// SPEED: Telegram shows a spinner on a tapped button until the tap is answered, and accepts only ONE answer per tap.
// fetch() sends a quick silent answer if the handler has not answered within CB_FAST_ACK_MS (default 250); the handler's
// own answer (popup text) still wins when it is quicker. Later answers for the same tap are skipped (Telegram would refuse them).
const ACKED = new Set();
const CB_FAST_ACK_MS = 250;
async function tg(env, method, body) {
  if (method === "answerCallbackQuery" && body?.callback_query_id) {
    if (ACKED.has(body.callback_query_id)) return { ok: true, skipped: true };
    if (ACKED.size > 500) ACKED.clear();
    ACKED.add(body.callback_query_id);
  }
  await spinGuard(method, body);                    // a spinning button steps aside before its message is edited / deleted
  // Telegram answers 429 when many messages go out at once: wait the asked time and try again (max 2 retries).
  // A non-JSON reply (502 / HTML error page) becomes { ok: false } instead of throwing.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({ ok: false, error_code: r.status, description: `Telegram ${r.status}` }));
    if (j && j.ok === false && j.error_code === 400 && typeof body?.text === "string" && body.text.includes("<tg-emoji")) {
      body = { ...body, text: stripPremium(body.text) };   // Telegram refused the premium emoji: send the same card with the plain emoji
      continue;
    }
    if (j && j.ok === false && j.error_code === 429 && attempt < 2 && method !== "answerCallbackQuery") {
      await new Promise((res) => setTimeout(res, Math.min(Number(j.parameters?.retry_after) || 1, 5) * 1000));
      continue;
    }
    return j;
  }
}
/* ---------- Button spinner ----------
   When a tapped button's work takes longer than ~0.4 s, the button itself turns into a rotating spinner
   ("⠋ Confirm" -> "⠙ Confirm" -> ...) so the user can see the tap was received. The pressed button goes inert
   (callback "spin") while it spins; every other button is left alone. The moment the handler edits or deletes
   that message (the normal case: the new screen replaces the old one) the spinner steps aside; if the handler
   finishes WITHOUT touching the message (error, a toast, a new message instead) the original keyboard is restored.
   Works for classic inline keyboards and for rich messages (buttons inside the message body).
   Private chat: animated. Groups: one static ⏳ frame (Telegram limits how fast a group may be edited). */
const _SPIN = new Map();
const _SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const _SPIN_EDIT = /^(editMessageText|editMessageReplyMarkup|editMessageCaption|editMessageMedia|deleteMessage)$/;
async function spinGuard(method, payload) {            // call at the top of the file's low-level Telegram helper
  if (!_SPIN.size || !payload || !_SPIN_EDIT.test(method)) return;
  const s = _SPIN.get(`${payload.chat_id}:${payload.message_id}`);
  if (s) await s.halt(true);
}
function startButtonSpinner(token, cb, opts = {}) {
  const none = { end: async () => {} };
  try {
    const msg = cb && cb.message;
    if (!token || !msg || !msg.chat || !cb.data || cb.data === "spin" || cb.data === "nop") return none;
    const rich = msg.rich_message && Array.isArray(msg.rich_message.blocks) ? msg.rich_message : null;
    const isBtns = (b) => b && b.type === "buttons" && Array.isArray(b.buttons);
    const kb = rich ? null : msg.reply_markup && msg.reply_markup.inline_keyboard;
    if (rich ? !rich.blocks.some(isBtns) : !Array.isArray(kb)) return none;
    if (rich && rich.blocks.some((b) => b && b.type !== "paragraph" && b.type !== "buttons" && b.type !== "table")) return none;   // photo / media cards are left alone (their blocks cannot be safely re-sent)
    const chat_id = msg.chat.id, message_id = msg.message_id, key = `${chat_id}:${message_id}`;
    if (_SPIN.has(key)) return none;
    const animate = opts.animate !== undefined ? opts.animate : msg.chat.type === "private";
    const delay = opts.delay || 400, every = opts.every || 1100, max = opts.max || 25;
    const frameOf = (n) => (animate ? _SPIN_FRAMES[n % _SPIN_FRAMES.length] : "⏳");
    const mapBtn = (n) => (b) => {
      if (n === null || !b || b.callback_data !== cb.data) return b;
      const label = String(b.text || "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
      return { ...b, text: (frameOf(n) + (label ? " " + label : "")).slice(0, 60), callback_data: "spin" };
    };
    const call = (n) => {                                // n = frame number, or null = put the original buttons back
      const f = mapBtn(n);
      const body = rich
        ? { chat_id, message_id, rich_message: { blocks: rich.blocks.map((b) => (isBtns(b) ? { ...b, buttons: b.buttons.map(f) } : b)) } }
        : { chat_id, message_id, reply_markup: { inline_keyboard: kb.map((row) => row.map(f)) } };
      return fetch(`https://api.telegram.org/bot${token}/${rich ? "editMessageText" : "editMessageReplyMarkup"}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }).then((r) => r.json()).catch(() => null);
    };
    let n = 0, stopped = false, shown = false, replaced = false, timer = null, inflight = Promise.resolve();
    const tick = () => {
      if (stopped) return;
      shown = true;
      inflight = call(n++);
      if (animate && n < max) timer = setTimeout(tick, every);
    };
    timer = setTimeout(tick, delay);
    const self = {
      async halt(byEdit) {
        stopped = true; clearTimeout(timer);
        if (_SPIN.get(key) === self) _SPIN.delete(key);
        if (byEdit) replaced = true;
        await inflight;
      },
      async end() {
        await self.halt(false);
        if (shown && !replaced) await call(null);
      },
    };
    _SPIN.set(key, self);
    return self;
  } catch (e) { return none; }
}
const send = (env, chat, text, extra = {}) => tg(env, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", ...extra });
const replyTo = (id) => (id ? { reply_parameters: { message_id: id, allow_sending_without_reply: true } } : {});
let BOT_NAME = "";
async function botName(env) {
  if (!BOT_NAME) BOT_NAME = String((await tg(env, "getMe", {}).catch(() => null))?.result?.username || "").toLowerCase();
  return BOT_NAME;
}

/* ---------- auto-delete queue (KV "del:<time>:<chat>:<message>") ---------- */
async function scheduleDelete(env, chat, mid, ms) {
  if (!KV || !mid) return;
  const at = String(Date.now() + ms).padStart(14, "0");
  await KV.put(`del:${at}:${chat}:${mid}`, "1", { expirationTtl: Math.ceil(ms / 1000) + 86400 }).catch(() => {});
}
async function sweep(env) {
  if (!KV) return;
  const now = Date.now();
  for (let page = 0, cursor; page < 5; page++) {
    const l = await KV.list({ prefix: "del:", cursor, limit: 200 });
    const byChat = new Map(), keys = [];
    let future = false;
    for (const k of l.keys) {                       // keys are sorted by time
      const [, at, chat, id] = k.name.split(":");
      if (Number(at) > now) { future = true; break; }
      if (!byChat.has(chat)) byChat.set(chat, []);
      byChat.get(chat).push(Number(id));
      keys.push(k.name);
    }
    for (const [chat, ids] of byChat)
      for (let i = 0; i < ids.length; i += 100)
        await tg(env, "deleteMessages", { chat_id: chat, message_ids: ids.slice(i, i + 100) }).catch(() => {});
    await Promise.all(keys.map((k) => KV.delete(k).catch(() => {})));
    if (future || l.list_complete) return;
    cursor = l.cursor;
  }
}

/* ---------- Store data (Firestore) ---------- */
function fv(v) {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return Date.parse(v.timestampValue) || 0;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fv);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fv(x)]));
  return undefined;
}
// Same rules as the store: voucher = provider says so, or it carries voucher data. Software has its own tab and is not listed here.
const isVoucher = (g) =>
  ["g2bulk_voucher", "fazercard_giftcard", "jcplays", "voucher_manual"].includes(g.fulfillProvider) ||
  !!(g.g2bulkVoucherCategory || g.fazercardGiftCategoryId) ||
  (Array.isArray(g.packages) && g.packages.some((p) => p && (p.voucherId || p.fazercardGiftCardId)));
const providerFamily = (g) => {
  const fp = g.fulfillProvider;
  if (fp === "g2bulk" || fp === "g2bulk_voucher") return "g2bulk";
  if (fp === "fazercard" || fp === "fazercard_giftcard") return "fazercard";
  if (fp === "jcplays") return "jcplays";
  return null;
};

let STORE = { t: 0, groups: null, byId: new Map() };
async function loadStore(env, force = false) {
  if (!force && STORE.groups && Date.now() - STORE.t < STORE_TTL_MS) return STORE;
  const key = env.FIREBASE_API_KEY || FS_KEY;
  const docs = [];
  let token = "";
  for (let i = 0; i < 10; i++) {
    const qs = new URLSearchParams({ pageSize: "300", key });
    FS_FIELDS.forEach((f) => qs.append("mask.fieldPaths", f));
    if (token) qs.set("pageToken", token);
    let j;
    try {
      const r = await fetch(`${FS_BASE}/games?${qs}`);
      if (!r.ok) break;
      j = await r.json();
    } catch { break; }
    (j.documents || []).forEach((d) => {
      const g = fv({ mapValue: { fields: d.fields || {} } });
      g._id = String(d.name || "").split("/").pop();
      docs.push(g);
    });
    token = j.nextPageToken || "";
    if (!token) break;
  }
  if (!docs.length) return STORE;                    // keep the old data when the fetch failed

  let flags = {};                                    // games of a provider that is switched off in admin are hidden in the store too
  try {
    const r = await fetch(`${FS_BASE}/settings/providerFlags?key=${key}`);
    if (r.ok) flags = fv({ mapValue: { fields: (await r.json()).fields || {} } }) || {};
  } catch {}

  const map = new Map();
  for (const g of docs) {
    if (!g.name || g.fulfillProvider === "software") continue;
    const fam = providerFamily(g);
    if (fam && flags[fam] === false) continue;
    const k = g.name.trim().toLowerCase();
    if (!map.has(k)) map.set(k, { key: k, id: hash(k), name: g.name.trim(), kind: "t", entries: [], order: Infinity, created: 0 });
    const grp = map.get(k);
    if (isVoucher(g)) grp.kind = "v";
    if (typeof g.order === "number") grp.order = Math.min(grp.order, g.order);
    grp.created = Math.max(grp.created, typeof g.createdAt === "number" ? g.createdAt : 0);
    grp.entries.push({
      id: g._id, server: String(g.serverName || "").trim(), order: typeof g.order === "number" ? g.order : Infinity,
      labels: g.packageTabLabels && typeof g.packageTabLabels === "object" ? g.packageTabLabels : {},
      packages: (Array.isArray(g.packages) ? g.packages : []).filter((p) => p && typeof p === "object"),
      f: {                                          // what the admin order flow needs to know about this game / server
        g2code: String(g.g2bulkCode || ""), idCheck: String(g.g2bulkIdCheckCode || g.g2bulkCode || ""),
        playerIdRequired: g.playerIdRequired, serverIdRequired: g.serverIdRequired, charNameRequired: g.charNameRequired === true,
        voucher: isVoucher(g), jcplaysProduct: String(g.jcplaysProduct || ""), fzCat: String(g.fazercardCategoryId || ""), fzGift: String(g.fazercardGiftCategoryId || ""), fzFields: Array.isArray(g.fazercardFields) ? g.fazercardFields : [],
        srvOpts: (g.fazercardServerMode === "select" && g.fazercardServerOptions) || (g.g2bulkServerMode === "select" && g.g2bulkServerOptions) || null,
      },
    });
  }
  const groups = [...map.values()].sort((a, b) => a.order - b.order || b.created - a.created || a.name.localeCompare(b.name));
  groups.forEach((g) => g.entries.sort((a, b) => a.order - b.order || a.server.localeCompare(b.server)));
  STORE = { t: Date.now(), groups, byId: new Map(groups.map((g) => [g.id, g])) };
  return STORE;
}

/* ---------- Editable cards (templates) ----------
   The owner edits every card from the bot ("🎨 Card ပြင်ရန်"): he sends the new text already formatted in Telegram
   (bold, italic, underline, strike, spoiler, mono, code block, quote, link, premium emoji) and the bot keeps it as HTML in KV "tpl:all".
   {placeholders} are replaced by the live values (prices always come from the store). A line whose placeholders are all empty
   disappears, so optional lines (code, error, character ...) need no special care. Premium emoji: if Telegram refuses them
   (the bot has no extra Fragment username) tg() resends the same card with the plain emoji. */
const LINE = "━━━━━━━━━━━━━━━━━━";
const ORDER_BODY = "\n" + LINE + "\n<code>Game   </code> {title}\n<code>Pack   </code> {amount}\n<code>Price  </code> <b>{price} MMK</b>\n" + LINE +
  "\n<code>ID     </code> <code>{pid}</code>\n<code>Server </code> {serverid}\n<code>Char   </code> {cname}\n<code>Name   </code> <b>{pname}</b>\n" + LINE +
  "\n<code>Order  </code> <code>{id}</code>\n<code>Via    </code> {via}\n<code>Time   </code> {date}\n<code>By     </code> {byline}\n\n{codeblock}\n\n⚠ {error}";
const TPL_DEF = {
  proc: "◌ <b>Order Processing</b>\nလုပ်ဆောင်နေပါတယ်၊ ခဏစောင့်ပါ" + ORDER_BODY,
  done: "✓ <b>Order Completed</b>\nအောင်မြင်ပါတယ်" + ORDER_BODY,
  fail: "✗ <b>Order Failed</b>\nမအောင်မြင်ပါ — ငွေမကျသေးပါ" + ORDER_BODY,
  unk: "! <b>Order Status Unknown</b>\nရလဒ် မသေချာပါ — Provider မှာ ကိုယ်တိုင်စစ်ပါ၊ ထပ်မဝယ်ပါနဲ့" + ORDER_BODY,
  detail: "🧾 <b>Order စစ်ဆေးရန်</b>\n" + LINE + "\n🎮 {title}\n📦 {amount}\n💰 <b>{price} MMK</b>\n" + LINE +
    "\n🆔 Player ID  <code>{pid}</code>\n🖥 Server  {serverid}\n👤 Character  {cname}\n✔️ ID Name  <b>{pname}</b>  ✅ စစ်ပြီး\n" + LINE +
    "\n🚚 {provider}\n\n⚠️ {warn}\n\n⛔ {blocker}\n\n{hint}",
  quote: "<blockquote>🎮 <b>{title}</b>\n{rows}\n{totalline}</blockquote>",
  qrow: "{amount}{qtyx} — {pricetag}",
  ptable: "🎮 {title}\n{label}{part}",
  b_done: "✅ Completed", b_fail: "❌ Failed", b_proc: "⏳ Processing", b_check: "🔄 Status စစ်", b_unk: "⚠️ မသေချာ — Provider မှာစစ်ပါ", b_again: "🛒 ထပ်ဝယ်မယ်",
};
const TPL_BTN_KEYS = ["b_done", "b_fail", "b_proc", "b_check", "b_unk", "b_again"];   // plain-text button labels of the order card
const TPL_KEYS = ["proc", "done", "fail", "unk", "detail", "quote", "qrow", "ptable"];
const TPL_LABEL = {
  proc: "⏳ Order လုပ်ဆောင်နေ card", done: "✅ Order ပြီးစီး card", fail: "❌ Reject / မအောင်မြင် card", unk: "⚠️ မသေချာ card",
  b_done: "✅ ပြီးစီး ခလုတ်", b_fail: "❌ Failed ခလုတ်", b_proc: "⏳ လုပ်ဆောင်နေ ခလုတ်", b_check: "🔄 Status စစ် ခလုတ်", b_unk: "⚠️ မသေချာ ခလုတ်", b_again: "🛒 ထပ်ဝယ် ခလုတ်",
  detail: "🧾 Order အသေးစိတ် card", quote: "💬 ဈေး Quote card", qrow: "📝 Quote စာကြောင်း", ptable: "📊 ဇယား ခေါင်းစီး",
};
const TPL_HINT = {
  proc: "Order တင်ပြီး Provider ဆီက အဖြေ မရသေးတုန်း ပြတဲ့ card",
  done: "Order ပြီးစီးတဲ့အခါ ပြတဲ့ card (Code ပါရင် ပါမယ်)",
  fail: "Provider က ငြင်းပယ် / Fail / Refund ဖြစ်တဲ့အခါ ပြတဲ့ card",
  unk: "Provider နဲ့ ချိတ်ဆက်မှု ပြတ်ပြီး ရလဒ် မသေချာတဲ့အခါ ပြတဲ့ card",
  detail: "ID စစ်ပြီး ✅ Confirm မနှိပ်ခင် ပြတဲ့ Order အသေးစိတ် card",
  quote: "Group ထဲမှာ Admin က <code>86 172 wp</code> လို့ ရိုက်ရင် ပြန်တဲ့ ဈေး card (Game တစ်ခုချင်းစီအတွက်)",
  qrow: "Quote card ထဲက Package တစ်ကြောင်းချင်းစီရဲ့ ပုံစံ",
  b_done: "Order ပြီးရင် card အောက်က ခလုတ်", b_fail: "Order မအောင်မြင်ရင် card အောက်က ခလုတ်", b_proc: "လုပ်ဆောင်နေတုန်း card အောက်က ခလုတ်",
  b_check: "လုပ်ဆောင်နေတုန်း Status ပြန်စစ်တဲ့ ခလုတ်", b_unk: "မသေချာတဲ့ card အောက်က ခလုတ်", b_again: "ပြီးပြီ / မအောင်မြင်ရင် ပေါ်တဲ့ ထပ်ဝယ်ခလုတ်",
  ptable: "ဇယားရဲ့ အပေါ်က ခေါင်းစီး။ စာလုံးသက်သက်ဆိုရင် ဇယားနဲ့ message တစ်ခုတည်း၊ format / premium emoji ပါရင် ခေါင်းစီးကို သီးခြား message ခွဲပို့ပါမယ်",
};
const PH_ORDER = [
  ["id", "Order ID"], ["title", "Game · Server"], ["game", "Game"], ["server", "Server အမည်"], ["amount", "Package"], ["price", "ဈေး (MMK)"],
  ["pid", "Player ID"], ["sid", "Server ID"], ["sname", "Server အမည် (ID နဲ့ မတူရင်)"], ["serverid", "Server ID (+ အမည်)"], ["cname", "Character"],
  ["pname", "ID စစ်ထားတဲ့ နာမည်"], ["provider", "Provider"], ["ref", "Provider ref"], ["via", "Provider · ref"], ["codes", "Code များ"],
  ["codeblock", "Code အပိုင်း (🎟 ခေါင်းစီးပါ)"], ["error", "Error"], ["by", "Order တင်သူ"], ["src", "Group"], ["byline", "တင်သူ · Group"], ["date", "ရက် / အချိန်"], ["status", "Status"],
];
const PH_LIST = {
  proc: PH_ORDER, done: PH_ORDER, fail: PH_ORDER, unk: PH_ORDER,
  detail: [["title", "Game · Server"], ["amount", "Package"], ["price", "ဈေး (MMK)"], ["pid", "Player ID"], ["sid", "Server ID"], ["sname", "Server အမည်"], ["serverid", "Server ID (+ အမည်)"], ["cname", "Character"], ["pname", "ID စစ်ထားတဲ့ နာမည်"], ["provider", "Provider"], ["warn", "သတိပေးချက်"], ["blocker", "မဝယ်နိုင်ရတဲ့ အကြောင်း"], ["hint", "Confirm နှိပ်ရန် အကြံပေးစာ (ဝယ်လို့ရမှ ပေါ်)"]],
  quote: [["title", "Game · Server"], ["game", "Game"], ["server", "Server"], ["rows", "Package စာကြောင်းများ"], ["total", "စုစုပေါင်း (ဂဏန်း)"], ["totalline", "စုစုပေါင်း စာကြောင်း (၂ ခုထက်ပိုမှ ပေါ်)"], ["count", "Package အရေအတွက်"]],
  qrow: [["amount", "Package"], ["qty", "အရေအတွက်"], ["qtyx", "×အရေအတွက် (၁ ထက်ပိုမှ ပေါ်)"], ["unit", "တစ်ခုဈေး"], ["price", "ဈေး (အရေအတွက်နဲ့ မြှောက်ပြီး)"], ["pricetag", "ဈေး + Ks"]],
  ptable: [["title", "Game · Server"], ["game", "Game"], ["server", "Server"], ["label", "Tab အမည် (Diamond / Pass ...)"], ["part", "(၁/၂) ပုံစံ — ရှည်ရင်သာ ပေါ်"]],
};
for (const k of TPL_BTN_KEYS) PH_LIST[k] = [];
const STATUS_LABEL = { completed: "Completed", processing: "Processing", failed: "Failed", unknown: "Unknown" };
const PH_RE = /\{([a-z][a-z0-9_]*)\}/g;
const TPL_BASE = { ...TPL_DEF, _custom: {} };
let TPLC = { t: 0, v: null };
const tplNow = () => TPLC.v || TPL_BASE;
function tplMerge(custom) {
  const v = { ...TPL_DEF, _custom: {} };
  for (const [k, h] of Object.entries(custom || {})) if (TPL_DEF[k] && typeof h === "string" && h.trim()) { v[k] = h; v._custom[k] = true; }
  return v;
}
async function loadTpl(env, force = false) {              // cached 20 s; saveTpl() refreshes the cache at once
  if (!KV) return tplNow();
  if (!force && TPLC.v && Date.now() - TPLC.t < 20000) return TPLC.v;
  const custom = await KV.get("tpl:all", "json").catch(() => null);
  TPLC = { t: Date.now(), v: tplMerge(custom) };
  return TPLC.v;
}
async function saveTpl(env, key, html) {                  // key null = reset every card, html null = reset that card
  let cur = (await KV.get("tpl:all", "json").catch(() => null)) || {};
  if (key === null) cur = {}; else if (html === null) delete cur[key]; else cur[key] = html;
  if (Object.keys(cur).length) await KV.put("tpl:all", JSON.stringify(cur)); else await KV.delete("tpl:all");
  TPLC = { t: Date.now(), v: tplMerge(cur) };
}
function balanced(line) {                                 // a line whose tags open and close inside itself can be dropped safely
  const st = [];
  for (const m of line.matchAll(/<(\/?)([a-z][a-z-]*)[^>]*>/gi)) {
    const tag = m[2].toLowerCase();
    if (m[1]) { if (st.pop() !== tag) return false; } else st.push(tag);
  }
  return !st.length;
}
function tplRender(tpl, vars) {
  const out = [];
  for (const line of String(tpl).split("\n")) {
    const keys = [...line.matchAll(PH_RE)].map((m) => m[1]).filter((k) => k in vars);
    if (keys.length && keys.every((k) => !String(vars[k] ?? "").trim()) && balanced(line)) continue;   // nothing to show on this line
    out.push(line.replace(PH_RE, (m, k) => (k in vars ? String(vars[k] ?? "") : m)));
  }
  const isDiv = (l) => /^[━─═—-]{6,}$/.test(l.trim());       // dividers stay tidy: never doubled, never first or last
  const tidy = [];
  let prevDiv = true;
  for (const l of out) {
    if (isDiv(l)) { if (prevDiv) continue; prevDiv = true; tidy.push(l); }
    else { if (l.trim()) prevDiv = false; tidy.push(l); }
  }
  while (tidy.length && (!tidy[tidy.length - 1].trim() || isDiv(tidy[tidy.length - 1]))) tidy.pop();
  return tidy.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+<\/blockquote>/g, "</blockquote>").trim();
}
function tplOut(key, vars, forceDefault) {               // the card text; a broken / empty / too long custom card falls back to the default one
  let h = "";
  if (!forceDefault) { try { h = tplRender(tplNow()[key] || TPL_DEF[key], vars); } catch {} }
  if (!h || h.length > 3900) h = cut(tplRender(TPL_DEF[key], vars), 4000);
  return h;
}
const htmlToText = (h) => String(h).replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const isPlainTpl = (h) => !/<[a-z\/]/i.test(String(h));
const dateMM = (t) => {
  try { return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yangon", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(t || Date.now())); } catch { return ""; }
};
const unknownPh = (key, html) => [...new Set([...String(html).matchAll(PH_RE)].map((m) => m[1]))].filter((k) => !PH_LIST[key].some((x) => x[0] === k));

/* Telegram message text + entities  ->  HTML (what the owner typed / formatted in the chat) */
const E_TAG = {
  bold: ["<b>", "</b>"], italic: ["<i>", "</i>"], underline: ["<u>", "</u>"], strikethrough: ["<s>", "</s>"], spoiler: ["<tg-spoiler>", "</tg-spoiler>"],
  code: ["<code>", "</code>"], blockquote: ["<blockquote>", "</blockquote>"], expandable_blockquote: ["<blockquote expandable>", "</blockquote>"],
};
const attr = (s) => esc(s).replace(/"/g, "&quot;");
function entOpen(e) {
  if (E_TAG[e.type]) return E_TAG[e.type][0];
  if (e.type === "pre") return e.language ? `<pre><code class="language-${attr(e.language)}">` : "<pre>";
  if (e.type === "text_link" && e.url) return `<a href="${attr(e.url)}">`;
  if (e.type === "text_mention" && e.user) return `<a href="tg://user?id=${Number(e.user.id)}">`;
  if (e.type === "custom_emoji" && e.custom_emoji_id) return `<tg-emoji emoji-id="${attr(e.custom_emoji_id)}">`;
  return "";
}
function entClose(e) {
  if (E_TAG[e.type]) return E_TAG[e.type][1];
  if (e.type === "pre") return e.language ? "</code></pre>" : "</pre>";
  if (e.type === "text_link" || e.type === "text_mention") return "</a>";
  if (e.type === "custom_emoji") return "</tg-emoji>";
  return "";
}
function entitiesToHtml(text, entities) {                // overlapping entities are closed and re-opened so the HTML always nests correctly
  text = String(text || "");
  const list = (entities || []).filter((e) => e && e.length > 0 && entOpen(e)).map((e) => ({ ...e, end: e.offset + e.length }))
    .sort((a, b) => a.offset - b.offset || b.end - a.end);
  const cuts = [...new Set([0, text.length, ...list.flatMap((e) => [e.offset, e.end])])].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  let out = "", stack = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i], e = cuts[i + 1];
    const active = list.filter((x) => x.offset <= s && x.end >= e);
    const k = stack.findIndex((x) => !active.includes(x));
    if (k >= 0) {
      const keep = stack.slice(k).filter((x) => active.includes(x));
      for (let j = stack.length - 1; j >= k; j--) out += entClose(stack[j]);
      stack = stack.slice(0, k);
      for (const x of keep) { out += entOpen(x); stack.push(x); }
    }
    for (const x of active) if (!stack.includes(x)) { out += entOpen(x); stack.push(x); }
    out += esc(text.slice(s, e));
  }
  for (let j = stack.length - 1; j >= 0; j--) out += entClose(stack[j]);
  return out;
}

/* ---------- Price tables (one per store tab) ---------- */
const tabOf = (p) => p.tab || p.type || "currency";
function tabsOf(entry) {
  const seen = [];
  entry.packages.forEach((p) => { const t = tabOf(p); if (!seen.includes(t)) seen.push(t); });
  const order = ["currency", "package", ...seen.filter((t) => t !== "currency" && t !== "package")].filter((t) => seen.includes(t));
  const label = (t) => (t === "package" ? entry.labels.package || "Package" : t === "currency" ? entry.labels.currency || "Currency" : t);
  const mark = (p) => (p.badge === "hot" ? " 🔥" : p.badge === "top" ? " ⭐" : "");
  const price = (p) => (p.price === undefined || p.price === null || p.price === "" ? "-" : Number(p.price).toLocaleString("en-US"));
  return order.map((t) => ({
    label: label(t), key: t,
    rows: entry.packages.filter((p) => tabOf(p) === t).map((p) => [String(p.amount ?? "-") + mark(p), price(p)]),
  }));
}
const rbCell = (t, header) => ({ text: String(t), align: "left", valign: "middle", ...(header ? { is_header: true } : {}) });
const rbTable = (heads, rows) => ({ type: "table", is_bordered: true, is_compact: true, cells: [heads.map((h) => rbCell(h, true)), ...rows.map((r) => r.map((c) => rbCell(c)))] });
const rbPara = (t) => ({ type: "paragraph", text: { type: "bold", text: String(t) } });
const width = (s) => [...String(s)].length;
function boxTable(head, rows) {     // plain-text fallback when the rich table is refused
  const widths = head.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const pad = (s, n, right) => (right ? " ".repeat(n - width(s)) + s : s + " ".repeat(n - width(s)));
  const line = (l, m, r) => l + widths.map((x) => "─".repeat(x + 2)).join(m) + r;
  const row = (r) => "│" + r.map((c, i) => " " + pad(c, widths[i], i === head.length - 1) + " ").join("│") + "│";
  return [line("┌", "┬", "┐"), row(head), line("├", "┼", "┤"), ...rows.map(row), line("└", "┴", "┘")].join("\n");
}
// One store tab -> one (or, for very long tabs, a few) bordered table message(s). Returns the message ids.
async function sendTable(env, chat, reply, group, entry, label, rows) {
  const ids = [];
  const head = ["Package", "Price (MMK)"];
  const chunks = [];
  for (let i = 0; i < rows.length; i += TABLE_CHUNK) chunks.push(rows.slice(i, i + TABLE_CHUNK));
  const plain = isPlainTpl(tplNow().ptable);        // plain text header = one rich message with the table; formatted header = its own message above the table
  for (let i = 0; i < chunks.length; i++) {
    const html = tplOut("ptable", {
      game: esc(group.name), server: esc(entry.server || ""), title: esc(group.name) + (entry.server ? " · " + esc(entry.server) : ""),
      label: esc(label), part: chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : "",
    });
    const cap = htmlToText(html);
    const blocks = [rbTable(head, chunks[i])];
    if (plain) blocks.unshift(rbPara(cap));
    else {
      const h = await send(env, chat, html, { ...replyTo(reply), disable_web_page_preview: true }).catch(() => null);
      if (h?.result?.message_id) ids.push(h.result.message_id);
    }
    let r = await tg(env, "sendRichMessage", { chat_id: chat, rich_message: { blocks }, ...replyTo(reply) }).catch(() => null);
    if (!r?.ok) {                                   // fallback: monospace box table (split small enough for one message)
      const part = chunks[i];
      for (let j = 0; j < part.length; j += 25) {
        r = await send(env, chat, `${plain ? `<b>${esc(cap)}</b>\n` : ""}<pre>${esc(boxTable(head, part.slice(j, j + 25)))}</pre>`, replyTo(reply)).catch(() => null);
        if (r?.result?.message_id) ids.push(r.result.message_id);
      }
      continue;
    }
    if (r.result?.message_id) ids.push(r.result.message_id);
  }
  return ids;
}
async function sendPrice(env, chat, group, entry, reply) {
  const title = `🎮 ${group.name}${entry.server ? ` · ${entry.server}` : ""}`;
  const tabs = tabsOf(entry);
  const ids = [];
  if (!tabs.length) {
    const r = await send(env, chat, `<b>${esc(title)}</b>\nPackage မရှိသေးပါ`, replyTo(reply));
    if (r?.result?.message_id) ids.push(r.result.message_id);
  }
  for (const t of tabs) ids.push(...(await sendTable(env, chat, reply, group, entry, t.label, t.rows)));
  for (const id of ids) await scheduleDelete(env, chat, id, priceMs(env));
}

/* ---------- Group: menu for the games this group may see ---------- */
const MAX_GAMES = 2;        // a group may show at most 2 games
const getAllowed = async (chat) => ((await KV.get("gg:" + chat, "json").catch(() => null)) || []).slice(0, MAX_GAMES);
function menuView(store, allowed, kind, page) {
  const mine = store.groups.filter((g) => allowed.includes(g.key));
  const t = mine.filter((g) => g.kind === "t"), v = mine.filter((g) => g.kind === "v");
  if (!t.length && !v.length) return null;
  if (kind !== "t" && kind !== "v") kind = t.length ? "t" : "v";
  if (kind === "t" && !t.length) kind = "v";
  if (kind === "v" && !v.length) kind = "t";
  const list = kind === "t" ? t : v;
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(0, page | 0), pages - 1);
  const rows = [];
  if (t.length && v.length) rows.push([
    { text: "💎 Top Up", callback_data: "m:t:0", style: kind === "t" ? "success" : "primary" },
    { text: "🎟 Voucher", callback_data: "m:v:0", style: kind === "v" ? "success" : "primary" },
  ]);
  const slice = list.slice(page * PAGE, page * PAGE + PAGE);
  for (let i = 0; i < slice.length; i += 2)
    rows.push(slice.slice(i, i + 2).map((g) => ({ text: ell(g.name, 28), callback_data: `g:${g.id}`, style: "primary" })));
  if (pages > 1) rows.push(pagerRow(page, pages, (n) => `m:${kind}:${n}`));
  rows.push([{ text: "❌ ပိတ်", callback_data: "x", style: "danger" }]);
  return { kind, text: `📋 <b>Price List</b> — ${kind === "t" ? "💎 Top Up" : "🎟 Voucher"}\nGame ရွေးပါ 👇`, markup: { inline_keyboard: rows } };
}
const COOL = new Map();
const PRICE_RE = /\b(list|lists|price|prices|pricelist|game|games|rate|rates|mmk)\b|ဈေး|ဘယ်လောက်/i;   // any price-related word brings the list
const NOTICE = new Map();
async function onGroupMessage(m, env) {
  const chat = m.chat.id;
  if (m.from?.is_bot) return;
  if (!SEEN.has(chat)) {                            // remember the group (the owner picks games per group)
    SEEN.add(chat);
    await KV.put("grp:" + chat, String(m.chat.title || chat).slice(0, 60)).catch(() => {});
  }
  const text = String(m.text || "").trim();
  const am = text.match(/^\/admin(?:@(\w+))?\s+list$/i);
  if (am) {                                         // admin only: everybody else gets no reply at all
    if (am[1] && am[1].toLowerCase() !== (await botName(env))) return;
    if (!isAdmin(env, m.from?.id)) return;
    await tg(env, "deleteMessage", { chat_id: chat, message_id: m.message_id }).catch(() => {});   // the command itself disappears too
    if (await adminStart(env, m.from.id, String(m.chat.title || ""))) return;                        // the whole flow runs in the admin's private chat
    const r = await send(env, chat, "📩 Admin — Bot ကို private မှာ <b>Start</b> အရင်နှိပ်ပြီး ပြန်ခေါ်ပါ", { reply_markup: { inline_keyboard: [[{ text: "▶️ Bot ကို Start", url: `https://t.me/${await botName(env)}?start=admin` }]] } });
    return scheduleDelete(env, chat, r?.result?.message_id, 30 * 1000);
  }
  const uid = m.from?.id || 0;
  if (uid && isAdmin(env, uid)) {                   // admin: reply to the bot's card (ID / Character), or type "ID + amount" to order
    if (await groupAdminText(env, m)) return;
    if (/^\/chk(@\w+)?(\s|$)/i.test(text)) { await chkCommand(env, m, true); return; }
    if (await autoBuy(env, m, true)) return;
    if (await priceQuote(env, m)) return;
  }
  const cm = text.match(/^\/list(?:@(\w+))?$/i);
  if (cm && cm[1] && cm[1].toLowerCase() !== (await botName(env))) return;   // addressed to another bot
  if (!cm && !(!text.startsWith("/") && text.length <= 200 && PRICE_RE.test(text))) return;
  const now = Date.now();
  if (now - (COOL.get(chat) || 0) < 4000) return;   // one menu per 4 s per group, so chatter cannot flood it
  if (COOL.size > 3000) COOL.clear();
  COOL.set(chat, now);

  const allowed = await getAllowed(chat);
  const store = await loadStore(env);
  if (!store.groups) return send(env, chat, "⚠️ Store data မရနိုင်သေးပါ၊ ခဏနေ ပြန်စမ်းပါ။", replyTo(m.message_id));
  const view = menuView(store, allowed, "", 0);
  if (!view) {                                      // nothing set for this group: tell once a minute, then remove the notice
    if (now - (NOTICE.get(chat) || 0) < 60000) return;
    NOTICE.set(chat, now);
    const r = await send(env, chat, "ℹ️ ဒီ Group အတွက် Price List မသတ်မှတ်ရသေးပါ", replyTo(m.message_id));
    return scheduleDelete(env, chat, r?.result?.message_id, 60 * 1000);
  }
  const r = await send(env, chat, view.text, { ...replyTo(m.message_id), reply_markup: view.markup });
  await scheduleDelete(env, chat, r?.result?.message_id, menuMs(env));
}
const SEEN = new Set();

async function onGroupCallback(q, env) {
  const chat = q.message.chat.id, mid = q.message.message_id;
  const [tag, a, b] = String(q.data).split(":");
  const ans = (text) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text, show_alert: false } : {}) });
  if (tag === "nop") return ans();
  if (tag === "x") { await ans(); return tg(env, "deleteMessage", { chat_id: chat, message_id: mid }).catch(() => {}); }
  const store = await loadStore(env);
  if (!store.groups) { await ans("⚠️ Store data မရနိုင်သေးပါ၊ ခဏနေ ပြန်စမ်းပါ"); return; }
  const allowed = await getAllowed(chat);
  const edit = (text, markup) => tg(env, "editMessageText", { chat_id: chat, message_id: mid, text, parse_mode: "HTML", reply_markup: markup }).catch(() => {});

  if (tag === "m") {
    await ans();
    const view = menuView(store, allowed, a, Number(b) || 0);
    return view ? edit(view.text, view.markup) : edit("ℹ️ ဒီ Group အတွက် Price List မသတ်မှတ်ရသေးပါ", { inline_keyboard: [] });
  }
  if (tag === "g" || tag === "s") {
    const group = store.byId.get(a);
    if (!group || !allowed.includes(group.key)) { await ans("ဒီ Game မရနိုင်တော့ပါ"); return; }
    if (tag === "g" && group.entries.length > 1) {   // several servers: pick the server first
      await ans();
      const rows = [];
      group.entries.forEach((e, i) => {
        const btn = { text: ell(e.server || "Default", 28), callback_data: `s:${group.id}:${i}`, style: "primary" };
        if (i % 2 === 0) rows.push([btn]); else rows[rows.length - 1].push(btn);
      });
      rows.push([{ text: "⬅️ ပြန်သွားရန်", callback_data: `m:${group.kind}:0` }, { text: "❌ ပိတ်", callback_data: "x", style: "danger" }]);
      return edit(`🎮 <b>${esc(group.name)}</b>\nServer ရွေးပါ 👇`, { inline_keyboard: rows });
    }
    const entry = group.entries[tag === "s" ? Number(b) || 0 : 0];
    if (!entry) { await ans("မတွေ့ပါ"); return; }
    await ans();
    const reply = q.message.reply_to_message?.message_id || 0;
    await sendPrice(env, chat, group, entry, reply);
    return tg(env, "deleteMessage", { chat_id: chat, message_id: mid }).catch(() => {});   // the menu has done its job
  }
  return ans();
}

/* ---------- Owner (private chat): which game list each group may see ---------- */
const kbOf = (rows) => ({ keyboard: rows, resize_keyboard: true, is_persistent: true, input_field_placeholder: "ဝယ်ရန် ml 123456789 2001 86" });
const KB = kbOf([[{ text: "🛒 ဝယ်ယူရန်" }], [{ text: "👥 Group စီမံရန်" }, { text: "📋 သတ်မှတ်ထားတာများ" }], [{ text: "🎨 Card ပြင်ရန်" }, { text: "🔄 Game list refresh" }], [{ text: "📊 ယနေ့ အရောင်း" }, { text: "ℹ️ အကူအညီ" }]]);
const KB_LABELS = new Set(["🛒 ဝယ်ယူရန်", "👥 Group စီမံရန်", "📋 သတ်မှတ်ထားတာများ", "🎨 Card ပြင်ရန်", "🔄 Game list refresh", "📊 ယနေ့ အရောင်း", "ℹ️ အကူအညီ", "📋 Price List"]);
const KB_ADMIN = kbOf([[{ text: "🛒 ဝယ်ယူရန်" }, { text: "📊 ယနေ့ အရောင်း" }], [{ text: "ℹ️ အကူအညီ" }]]);
const KB_GROUP = { keyboard: [[{ text: "📋 Price List" }]], resize_keyboard: true, is_persistent: true, input_field_placeholder: "ဈေးကြည့်ရန် Price List ကိုနှိပ်ပါ" };
/* ---------- ℹ️ Guide: a topic menu (buttons), every topic is one short step-by-step page ---------- */
// callback tags: "h:<topic>" opens a topic, "h:" (empty) = the menu, "hx" closes.  owner: true = Owner only.
const BATCH_MAX = 10, QTY_MAX = 10, LOWBAL_USD = 10;
const GUIDE = {
  buy: { label: "🛒 ဝယ်နည်း", text:
    "🛒 <b>ဝယ်နည်း</b>  <i>(Admin သာ)</i>\n" + LINE + "\n" +
    "<code>ml 1159045022 13678 86</code>\n<i>ဂိမ်းအတိုကောက် · ID · Server · Package</i>\n\n" +
    "ပို့လိုက်တာနဲ့ ID စစ် → <b>တန်းဖြည့်</b> (Confirm မလို)\n\n" +
    "• Server မလိုရင် → <code>ff 123456789 100</code>\n• အရေအတွက် → <code>ml 1159045022 13678 86 x3</code>\n• Package များ → <code>ml 1159045022 13678 86/172/wp2</code>\n• ID များ → စာကြောင်းတစ်ကြောင်း ID တစ်ခု\n\n" +
    `⚠️ တစ်ကြောင်းမှားရင် ဘာမှမဖြတ်ပါ\nတစ်ခါပို့ Order ${BATCH_MAX} ခုထိ · တစ်ခုကို ×${QTY_MAX} ထိ\nအတိုကောက်ကြည့်ရန် Owner → <code>/abbr</code>` },
  tpl: { label: "📋 Template", text:
    "📋 <b>Template</b>  <i>(နှိပ်ရင် copy ရ)</i>\n" + LINE + "\n" +
    "<b>ဝယ်</b>\n<code>ml 1159045022 13678 86</code>\n\n<b>အရေအတွက်</b>\n<code>ml 1159045022 13678 86 x3</code>\n\n<b>Package များ</b>\n<code>ml 1159045022 13678 86/172/wp2</code>\n\n" +
    "<b>ID များ</b>\n<code>ml 1159045022 13678 86\n1159045023 13679 wp x2</code>\n\n<b>ID / Package စစ်</b>\n<code>ml 1159045022 13678</code>\n\n<b>ဈေးကြည့်</b>\n<code>86 172 wp</code>\n\n<b>Balance</b>\n<code>/balance</code>" },
  check: { label: "🔎 ID စစ်နည်း", text:
    "🔎 <b>ID / Package စစ်နည်း</b>\n" + LINE + "\n" +
    "Package မပါဘဲ ပို့ပါ\n<code>ml 1159045022 13678</code>  သို့  <code>/chk ml 1159045022 13678</code>\n\n" +
    "Name + <b>ဒီ Bot က ဝယ်ပေးပြီးသား</b> package စာရင်း (ရက်နဲ့) ပြပါမယ်\n✅ ❌ Pass / Double Diamond status ကို Provider မပေးလို့ မပြပါ (STATUS_API ထည့်ရင်ပြမယ်)\n\n" +
    "<i>တခြားနေရာက ဝယ်ထားတာ မပါပါ — ဒီ Bot မှတ်တမ်းပဲ။</i>" },
  bal: { label: "💳 API Balance", text:
    "💳 <b>API Balance</b>\n" + LINE + "\n" +
    "<code>/balance</code> → လက်ကျန် (USD)\n\n" +
    `• ${LOWBAL_USD} USD အောက်ရောက်ရင် Order card တိုင်းမှာ ⚠ သတိပေးပါမယ်\n• အောက်ရောက်တဲ့အချိန် Owner ကို တစ်ခါ အကြောင်းကြားပါမယ်\n• ငွေဖြည့်ပြီးရင် <b>Successfully Deposit</b> လို့ အကြောင်းကြားပါမယ်\n• Balance မရှိတော့ရင် Order မတင်ပါ` },
  quote: { label: "💰 ဈေးပြောနည်း", text:
    "💰 <b>ဈေးပြောနည်း</b>  <i>(Group ထဲ Admin)</i>\n" + LINE + "\n" +
    "<code>86</code> → ဈေး\n<code>wp 2</code> → wp ၂ ခု (အများဆုံး ၆)\n<code>86 172 wp</code> → အများကြီး + စုစုပေါင်း\n<code>diamond</code> / <code>pass</code> → tab ဇယားအပြည့်\n\nBot ကို private မှာလည်း ပို့ကြည့်လို့ရ\n၅ မိနစ်ကြာရင် auto ပျက်ပါမယ်" },
  result: { label: "📦 Order အခြေအနေ", text:
    "📦 <b>Order အခြေအနေ</b>\n" + LINE + "\n" +
    "◌ <b>Processing</b> — လုပ်ဆောင်နေ (auto ပြင်ပေးမယ်)\n✓ <b>Completed</b> — ပြီးပါပြီ\n✗ <b>Failed</b> — မဝယ်ရ၊ ငွေမကျ\n! <b>Unknown</b> — ရလဒ်မသေချာ\n\n" +
    "⚠️ Unknown / Processing ကြာနေရင် <b>ထပ်မဝယ်ပါနဲ့</b> — Provider မှာ အရင်စစ်ပါ\n\n📊 <b>ယနေ့ အရောင်း</b> — ဒီနေ့ order / စုစုပေါင်း" },
  member: { label: "👥 Member သုံးနည်း", text:
    "👥 <b>Member</b>  <i>(ဖတ်ရုံသာ)</i>\n" + LINE + "\n" +
    "Group ထဲ <code>List</code> / <code>ဈေး</code> ရိုက် (သို့) <b>📋 Price List</b> နှိပ်\nGame → (Server) → ဈေးဇယား\n\nMember က ID / စာ ပို့ရင် Bot က <b>ပြန်မဖြေပါ</b>။ ဝယ်လို့ Admin သာ ရပါမယ်။", owner: true },
  group: { label: "⚙️ Group သတ်မှတ်ရန်", text:
    "⚙️ <b>Group သတ်မှတ်ရန်</b>  <i>(Owner)</i>\n" + LINE + "\n" +
    `1️⃣ Bot ကို Group ထည့် → Admin လုပ်\n2️⃣ <b>👥 Group စီမံရန်</b> → Group ရွေး\n3️⃣ Game ကို ✅ ပေး/ဖြုတ် (Group တစ်ခုကို ${MAX_GAMES} ခု)\n4️⃣ <b>✅ ပြီးပြီ</b>\n\n📋 <b>သတ်မှတ်ထားတာများ</b> — Group အလိုက် ကြည့်\n🔄 <b>Game list refresh</b> — Store ပြင်ပြီး ချက်ချင်းယူ`, owner: true },
  cards: { label: "🎨 Card ပြင်နည်း", text:
    "🎨 <b>Card ပြင်နည်း</b>  <i>(Owner)</i>\n" + LINE + "\n" +
    "1️⃣ <b>🎨 Card ပြင်ရန်</b> → Card ရွေး\n2️⃣ စာအသစ်ကို format လုပ်ပြီး ပို့\n3️⃣ <code>{price}</code> <code>{amount}</code> <code>{id}</code> လို placeholder သုံး\n\nကျိုးတဲ့ card ဆိုရင် မူလ card ပြန်သုံးမယ်၊ Reset လည်းရ", owner: true },
  fix: { label: "🛠 ပြဿနာ", text:
    "🛠 <b>ပြဿနာဖြေရှင်းရန်</b>\n" + LINE + "\n" +
    "<b>✗ မဝယ်ရသေးပါ</b> → card ထဲက စာကြောင်းကို ပြင်ပြီး ပြန်ပို့ (ဘာမှ မဖြတ်ရသေး)\n<b>အတိုကောက် မမှန်</b> → Owner <code>/abbr</code>\n<b>ID စစ်မရ</b> → ခဏနေ ပြန်ပို့\n<b>List မပေါ်</b> → Bot ကို Group Admin လုပ် · 👥 Group စီမံရန်မှာ Game သတ်မှတ်\n<b>Admin ခလုတ် မရ</b> → Bot ကို private မှာ Start နှိပ်\n<b>Store data မရ</b> → 🔄 Game list refresh\n\nကိုယ့် ID → private မှာ <code>/id</code>", owner: true },
};
const GUIDE_ORDER = ["buy", "tpl", "check", "bal", "quote", "result", "member", "group", "cards", "fix"];
function guideView(topic, owner) {
  const ok = (k) => GUIDE[k] && (owner || !GUIDE[k].owner);
  const close = btn("❌ ပိတ်", "hx", "danger");
  if (ok(topic)) return { text: GUIDE[topic].text, markup: { inline_keyboard: [[btn("⬅️ အကူအညီ", "h:", "primary"), close]] } };
  const keys = GUIDE_ORDER.filter(ok), rows = [];
  for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2).map((k) => btn(GUIDE[k].label, `h:${k}`, "primary")));
  rows.push([close]);
  return { text: "ℹ️ <b>အကူအညီ</b>\n\nရွေးပါ 👇\n\n<i>အမြန်ဝယ်</i> <code>ml 1159045022 13678 86</code>", markup: { inline_keyboard: rows } };
}
const WELCOME = (owner) => "👋 <b>LINN Price List Bot</b>\n" + (owner ? "Owner" : "Admin") + " အနေနဲ့ ဝင်ထားပါတယ်။\n🛒 <code>ml 1159045022 13678 86</code> → တန်းဖြည့်\n🔎 <code>ml 1159045022 13678</code> → ID / Package စစ်\nℹ️ သုံးနည်း → <b>အကူအညီ</b>";
async function onGuideCallback(q, env) {
  const chat = q.message.chat.id, mid = q.message.message_id;
  const owner = isOwner(env, q.from.id);
  const [tag, topic] = String(q.data).split(":");
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  if (tag === "hx") return tg(env, "deleteMessage", { chat_id: chat, message_id: mid }).catch(() => {});
  const v = guideView(topic || "", owner);
  const r = await tg(env, "editMessageText", { chat_id: chat, message_id: mid, text: v.text, parse_mode: "HTML", reply_markup: v.markup, disable_web_page_preview: true }).catch(() => null);
  if (r && !r.ok && !/not modified/i.test(r.description || "")) console.error(r.description);
}
const quickHint = (t) => parseQuick(t)
  ? "<b>Game အတိုကောက် မပါ / မမှန်ပါ</b>\nပုံစံ — <code>ml 123456789 2001 86</code>\nGame အတိုကောက်ကြည့်ရန် Owner က <code>/abbr</code> ရိုက်ပါ"
  : "🛒 ဝယ်ရန် <b>Game အတိုကောက် + ID + package</b> ပို့ပါ (ဥပမာ <code>ml 123456789 2001 86</code>) သို့ ခလုတ်ကို သုံးပါ 👇";

async function listGroups(env) {
  const l = await KV.list({ prefix: "grp:", limit: 100 });
  return Promise.all(l.keys.map(async (k) => ({ id: k.name.slice(4), title: (await KV.get(k.name).catch(() => "")) || k.name.slice(4) })));
}
async function groupsMenu(env) {
  const gl = await listGroups(env);
  if (!gl.length) return { text: "👥 Group မရှိသေးပါ\nBot ကို Group ထဲထည့်ပါ (Admin လုပ်ပါ)၊ ထည့်ပြီးရင် ဒီမှာ အလိုလိုပေါ်ပါမယ်။", markup: { inline_keyboard: [] } };
  const rows = [];
  for (const g of gl) rows.push([{ text: `👥 ${g.title} · ${(await getAllowed(g.id)).length}`.slice(0, 60), callback_data: `ac:${g.id}`, style: "primary" }]);
  rows.push([{ text: "❌ ပိတ်", callback_data: "ax", style: "danger" }]);
  return { text: "👥 <b>Group စီမံရန်</b>\nGroup တစ်ခု ရွေးပါ 👇  (နံပါတ် = ရွေးထားတဲ့ Game အရေအတွက်)", markup: { inline_keyboard: rows } };
}
async function pickerView(env, chat, kind, page) {
  const store = await loadStore(env);
  if (!store.groups) return { text: "⚠️ Store data မရနိုင်သေးပါ", markup: { inline_keyboard: [[{ text: "⬅️ Group များ", callback_data: "ab" }]] } };
  const sel = await getAllowed(chat);
  const title = (await KV.get("grp:" + chat).catch(() => "")) || chat;
  const T = store.groups.filter((g) => g.kind === "t"), V = store.groups.filter((g) => g.kind === "v");
  if (kind !== "t" && kind !== "v") kind = T.length ? "t" : "v";
  const list = kind === "t" ? T : V;
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(0, page | 0), pages - 1);
  const cnt = (arr) => arr.filter((g) => sel.includes(g.key)).length;
  const rows = [[
    { text: `💎 Top Up ${cnt(T)}/${T.length}`, callback_data: `ak:${chat}:t:0`, style: kind === "t" ? "success" : "primary" },
    { text: `🎟 Voucher ${cnt(V)}/${V.length}`, callback_data: `ak:${chat}:v:0`, style: kind === "v" ? "success" : "primary" },
  ]];
  const slice = list.slice(page * PAGE, page * PAGE + PAGE);
  for (let i = 0; i < slice.length; i += 2)
    rows.push(slice.slice(i, i + 2).map((g) => ({
      text: `${sel.includes(g.key) ? "✅" : "⬜"} ${g.name}`.slice(0, 30), callback_data: `at:${chat}:${g.id}:${kind}:${page}`,
      style: sel.includes(g.key) ? "success" : "primary",
    })));
  if (pages > 1) rows.push(pagerRow(page, pages, (n) => `ak:${chat}:${kind}:${n}`));
  rows.push([{ text: "🧹 ဒီ tab ရှင်း", callback_data: `an:${chat}:${kind}:${page}` }]);
  rows.push([{ text: "⬅️ Group များ", callback_data: "ab" }, { text: "✅ ပြီးပြီ", callback_data: `ad:${chat}`, style: "success" }]);
  return {
    text: `👥 <b>${esc(title)}</b>\nရွေးထားတဲ့ Game: <b>${sel.filter((k) => store.groups.some((g) => g.key === k)).length}/${MAX_GAMES}</b>\n\nGame ကို နှိပ်ရင် ✅ ပေး/ဖြုတ်ပါမယ် (Group တစ်ခုကို ${MAX_GAMES} ခုပဲ)`,
    markup: { inline_keyboard: rows },
  };
}
// "📋 သတ်မှတ်ထားတာများ" -> one bordered table (Group | Top Up | Voucher), same rich-table style as the price lists.
async function sendSummary(env, chat) {
  const gl = await listGroups(env);
  if (!gl.length) return send(env, chat, "📋 Group မရှိသေးပါ", { reply_markup: KB });
  const store = await loadStore(env);
  const rows = [];
  for (const g of gl) {
    const sel = await getAllowed(g.id);
    const names = (k) => (store.groups || []).filter((x) => x.kind === k && sel.includes(x.key)).map((x) => x.name);
    const t = names("t"), v = names("v");
    rows.push([`${g.title} (${t.length + v.length})`, t.join(", ") || "-", v.join(", ") || "-"]);
  }
  const head = ["Group", "💎 Top Up", "🎟 Voucher"];
  const CH = 15;                                    // groups per message
  const pages = Math.ceil(rows.length / CH);
  for (let i = 0; i < pages; i++) {
    const part = rows.slice(i * CH, i * CH + CH);
    const cap = `📋 သတ်မှတ်ထားတာများ${pages > 1 ? ` (${i + 1}/${pages})` : ""}`;
    const r = await tg(env, "sendRichMessage", { chat_id: chat, rich_message: { blocks: [rbPara(cap), rbTable(head, part)] } }).catch(() => null);
    if (r?.ok) continue;
    const txt = part.map((x) => `👥 <b>${esc(x[0])}</b>` + (x[1] !== "-" ? `\n💎 ${esc(x[1])}` : "") + (x[2] !== "-" ? `\n🎟 ${esc(x[2])}` : "") + (x[1] === "-" && x[2] === "-" ? "\n(မသတ်မှတ်ရသေးပါ)" : "")).join("\n\n");
    await send(env, chat, `<b>${esc(cap)}</b>\n\n` + txt.slice(0, 3800));
  }
}

/* ====================== ADMIN ORDER: buy from the bot (private chat, or /admin list in a group) ====================== */
const G2 = "https://api.g2bulk.com";
const FZ = "https://api.fzr.cards/api/v2";
const PKG_PAGE = 12;
const SRV_PAGE = 12;
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const cut = (s, n) => String(s).slice(0, n);
const btn = (text, data, style) => ({ text: ell(text, 40), callback_data: data, ...(style ? { style } : {}) });
// Tidy button helpers: one pager look everywhere (the first / last page shows an inert "·" instead of an arrow that
// only reloads the same page) and long labels end with "…" instead of being cut in the middle.
const ell = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
const pagerRow = (page, pages, go) => [
  page > 0 ? btn("◀️", go(page - 1)) : btn("·", "nop"),
  btn(`${page + 1}/${pages}`, "nop"),
  page < pages - 1 ? btn("▶️", go(page + 1)) : btn("·", "nop"),
];
const getSS = async (uid) => (await KV.get("ss:" + uid, "json").catch(() => null)) || null;
const putSS = (uid, ss) => KV.put("ss:" + uid, JSON.stringify(ss), { expirationTtl: 3600 }).catch(() => {});
const delSS = (uid) => KV.delete("ss:" + uid).catch(() => {});
const delMsg = (env, chat, id) => tg(env, "deleteMessage", { chat_id: chat, message_id: id }).catch(() => {});

/* ----- G2Bulk helpers (same endpoints/payloads as the store worker) ----- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const g2Blocked = async () => !!(await KV.get("g2:auth").catch(() => null));
async function g2AuthFailed(env) {                       // G2Bulk: repeated failed authentication = permanent IP ban -> stop calling for 30 min
  const first = !(await g2Blocked());
  await KV.put("g2:auth", "1", { expirationTtl: 1800 }).catch(() => {});
  if (first) for (const id of new Set([...idList(env.OWNER_IDS), ...idList(env.LOG_CHAT_ID)])) await send(env, id, "<b>⛔ G2Bulk API key မမှန်ပါ (401)</b>\nIP ban မဖြစ်အောင် ၃၀ မိနစ် G2Bulk ကို ခေါ်တာ ရပ်ထားပါမယ်\n<code>G2BULK_KEY</code> ကို စစ်ပြီး ပြင်ပါ").catch(() => {});
}
/* G2Bulk webhook: the game order carries callback_url -> G2Bulk POSTs here the moment the order is COMPLETED / FAILED (docs: 10 s timeout, 1 retry, no signature).
   So nothing in the payload is trusted: the URL holds a key derived from WEBHOOK_SECRET, and the order is always re-checked with the G2Bulk API before the card changes. */
async function hookKey(env) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(env.WEBHOOK_SECRET || "") + ":g2hook"));
  return [...new Uint8Array(d)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const hookUrl = async (env) => (ORIGIN && env.WEBHOOK_SECRET ? `${ORIGIN}/g2hook?k=${await hookKey(env)}` : "");
async function g2Hook(env, ref) {                       // runs after the 200 reply
  let id = null;
  for (let n = 0; n < 4 && !id; n++) { id = await KV.get("ref:g2:" + ref).catch(() => null); if (!id) await sleep(2000); }   // the callback can beat saveOrder by a moment
  if (!id) return;
  for (let i = 0; i < 3; i++) {
    await refreshOrder(env, id);
    const o = await KV.get("or:" + id, "json").catch(() => null);
    if (!o || o.status !== "processing") return;
    await sleep(3000);
  }                                                     // still Processing: the cron picks it up
}
async function g2Call(env, path, body, idem) {
  if (await g2Blocked()) return { res: { status: 401, ok: false }, data: { message: "G2Bulk API key မမှန်ပါ (401) — ခေါ်တာ ခဏရပ်ထားပါတယ်" } };
  let res, data;
  for (let n = 0; n < 3; n++) {
    res = await fetch(G2 + path, {
      method: "POST",
      headers: { "X-API-Key": env.G2BULK_KEY || "", "Content-Type": "application/json", ...(idem ? { "X-Idempotency-Key": idem } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
    });
    data = await res.json().catch(() => ({}));
    if (idem && n < 2 && (res.status === 429 || res.status >= 500)) { await sleep(800 * 2 ** n); continue; }   // same idempotency key: a retry can never charge twice
    break;
  }
  if (res.status === 401) await g2AuthFailed(env);
  return { res, data };
}
const errMsg = (d, res) => String(d.message || d.error || (d.detail && d.detail.message) || (typeof d.detail === "string" ? d.detail : "") || d.msg || `HTTP ${res.status}`);
function normServers(raw) {
  let r = raw;
  if (r && !Array.isArray(r)) r = r.servers || r.data || r.result || r.regions || r;
  const out = [];
  if (Array.isArray(r)) {
    r.forEach((x) => {
      if (x == null) return;
      if (typeof x === "object") {
        const v = x.value ?? x.server_id ?? x.serverId ?? x.id ?? x.code ?? x.key;
        const l = x.label ?? x.name ?? x.server_name ?? x.title ?? v;
        if (v != null && String(v) !== "") out.push({ value: String(v), label: String(l) });
      } else out.push({ value: String(x), label: String(x) });
    });
  } else if (r && typeof r === "object") {
    Object.keys(r).forEach((k) => { if (r[k] != null && typeof r[k] !== "object") out.push({ value: String(r[k]), label: String(k) }); });
  }
  return out;
}
const SRVC = new Map();
async function g2Servers(code) {
  const c = SRVC.get(code);
  if (c && Date.now() - c.t < 10 * 60 * 1000) return c.list;
  try {
    const res = await fetch(G2 + "/v1/games/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ game: code }), signal: AbortSignal.timeout(8000) });
    if (!res.ok) { if (res.status === 403) SRVC.set(code, { t: Date.now(), list: [] }); return []; }
    const list = normServers(await res.json().catch(() => null));
    SRVC.set(code, { t: Date.now(), list });
    return list;
  } catch { return []; }
}
async function resolveServers(entry) {
  const saved = normServers(entry.f.srvOpts);
  if (saved.length) return saved;
  return entry.f.g2code ? g2Servers(entry.f.g2code) : [];
}
async function checkPlayer(code, pid, sid, cname) {    // { outcome: valid | invalid | unknown, name, reason }
  let res;
  try {
    res = await fetch(G2 + "/v1/games/checkPlayerId", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: code, user_id: pid, server_id: sid || undefined, charname: cname || undefined }), signal: AbortSignal.timeout(15000),
    });
  } catch { return { outcome: "unknown" }; }
  const d = await res.json().catch(() => null);
  const msg = String((d && (d.message || d.error || d.detail || d.msg)) || "");
  const srv = /server|zone|region/i.test(msg);
  if (res.ok) return d && (d.valid === "valid" || d.valid === true) ? { outcome: "valid", name: d.name || "", raw: d } : { outcome: "invalid", reason: srv ? "server" : "id" };
  if (res.status === 400 && /required|missing|unsupported|not supported|unknown game|invalid game/i.test(msg)) return { outcome: "unknown" };
  if ([400, 404, 422].includes(res.status) || (res.status === 403 && srv)) return { outcome: "invalid", reason: srv ? "server" : "id" };
  return { outcome: "unknown" };
}

/* ----- what a game / package needs, and which provider buys it ----- */
function reqOf(entry) {
  const f = entry.f;
  const needsId = f.playerIdRequired === undefined || f.playerIdRequired === null ? !f.voucher : f.playerIdRequired !== false;
  return { needsId, needsServer: needsId && f.serverIdRequired !== false, needsChar: needsId && f.charNameRequired === true };
}
function providerOf(entry, pkg) {                       // same priority as the store's order payload
  const f = entry.f;
  if (pkg.g2bulk && f.g2code) return { key: "g2bulk", label: "G2Bulk", ok: true };
  if (pkg.voucherId) return { key: "voucher", label: "G2Bulk Voucher", ok: true };
  if (pkg.fazercardOfferId && f.fzCat) return { key: "fazercard", label: "FazerCards", ok: true };
  if (pkg.jcplays && f.jcplaysProduct) return { key: "jcplays", label: "JCPlays", ok: false, why: "JCPlays ကို bot က မခေါ်နိုင်သေးပါ — Admin Panel ကနေ လုပ်ပါ" };
  if (pkg.fazercardGiftCardId && f.fzGift) return { key: "fzgift", label: "FazerCards Gift", ok: false, why: "FazerCards Gift Card ကို bot က မခေါ်နိုင်သေးပါ — Admin Panel ကနေ လုပ်ပါ" };
  return { key: "none", label: "-", ok: false, why: "ဒီ package မှာ provider မသတ်မှတ်ရသေးပါ" };
}
const keyReady = (env, pv) => (pv.key === "fazercard" ? !!env.FAZERCARD_KEY : pv.key === "g2bulk" || pv.key === "voucher" ? !!env.G2BULK_KEY : false);
function ctxOf(store, ss) {
  const group = store.byId.get(ss.gid), entry = group && group.entries[ss.ei], pkg = entry && entry.packages[ss.pi];
  return { group, entry, pkg };
}

/* ----- views ----- */
function gameListView(store, kind, page) {
  const T = store.groups.filter((g) => g.kind === "t"), V = store.groups.filter((g) => g.kind === "v");
  if (kind !== "t" && kind !== "v") kind = T.length ? "t" : "v";
  if (kind === "t" && !T.length) kind = "v";
  const list = kind === "t" ? T : V;
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(0, page | 0), pages - 1);
  const rows = [];
  if (T.length && V.length) rows.push([btn(`💎 Top Up ${T.length}`, "zl:t:0", kind === "t" ? "success" : "primary"), btn(`🎟 Voucher ${V.length}`, "zl:v:0", kind === "v" ? "success" : "primary")]);
  const slice = list.slice(page * PAGE, page * PAGE + PAGE);
  for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2).map((g) => btn(g.name, `zg:${g.id}`, "primary")));
  if (pages > 1) rows.push(pagerRow(page, pages, (n) => `zl:${kind}:${n}`));
  rows.push([btn("❌ ပိတ်", "zq", "danger")]);
  return { text: stepBar(1) + `🛒 <b>Admin ဝယ်ယူရန်</b> — ${kind === "t" ? "💎 Top Up" : "🎟 Voucher"}\nGame ${list.length} ခု၊ ရွေးပါ 👇`, markup: { inline_keyboard: rows } };
}
function serverListView(group) {
  const rows = [];
  group.entries.forEach((e, i) => { const b = btn(e.server || "Default", `zs:${i}`, "primary"); if (i % 2 === 0) rows.push([b]); else rows[rows.length - 1].push(b); });
  rows.push([btn("⬅️ ပြန်သွားရန်", `zl:${group.kind}:0`), btn("❌ ပိတ်", "zq", "danger")]);
  return { text: stepBar(1) + `🎮 <b>${esc(group.name)}</b>\nServer ရွေးပါ 👇`, markup: { inline_keyboard: rows } };
}
function adminTabs(entry) {
  const seen = [];
  entry.packages.forEach((p) => { const t = tabOf(p); if (!seen.includes(t)) seen.push(t); });
  const order = ["currency", "package", ...seen.filter((t) => t !== "currency" && t !== "package")].filter((t) => seen.includes(t));
  const label = (t) => (t === "package" ? entry.labels.package || "Package" : t === "currency" ? entry.labels.currency || "Currency" : t);
  return order.map((t) => ({ label: label(t), idxs: entry.packages.map((_, i) => i).filter((i) => tabOf(entry.packages[i]) === t) }));
}
function pkgView(store, ss) {
  const { group, entry } = ctxOf(store, { ...ss, pi: 0 });
  if (!entry) return { text: "⚠️ Game မတွေ့တော့ပါ — 🛒 ဝယ်ယူရန် ကို ပြန်နှိပ်ပါ", markup: { inline_keyboard: [] } };
  const back = group.entries.length > 1 ? `zg:${group.id}` : `zl:${group.kind}:0`;
  const head = `🎮 <b>${esc(group.name)}</b>${entry.server ? ` · ${esc(entry.server)}` : ""}`;
  const tabs = adminTabs(entry);
  if (!tabs.length) return { text: `${head}\nPackage မရှိသေးပါ`, markup: { inline_keyboard: [[btn("⬅️ ပြန်သွားရန်", back)]] } };
  const ti = Math.min(Math.max(0, ss.tab | 0), tabs.length - 1), tab = tabs[ti];
  const pages = Math.max(1, Math.ceil(tab.idxs.length / PKG_PAGE));
  const page = Math.min(Math.max(0, ss.page | 0), pages - 1);
  const rows = [];
  if (tabs.length > 1) for (let i = 0; i < tabs.length; i += 3) rows.push(tabs.slice(i, i + 3).map((t, j) => btn(t.label, `zt:${i + j}:0`, i + j === ti ? "success" : "primary")));
  const slice = tab.idxs.slice(page * PKG_PAGE, page * PKG_PAGE + PKG_PAGE);
  for (let i = 0; i < slice.length; i += 2)
    rows.push(slice.slice(i, i + 2).map((pi) => {
      const p = entry.packages[pi];
      const mark = p.badge === "hot" ? " 🔥" : p.badge === "top" ? " ⭐" : "";
      const price = p.price === undefined || p.price === null || p.price === "" ? "-" : fmt(p.price);
      return btn(`${p.amount ?? "-"}${mark} · ${price}`, `zp:${pi}`, "primary");
    }));
  if (pages > 1) rows.push(pagerRow(page, pages, (n) => `zt:${ti}:${n}`));
  rows.push([btn("⬅️ ပြန်သွားရန်", back), btn("📊 Table", "zm"), btn("❌ ပိတ်", "zq", "danger")]);
  return { text: stepBar(2) + `${head}\n📦 Package ရွေးပါ 👇  (ခလုတ်ထဲက ဈေး = MMK)`, markup: { inline_keyboard: rows } };
}
const STEPS = ["Game", "Package", "ID", "Confirm"];
const stepBar = (n) => STEPS.map((x, i) => (i + 1 === n ? `▶️ <b>${x}</b>` : i + 1 < n ? `✅ ${x}` : `▫️ ${x}`)).join("  ") + "\n\n";   // where the admin is in the order
const summary = (ss) => `🎮 ${esc(ss.title)}\n📦 ${esc(ss.amount)} · <b>${fmt(ss.price)} MMK</b>`;
const flowRow = (...extra) => [...extra, btn("❌ Cancel", "zx", "danger")];
function idPrompt(ss) {
  const err = ss.err ? `⚠️ ${esc(ss.err)}\n\n` : "";
  let body;
  if (ss.srvMode === "text") {
    body = "🆔 <b>Player ID နဲ့ Server ID ပို့ပါ</b>\n\n" + summary(ss) + "\n\n" +
      "ID နဲ့ Server ID ကို <b>message တစ်ခုတည်း</b>မှာ ပို့ပါ။ နှစ်ခုကြားမှာ ခြားတာတစ်ခုခု <b>ထည့်ပေးရပါမယ်</b>။ space ၊ ကော်မာ ၊ ကွင်း ၊ ဆက်တိုက်မျဉ်း (-) စတဲ့ သင်္ကေတ ဘာဖြစ်ဖြစ် ရပါတယ်။\n\n" +
      "✅ ရတဲ့ပုံစံများ\n<code>123456789(2001)</code>\n<code>123456789 2001</code>\n<code>123456789,2001</code>\n<code>123456789-2001</code>\n\n" +
      "❌ မရတဲ့ပုံစံ\n<code>1234567892001</code>\nဆက်ရေးထားရင် ID ဘယ်မှာဆုံးပြီး Server ဘယ်မှာစလဲ bot က ခွဲမသိနိုင်ပါဘူး။";
  } else if (ss.srvMode === "select") {
    body = "🆔 <b>Player ID ပို့ပါ</b>\n\n" + summary(ss) + "\n\nPlayer ID ကိုပဲ message အနေနဲ့ ပို့ပါ။ ID ရပြီးတာနဲ့ <b>Server စာရင်း</b> ကျလာမယ်၊ အဲဒီမှာ ရွေးပါ။\n" +
      "ဥပမာ - <code>123456789</code>\n(<code>123456789(2001)</code> လို့ ရေးရင် ကိုက်တဲ့ Server ကို အလိုလို ရွေးပေးပါမယ်)";
  } else {
    body = "🆔 <b>Player ID ပို့ပါ</b>\n\n" + summary(ss) + "\n\nPlayer ID ကို message အနေနဲ့ ရိုက်ပို့ပါ။\nဥပမာ - <code>123456789</code>";
  }
  return { text: stepBar(3) + err + body, markup: { inline_keyboard: [flowRow(btn("⬅️ Package များ", "zbp"))] } };
}
const charPrompt = (ss) => ({ text: stepBar(3) + `👤 <b>Character Name ပို့ပါ</b>\n\n${summary(ss)}\n🆔 ID: <code>${esc(ss.pid)}</code>\n\nဒီ game က Character Name လိုပါတယ်။ ရိုက်ပို့ပါ။`, markup: { inline_keyboard: [flowRow(btn("✏️ ID ပြင်", "zi"))] } });
function srvSelectView(ss) {
  const opts = ss.srvOpts || [];
  const pages = Math.max(1, Math.ceil(opts.length / SRV_PAGE));
  const page = Math.min(Math.max(0, ss.spage | 0), pages - 1);
  const rows = [];
  const slice = opts.slice(page * SRV_PAGE, page * SRV_PAGE + SRV_PAGE);
  for (let i = 0; i < slice.length; i += 2) rows.push(slice.slice(i, i + 2).map((o, j) => btn(o[1], `zv:${page * SRV_PAGE + i + j}`, "primary")));
  if (pages > 1) rows.push(pagerRow(page, pages, (n) => `zw:${n}`));
  rows.push(flowRow(btn("✏️ ID ပြင်", "zi")));
  return { text: stepBar(3) + `🖥 <b>Server ရွေးပါ</b>\n\n${summary(ss)}\n🆔 ID: <code>${esc(ss.pid)}</code>`, markup: { inline_keyboard: rows } };
}
function detailView(env, store, ss) {
  const { entry, pkg } = ctxOf(store, ss);
  const pv = providerOf(entry, pkg);
  const ready = pv.ok && keyReady(env, pv);
  const blocker = ready ? "" : pv.why || (pv.key === "fazercard" ? "FAZERCARD_KEY secret မထည့်ရသေးပါ" : "G2BULK_KEY secret မထည့်ရသေးပါ");
  const text = tplOut("detail", detailVars(ss, pv.label, blocker));
  const rows = [];
  if (ready) rows.push([btn("✅ Confirm", "zc", "success")]);
  rows.push([btn(ss.pid ? "✏️ ID ပြင်" : "⬅️ Package များ", ss.pid ? "zi" : "zbp"), btn("❌ Cancel", "zx", "danger")]);
  return { text, markup: { inline_keyboard: rows } };
}
function detailVars(ss, provider, blocker) {
  const sname = ss.sname && ss.sname !== ss.sid ? esc(ss.sname) : "";
  return {
    title: esc(ss.title || ""), amount: esc(ss.amount || ""), price: fmt(ss.price), pid: esc(ss.pid || ""), sid: esc(ss.sid || ""), sname,
    serverid: ss.sid ? `<code>${esc(ss.sid)}</code>${sname ? ` (${sname})` : ""}` : "", cname: esc(ss.cname || ""), pname: esc(ss.pname || ""),
    provider: esc(provider || ""), warn: esc(ss.warn || ""), blocker: esc(blocker || ""),
    hint: blocker ? "" : "👇 အားလုံးမှန်ရင် ✅ Confirm နှိပ်ပါ",
  };
}
async function show(env, chat, ss, v) {
  if (ss.mid) {
    const r = await tg(env, "editMessageText", { chat_id: chat, message_id: ss.mid, text: v.text, parse_mode: "HTML", reply_markup: v.markup, disable_web_page_preview: true }).catch(() => null);
    if (r?.ok || /not modified/i.test(r?.description || "")) return;
  }
  const r = await send(env, chat, v.text, { reply_markup: v.markup, disable_web_page_preview: true, ...replyTo(ss.rt) });
  ss.mid = r?.result?.message_id || 0;
}

/* ----- flow control ----- */
async function adminStart(env, uid, src) {              // sends the game list to the admin's private chat; false = could not DM
  const store = await loadStore(env);
  if (!store.groups) { const r = await send(env, uid, "⚠️ Store data မရနိုင်သေးပါ၊ ခဏနေ ပြန်စမ်းပါ။"); return !!r?.ok; }
  const v = gameListView(store, "", 0);
  const r = await send(env, uid, v.text, { reply_markup: v.markup });
  if (!r?.ok) return false;
  await putSS(uid, { step: "list", src: src || "", mid: r.result.message_id, chat: uid });
  return true;
}
async function advance(env, chat, ss, store) {          // go to whatever the order still needs next
  const { entry, pkg } = ctxOf(store, ss);
  if (!entry || !pkg) { ss.step = "list"; return show(env, chat, ss, { text: "⚠️ Package မတွေ့တော့ပါ — 🛒 ဝယ်ယူရန် ကို ပြန်နှိပ်ပါ", markup: { inline_keyboard: [] } }); }
  const rq = reqOf(entry), pv = providerOf(entry, pkg);
  if (rq.needsId && !ss.pid) { ss.step = "id"; return show(env, chat, ss, idPrompt(ss)); }
  if (rq.needsServer && ss.srvMode === "text" && !ss.sid) { ss.step = "id"; ss.pid = ""; ss.err = "Server ID မပါပါ — ID နဲ့ Server ကို တစ်ပါတည်း ပြန်ပို့ပါ"; return show(env, chat, ss, idPrompt(ss)); }
  if (rq.needsServer && ss.srvMode === "select" && !ss.sid) { ss.step = "srv"; return show(env, chat, ss, srvSelectView(ss)); }
  if (rq.needsChar && !ss.cname) { ss.step = "char"; return show(env, chat, ss, charPrompt(ss)); }
  ss.pname = ""; ss.warn = "";
  if (rq.needsId && pv.key === "g2bulk" && entry.f.idCheck) {
    ss.step = "check";
    await show(env, chat, ss, { text: "🔎 <b>Player ID စစ်နေပါတယ်...</b>\n\n" + summary(ss) + `\n🆔 <code>${esc(ss.pid)}</code>${ss.sid ? ` (${esc(ss.sid)})` : ""}`, markup: { inline_keyboard: [] } });
    const r = await checkPlayer(entry.f.idCheck, ss.pid, ss.sid, ss.cname);
    if (r.outcome === "invalid") {
      ss.step = "id"; ss.pid = ""; ss.sid = ""; ss.sname = "";
      ss.err = r.reason === "server" ? "Server ID မကိုက်ပါ — ID နဲ့ Server ပြန်စစ်ပြီး ပြန်ပို့ပါ" : "ဒီ Player ID ကို မတွေ့ပါ — ပြန်စစ်ပြီး ပြန်ပို့ပါ";
      return show(env, chat, ss, idPrompt(ss));
    }
    if (r.outcome === "valid") ss.pname = r.name || "";
    else ss.warn = "ID ကို စစ်မရနိုင်ပါ (G2Bulk မတုံ့ပြန်) — ID ကို ကိုယ်တိုင်သေချာစစ်ပြီးမှ Confirm နှိပ်ပါ";
  }
  ss.step = "detail"; ss.err = "";
  return show(env, chat, ss, detailView(env, store, ss));
}
async function pickPackage(env, chat, ss, store, pi, pre) {
  const { group, entry } = ctxOf(store, ss);
  const pkg = entry && entry.packages[pi];
  if (!pkg) return false;
  ss.pi = pi; ss.title = group.name + (entry.server ? ` · ${entry.server}` : ""); ss.amount = String(pkg.amount ?? "-"); ss.price = Number(pkg.price) || 0;
  ss.pid = ""; ss.sid = ""; ss.sname = ""; ss.cname = ""; ss.pname = ""; ss.err = ""; ss.warn = ""; ss.srvOpts = null; ss.spage = 0;
  if (pre) { ss.pid = pre.pid || ""; ss.sid = pre.sid || ""; }
  const rq = reqOf(entry);
  ss.srvMode = "none";
  if (rq.needsServer) {
    const opts = await resolveServers(entry);
    if (opts.length) { ss.srvMode = "select"; ss.srvOpts = opts.map((o) => [o.value, o.label]); } else ss.srvMode = "text";
  }
  if (pre) {                                            // quick order: keep the typed server only when this game really takes it
    if (!rq.needsServer) ss.sid = "";
    else if (ss.srvMode === "select" && ss.sid) { const o = ss.srvOpts.find((x) => String(x[0]) === ss.sid); if (o) ss.sname = o[1]; else ss.sid = ""; }
  }
  await advance(env, chat, ss, store);
  return true;
}
function parseId(text, mode, opts) {
  const tk = String(text).split(/[^A-Za-z0-9_]+/).filter(Boolean);
  if (!tk.length) return { err: "ID မတွေ့ပါ — ဂဏန်း/စာလုံး ပါအောင် ပို့ပါ" };
  if (mode === "text") {
    if (tk.length < 2) return { err: "Server ID မပါပါ — ID နဲ့ Server ကြား ခြားပေးပါ (ဥပမာ 123456789(2001) သို့ 123456789 2001)" };
    if (tk.length > 2) return { err: "ID နဲ့ Server ID နှစ်ခုပဲ ပို့ပါ" };
    return { id: tk[0], sid: tk[1] };
  }
  if (tk.length > 2) return { err: "ID တစ်ခုတည်းပဲ ပို့ပါ" };
  if (mode === "select") { const r = { id: tk[0] }; const o = tk[1] && (opts || []).find((x) => x[0] === tk[1]); if (o) { r.sid = o[0]; r.sname = o[1]; } return r; }
  if (tk.length > 1) return { err: "ID တစ်ခုတည်းပဲ ပို့ပါ" };
  return { id: tk[0] };
}
async function adminText(env, m) {                      // admin typed the Player ID / Character Name; false = not waiting for text
  const uid = m.from.id, chat = m.chat.id;
  const ss = await getSS(uid);
  if (!ss || !["id", "char"].includes(ss.step)) return false;
  if (ss.chat && ss.chat !== chat) return false;
  const store = await loadStore(env);
  if (!store.groups) return false;
  const t = String(m.text || "").trim();
  delMsg(env, chat, m.message_id);
  if (ss.step === "id") {
    const r = parseId(t, ss.srvMode, ss.srvOpts);
    if (r.err) { ss.err = r.err; await show(env, chat, ss, idPrompt(ss)); await putSS(uid, ss); return true; }
    ss.pid = r.id; ss.sid = r.sid || ""; ss.sname = r.sname || ""; ss.err = "";
  } else ss.cname = cut(t, 40);
  await advance(env, chat, ss, store);
  await putSS(uid, ss);
  return true;
}


/* ----- quick order: the admin types "ID + amount"  (123456789 2001 86  /  123456789(2001) wp  /  123456789 wp) ----- */
const Q_FILLER = new Set(["dia", "dias", "diamond", "diamonds", "dmd", "ဒိုင်ယာ", "x", "pcs", "mmk"]);
const Q_SPLIT = /[^\p{L}\p{M}\p{N}]+/u;
function amtTokens(s) {                                 // "86 Diamonds" -> ["86"],  "Weekly Pass" / "wp" -> ["wp"],  "2wp" -> ["2","wp"]
  return String(s ?? "").toLowerCase()
    .replace(/^\s*(\d{1,4})\s*\+\s*\d{1,4}/, "$1 dd")                       // double-diamond package "50+50 Diamonds" -> ["50","dd"]  (typed "50+" gives the same)
    .replace(/weekly\s*diamond\s*pass|weekly\s*pass|\bwkp\b/g, "wp")
    .replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2")
    .split(Q_SPLIT).filter((x) => x && !Q_FILLER.has(x));
}
const pkgInit = (s) => String(s ?? "").toLowerCase().replace(/[^a-z\s]+/g, " ").split(/\s+/).filter((w) => w && !Q_FILLER.has(w)).map((w) => w[0]).join("");   // "Monthly Elite Bundle" -> "meb", "Weekly Pass" -> "wp"
function parseQuick(text) {                             // -> { id, rest[] } or null (not an order-looking message)
  const t = String(text || "").trim();
  if (!t || t.length > 80 || t.startsWith("/")) return null;
  const tk = t.toLowerCase().split(Q_SPLIT).filter(Boolean);
  const i = tk.findIndex((x) => /^\d{5,14}$/.test(x) && !/^09\d{7,9}$/.test(x));   // first long number = Player ID (phone numbers skipped)
  if (i < 0) return null;
  const rest = tk.filter((_, j) => j !== i);
  return rest.length ? { id: tk[i], rest } : null;
}
function quickMatches(pool, pq) {                       // every (game, server, package) whose amount fits what was typed
  const exact = [], loose = [];
  for (const group of pool) group.entries.forEach((entry, ei) => {
    const tries = [];
    if (reqOf(entry).needsServer && pq.rest.length > 1 && /^\d+$/.test(pq.rest[0])) tries.push({ sid: pq.rest[0], amt: pq.rest.slice(1) });
    tries.push({ sid: "", amt: pq.rest });
    for (const tr of tries) {
      const want = amtTokens(tr.amt.join(" "));
      if (!want.length) continue;
      const key = [...want].sort().join(" "), numeric = want.every((x) => /^\d+$/.test(x));
      let found = false;
      entry.packages.forEach((p, pi) => {
        const have = amtTokens(p.amount);
        if (!have.length) return;
        if ([...have].sort().join(" ") === key) { exact.push({ group, ei, pi, sid: tr.sid }); found = true; }
        else if (want.length === 1 && /^[a-z]{2,6}$/.test(want[0]) && pkgInit(p.amount) === want[0]) { exact.push({ group, ei, pi, sid: tr.sid }); found = true; }   // initials: meb = Monthly Elite Bundle
        else if (!numeric && want.every((x) => have.includes(x))) loose.push({ group, ei, pi, sid: tr.sid });
      });
      if (found) break;
    }
  });
  const seen = new Set();
  return (exact.length ? exact : loose).filter((h) => { const k = h.group.id + "|" + h.ei + "|" + h.pi; if (seen.has(k)) return false; seen.add(k); return true; });
}
async function quickOrder(env, m, inGroup) {            // true = the message was an order and has been answered
  const uid = m.from?.id, chat = m.chat.id;
  const pq = uid ? parseQuick(m.text) : null;
  if (!pq) return false;
  const store = await loadStore(env);
  if (!store.groups) return false;
  let pool = store.groups;
  if (inGroup) { const al = await getAllowed(chat); pool = pool.filter((g) => al.includes(g.key)); if (!pool.length) return false; }   // a group only handles the games set for it
  const hits = quickMatches(pool, pq);
  if (!hits.length) {
    if (!(inGroup && pq.rest.length <= 3 && pq.rest.some((x) => /^\d{1,5}$/.test(x) || /^(wp|dias?)$/.test(x)))) return false;
    const r = await send(env, chat, "⚠️ <b>Package မတွေ့ပါ</b>\nAmount ကို ပြန်စစ်ပါ — ဥပမာ <code>123456789 2001 86</code> သို့ <code>123456789 wp</code>", replyTo(m.message_id));
    await scheduleDelete(env, chat, r?.result?.message_id, 20 * 1000);
    return true;
  }
  const ss = { step: "detail", src: inGroup ? String(m.chat.title || "") : "", chat, rt: m.message_id, mid: 0 };
  if (hits.length > 1) {                                // same amount in several games / servers: let the admin pick
    const list = hits.slice(0, 8);
    ss.step = "pickq"; ss.qpid = pq.id; ss.cands = list.map((h) => ({ gid: h.group.id, ei: h.ei, pi: h.pi, sid: h.sid }));
    const rows = list.map((h, i) => { const e = h.group.entries[h.ei], p = e.packages[h.pi]; return [btn(`${h.group.name}${e.server ? " · " + e.server : ""} · ${p.amount ?? "-"} · ${fmt(p.price)}`, `zk:${i}`, "primary")]; });
    rows.push([btn("❌ Cancel", "zx", "danger")]);
    await show(env, chat, ss, { text: `🔎 <b>ကိုက်တာ ${hits.length} ခု တွေ့ပါတယ်</b>\n🆔 <code>${esc(pq.id)}</code>\nရွေးပါ 👇`, markup: { inline_keyboard: rows } });
    await putSS(uid, ss);
    return true;
  }
  const h = hits[0];
  ss.gid = h.group.id; ss.ei = h.ei; ss.tab = 0; ss.page = 0;
  await pickPackage(env, chat, ss, store, h.pi, { pid: pq.id, sid: h.sid });
  await putSS(uid, ss);
  return true;
}
/* ----- AUTO BUY: "abbr ID [server] package [xN]"  — Admin only, no Confirm step -----
   ml 1159045022 13678 86            one order
   ml 1159045022 13678 86 x3         the same package 3 times
   ml 1159045022 13678 86 & wp x2    several packages for one ID  ( & between them )
   several lines = several IDs (a line without the abbreviation uses the one above).
   Everything is checked first: if ONE line is wrong nothing is bought and the card says which line. */
const initials = (n) => String(n).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w[0]).join("");
async function abbrMap(store) {                          // alias -> game   (initials of the name; the owner's /abbr aliases win)
  const custom = (await KV.get("abbr:all", "json").catch(() => null)) || {};
  const auto = new Map(), out = new Map();
  for (const g of store.groups) { const i = initials(g.name); if (i.length >= 2) auto.set(i, [...(auto.get(i) || []), g]); }
  for (const [a, l] of auto) if (l.length === 1) out.set(a, l[0]);          // two games with the same initials: neither is used, set one with /abbr
  for (const [a, key] of Object.entries(custom)) { const g = store.groups.find((x) => x.key === key); if (g) out.set(a, g); }
  return out;
}
async function abbrCommand(env, chat, t) {               // owner: /abbr  |  /abbr ml = mobile legends  |  /abbr del ml
  const store = await loadStore(env);
  if (!store.groups) return send(env, chat, "⚠ Store data မရနိုင်သေးပါ");
  const body = t.replace(/^\/abbr(@\w+)?/i, "").trim();
  const custom = (await KV.get("abbr:all", "json").catch(() => null)) || {};
  const save = () => (Object.keys(custom).length ? KV.put("abbr:all", JSON.stringify(custom)) : KV.delete("abbr:all"));
  let mm;
  if ((mm = body.match(/^del\s+(\S+)$/i))) { delete custom[mm[1].toLowerCase()]; await save(); return send(env, chat, `ဖျက်ပြီး — <code>${esc(mm[1])}</code>`); }
  if ((mm = body.match(/^(\S+)\s*=\s*(.+)$/))) {
    const a = mm[1].toLowerCase(), q = mm[2].trim().toLowerCase();
    if (!/^[\p{L}\p{N}_.-]{1,12}$/u.test(a) || /^\d{5,}$/.test(a) || a === "x") return send(env, chat, "အတိုကောက်က စာလုံး/ဂဏန်း ၁၂ လုံးအထိ (ID လို ဂဏန်းရှည် မဖြစ်ရ)");
    const c = store.groups.filter((g) => g.key.includes(q)), ex = c.filter((g) => g.key === q), pick = ex.length ? ex : c;
    if (pick.length !== 1) return send(env, chat, pick.length ? "ကိုက်တာ များနေ — နာမည်ပိုပြည့်အောင် ရေးပါ\n" + pick.slice(0, 8).map((g) => "• " + esc(g.name)).join("\n") : "Game မတွေ့ပါ");
    custom[a] = pick[0].key; await save();
    return send(env, chat, `<code>${esc(a)}</code>  =  <b>${esc(pick[0].name)}</b>`);
  }
  const by = new Map();
  for (const [a, g] of await abbrMap(store)) by.set(g, [...(by.get(g) || []), a]);
  const rows = store.groups.map((g) => `<b>${esc(g.name)}</b>  ${by.get(g) ? by.get(g).map((a) => `<code>${esc(a)}</code>`).join(" ") : "—"}`);
  return send(env, chat, cut("<b>Game အတိုကောက်များ</b>\n" + LINE + "\n" + rows.join("\n") + "\n" + LINE + "\nသတ်မှတ် — <code>/abbr ml = mobile legends</code>\nဖျက် — <code>/abbr del ml</code>", 3900));
}
async function g2Balance(env) {                          // USD balance of the G2Bulk API account, null when it cannot be read
  if (!env.G2BULK_KEY || (await g2Blocked())) return null;
  try {
    const r = await fetch(G2 + "/v1/getMe", { headers: { "X-API-Key": env.G2BULK_KEY }, signal: AbortSignal.timeout(8000) });
    if (r.status === 401) { await g2AuthFailed(env); return null; }
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const n = Number(d.balance ?? d.data?.balance ?? d.user?.balance);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
async function markBalance(env, o, pre) {                // under LOWBAL_USD -> the order card carries the warning
  if (!/^(g2bulk|voucher)$/.test(o.provider)) return;
  const b = pre !== undefined ? pre : await g2Balance(env);
  if (b !== null && b < LOWBAL_USD) o.lowbal = b;
}
async function sendBalance(env, chat) {
  const b = await g2Balance(env);
  return send(env, chat, b === null ? "<b>API Balance</b> မရနိုင်ပါ — G2BULK_KEY စစ်ပါ" : `<b>API Balance</b>  <code>${b.toFixed(2)} USD</code>` + (b < LOWBAL_USD ? `\n⚠ ${LOWBAL_USD} USD အောက်ရောက်နေပါပြီ — ဖြည့်ပါ` : ""));
}
async function watchBalance(env) {                       // low balance (once) and \"Successfully Deposit\" -> owners / LOG_CHAT_ID
  if (!KV || !env.G2BULK_KEY) return;
  const b = await g2Balance(env);
  if (b === null) return;
  const prev = await KV.get("bal:g2", "json").catch(() => null);
  await KV.put("bal:g2", JSON.stringify({ v: b, t: Date.now() })).catch(() => {});
  const to = new Set([...idList(env.OWNER_IDS), ...idList(env.LOG_CHAT_ID)]);
  const tell = async (text) => { for (const id of to) await send(env, id, text).catch(() => {}); };
  const min = Number(env.DEPOSIT_MIN_USD) > 0 ? Number(env.DEPOSIT_MIN_USD) : 1;
  if (prev && b - prev.v >= min && !(await KV.get("bal:refund").catch(() => null))) {
    await tell(`<b>Successfully Deposit</b>\n${LINE}\n<code>Added   </code> <b>+${(b - prev.v).toFixed(2)} USD</b>\n<code>Balance </code> <b>${b.toFixed(2)} USD</b>` + (b < LOWBAL_USD ? `\n\n⚠ ${LOWBAL_USD} USD အောက်ပဲ ရှိသေးပါတယ် — ထပ်ဖြည့်ပါ` : ""));
  }
  const low = await KV.get("bal:low").catch(() => null);
  if (b < LOWBAL_USD && !low) {
    await KV.put("bal:low", "1").catch(() => {});
    await tell(`<b>⚠ API Balance နည်းနေပါပြီ</b>\n${LINE}\n<code>Balance </code> <b>${b.toFixed(2)} USD</b>\n<code>Limit   </code> ${LOWBAL_USD} USD\nအမြန်ဖြည့်ပါ`);
  } else if (b >= LOWBAL_USD && low) await KV.delete("bal:low").catch(() => {});
}
function parseBuyLine(line, aliases, prev) {             // -> { g, pid, segs:[{tk,qty}] } | null (not an order)
  let t = String(line).toLowerCase().replace(/[×*]/g, "x").trim();
  t = t.replace(/(\d{1,4})\s*\+\s*(?:\d{1,4})?(?=\s|$|&|\/|x\d)/g, "$1 dd");   // "50+" (double diamond) -> "50 dd"
  const m = t.match(/^([\p{L}\p{N}_.-]+)\s+([\s\S]+)$/u);
  let g;
  if (m && aliases.has(m[1])) { g = aliases.get(m[1]); t = m[2]; } else if (prev) g = prev; else return null;
  const segs = t.split(/\s*[&\/]\s*/).map((x) => {        // packages are separated by "/" (or "&")
    let qty = 1; const q = x.match(/\s*x\s*(\d{1,3})\s*$/);
    if (q) { qty = Number(q[1]); x = x.slice(0, q.index); }
    const tk = x.split(Q_SPLIT).filter(Boolean), n = tk.length;
    if (qty === 1 && n) {                                  // "wp2" / "wp 2" = 2 weekly passes
      const g = tk[n - 1].match(/^([a-z]{2,6})(\d{1,2})$/);
      if (g && g[1] !== "dd") { tk[n - 1] = g[1]; qty = Number(g[2]); }
      else if (n >= 2 && /^\d{1,2}$/.test(tk[n - 1]) && /^[a-z]{2,6}$/.test(tk[n - 2]) && tk[n - 2] !== "dd") { qty = Number(tk.pop()); }
    }
    return { tk, qty };
  });
  const i = segs[0].tk.findIndex((x) => /^\d{5,14}$/.test(x) && !/^09\d{7,9}$/.test(x));
  if (i < 0) return null;
  const pid = segs[0].tk[i];
  segs[0].tk = segs[0].tk.filter((_, j) => j !== i);
  return { g, pid, segs };
}
async function autoBuy(env, m, inGroup) {                // true = the message was an order (bought or refused with a reason)
  const uid = m.from?.id, chat = m.chat.id, text = String(m.text || "").trim();
  if (!uid || !text || text.length > 800 || text.startsWith("/")) return false;
  const store = await loadStore(env);
  if (!store.groups) return false;
  let pool = store.groups;
  if (inGroup) { const al = await getAllowed(chat); pool = pool.filter((g) => al.includes(g.key)); if (!pool.length) return false; }
  const aliases = await abbrMap({ groups: pool });
  const lines = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const first = parseBuyLine(lines[0], aliases, null);
  if (!first) return false;                              // no abbreviation / no ID: not an order
  if (lines.length === 1 && first.segs.length === 1 && first.segs[0].qty === 1) {      // "abbr ID [server]" with no package = status check, nothing is bought
    const r0 = first.segs[0].tk;
    if (!r0.length || (r0.length === 1 && /^\d{2,7}$/.test(r0[0]) && !quickMatches([first.g], { id: first.pid, rest: r0 }).length)) return statusCard(env, m, inGroup, first.g, first.pid, r0[0] || "");
  }
  const dk = "bt:" + chat + ":" + m.message_id;          // Telegram re-delivering the same message must never buy twice
  if (await KV.get(dk).catch(() => null)) return true;
  await KV.put(dk, "1", { expirationTtl: 3600 }).catch(() => {});
  const errs = [], units = [];
  const fail = (line, msg) => errs.push({ line, msg });
  if (lines.length > BATCH_MAX) fail("-", `တစ်ခါပို့ရင် စာကြောင်း ${BATCH_MAX} ကြောင်းထိပဲ`);
  let prev = null;
  for (const ln of lines.slice(0, BATCH_MAX)) {
    const p = ln === lines[0] ? first : parseBuyLine(ln, aliases, prev);
    if (!p) { fail(ln, "Game အတိုကောက် / Player ID မမှန်ပါ"); continue; }
    prev = p.g;
    let sid = "";
    for (let k = 0; k < p.segs.length; k++) {
      const sg = p.segs[k];
      if (sg.qty < 1 || sg.qty > QTY_MAX) { fail(ln, `အရေအတွက် 1–${QTY_MAX} ပဲ ရပါမယ်`); continue; }
      const rest = k === 0 ? sg.tk : sid ? [sid, ...sg.tk] : sg.tk;
      if (!rest.length) { fail(ln, "Package မပါပါ"); continue; }
      const hits = quickMatches([p.g], { id: p.pid, rest });
      if (hits.length !== 1) { fail(ln, hits.length ? `Package ${hits.length} ခု ကိုက်နေ — ပိုတိကျအောင် ရေးပါ (သို့ 🛒 ခလုတ်သုံးပါ)` : "Package မတွေ့ပါ — ရတာ: " + [...new Set(p.g.entries.flatMap((e) => e.packages.map((x) => String(x.amount ?? "")).filter(Boolean)))].slice(0, 14).join(" · ")); continue; }
      const h = hits[0], entry = h.group.entries[h.ei], pkg = entry.packages[h.pi], rq = reqOf(entry), pv = providerOf(entry, pkg);
      if (k === 0) sid = h.sid;
      if (!pv.ok || !keyReady(env, pv)) { fail(ln, pv.why || "Provider key မထည့်ရသေးပါ"); continue; }
      if (rq.needsChar) { fail(ln, "Character Name လိုတဲ့ game — 🛒 ခလုတ်နဲ့ ဝယ်ပါ"); continue; }
      let s = h.sid, sname = "";
      if (rq.needsServer) {
        if (!s) { fail(ln, "Server ID မပါပါ"); continue; }
        const opts = await resolveServers(entry);
        if (opts.length) { const o = opts.find((x) => String(x.value) === s); if (!o) { fail(ln, "Server ID မကိုက်ပါ"); continue; } sname = o.label; }
      } else s = "";
      const u = { line: ln, group: p.g, entry, pkg, pv, pid: p.pid, sid: s, sname, pname: "" };
      for (let n = 0; n < sg.qty; n++) units.push(u);
    }
  }
  if (units.length > BATCH_MAX) fail("-", `Order စုစုပေါင်း ${units.length} ခု — ${BATCH_MAX} ခုထိပဲ ရပါမယ်`);
  if (!errs.length) {                                    // ID check once per player
    const uniq = [...new Set(units)], checks = new Map();
    for (const u of uniq) if (reqOf(u.entry).needsId && u.pv.key === "g2bulk" && u.entry.f.idCheck) {
      const k = [u.entry.f.idCheck, u.pid, u.sid].join("|");
      if (!checks.has(k)) checks.set(k, checkPlayer(u.entry.f.idCheck, u.pid, u.sid, ""));
    }
    const res = new Map(await Promise.all([...checks].map(async ([k, pr]) => [k, await pr])));
    for (const u of uniq) {
      const r = res.get([u.entry.f.idCheck, u.pid, u.sid].join("|"));
      if (!r) continue;
      if (r.outcome === "invalid") fail(u.line, r.reason === "server" ? "Server ID မကိုက်ပါ" : "ဒီ Player ID ကို မတွေ့ပါ");
      else if (r.outcome === "unknown" && env.AUTO_BUY_UNCHECKED !== "1") fail(u.line, "ID စစ်မရပါ (G2Bulk မတုံ့ပြန်) — ခဏနေ ပြန်ပို့ပါ");
      else if (r.outcome === "valid") u.pname = r.name || "";
    }
  }
  const rt = replyTo(m.message_id);
  if (errs.length) {
    const r = await send(env, chat, "<b>✗ မဝယ်ရသေးပါ</b> — ဘာမှ မဖြတ်ရသေးပါ\n" + LINE + "\n" + errs.map((e) => `<code>${esc(cut(e.line, 60))}</code>\n${esc(e.msg)}`).join("\n\n") + "\n" + LINE + "\nပြင်ပြီး ပြန်ပို့ပါ", rt);
    if (inGroup) await scheduleDelete(env, chat, r?.result?.message_id, 90 * 1000);
    return true;
  }
  const bal = units.some((u) => /^(g2bulk|voucher)$/.test(u.pv.key)) ? await g2Balance(env) : null;
  if (bal !== null && bal <= 0) { await send(env, chat, `<b>✗ မဝယ်ရသေးပါ</b>\nAPI Balance မရှိတော့ပါ (<code>${bal.toFixed(2)} USD</code>) — အရင်ဖြည့်ပါ`, rt); return true; }
  const f = m.from, by = [f.first_name, f.last_name].filter(Boolean).join(" ") || f.username || String(uid);
  const head = units.length > 1 ? await send(env, chat, `<b>Batch</b>  ${units.length} orders\n${LINE}\n<code>Total  </code> <b>${fmt(units.reduce((n, u) => n + (Number(u.pkg.price) || 0), 0))} MMK</b>`, rt) : null;
  const list = [];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const o = {
      id: "A" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
      idem: await idemKey(uid, { mid: m.message_id + "#" + i, gid: u.group.id, ei: 0, pi: u.entry.packages.indexOf(u.pkg), pid: u.pid, sid: u.sid, cname: u.entry.id, price: u.pkg.price }),
      uid, by, src: inGroup ? String(m.chat.title || "") : "", chat, game: u.group.name, server: u.entry.server, amount: String(u.pkg.amount ?? "-"), price: Number(u.pkg.price) || 0,
      pid: u.pid, sid: u.sid, sname: u.sname, cname: "", pname: u.pname, provider: u.pv.key, plabel: u.pv.label, status: "placing", ref: "", at: Date.now(),
    };
    const r = await send(env, chat, orderText(o), { reply_markup: orderMarkup(o), disable_web_page_preview: true, ...(units.length === 1 ? rt : {}) });
    o.mid = r?.result?.message_id || 0;
    await saveOrder(o);                                  // written BEFORE the provider is called
    list.push({ o, u });
  }
  for (let i = 0; i < list.length; i += 4)               // 4 at a time
    await Promise.all(list.slice(i, i + 4).map(async ({ o, u }) => {
      Object.assign(o, await fulfill(env, o, u.entry, u.pkg));
      await markBalance(env, o, bal);
      await saveOrder(o);
      await renderOrder(env, o);
    }));
  if (head?.result?.message_id) {                        // the batch header turns into the result summary
    const n = (st) => list.filter(({ o }) => o.status === st).length, done = n("completed"), bad = n("failed"), unk = n("unknown"), open = list.length - done - bad - unk;
    const paid = list.filter(({ o }) => o.status !== "failed").reduce((t, { o }) => t + (Number(o.price) || 0), 0);
    const rows = [`<code>Done   </code> ✓ ${done}`, open ? `<code>Open   </code> ◌ ${open}` : "", bad ? `<code>Failed </code> ✗ ${bad}` : "", unk ? `<code>Unknown</code> ! ${unk}` : ""].filter(Boolean);
    await tg(env, "editMessageText", { chat_id: chat, message_id: head.result.message_id, parse_mode: "HTML", text: `<b>Batch</b>  ${units.length} orders\n${LINE}\n${rows.join("\n")}\n${LINE}\n<code>Total  </code> <b>${fmt(paid)} MMK</b>` }).catch(() => {});
  }
  await watchBalance(env).catch(() => {});               // balance moved: low-balance alert / deposit check at once
  return true;
}

/* ----- STATUS CARD: "abbr ID [server]" (no package) or /chk — which pass / bundle / double-diamond tiers an ID can buy -----
   Sources, in this order: (1) whatever the ID-check answer of G2Bulk carries, (2) env.STATUS_API (optional, URL with {id} {server} {game}),
   (3) this bot's own sales history (marks a tier ❌ only when THIS bot delivered it).  A tier nobody can tell about shows ➖ — never a guess.
   Owner: /raw abbr ID server  prints what the providers really send back, so the field names can be matched. */
const SC_STOP = new Set(["diamond", "diamonds", "dia", "double", "bonus", "status", "is", "can", "buy", "available", "eligible", "claimed", "used", "purchased", "first", "recharge", "topup", "top", "up", "check", "data", "result", "results", "info", "the", "of", "package", "packages", "has", "have", "already", "bought"]);
const stok = (x) => String(x).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/twlight/g, "twilight").split(/[^a-z0-9]+/).filter((t) => t && !SC_STOP.has(t));
const SC_USED = /used|claimed|purchased|bought|already|redeem|consumed/i;
function flat(o, p = "", out = []) {                     // JSON -> [[path, leaf], ...]; {name, available} pairs inside arrays become [name, available]
  if (o === null || o === undefined) return out;
  if (Array.isArray(o)) {
    o.forEach((x, i) => {
      if (x && typeof x === "object") {
        const nm = x.name ?? x.title ?? x.label ?? x.package ?? x.sku ?? x.id ?? x.key;
        const val = x.available ?? x.eligible ?? x.active ?? x.status ?? x.claimed ?? x.used ?? x.value;
        if (nm !== undefined && val !== undefined && typeof val !== "object") out.push([String(nm) + (x.claimed !== undefined || x.used !== undefined ? ".used" : ""), val]);
        else flat(x, p + "." + (nm ?? i), out);
      } else out.push([p + "." + i, x]);
    });
    return out;
  }
  if (typeof o === "object") { for (const k of Object.keys(o)) flat(o[k], p ? p + "." + k : k, out); return out; }
  out.push([p, o]);
  return out;
}
const flagOf = (v) => (v === true || /^(true|yes|y|1|available|eligible|active|ok)$/i.test(String(v).trim()) ? true : v === false || /^(false|no|n|0|unavailable|ineligible|inactive|used|claimed|purchased)$/i.test(String(v).trim()) ? false : null);
function flagFor(label, flats, hint) {                   // true = can buy · false = cannot / used · null = unknown
  const L = stok(String(label).replace(/[🔥⭐]/gu, ""));
  if (!L.length) return null;
  let hits = flats.filter(([k, v]) => flagOf(v) !== null && (() => { const K = stok(k); return L.every((t) => K.includes(t)); })());
  if (hint) { const h = hits.filter(([k]) => hint.test(k)); if (h.length) hits = h; else if (hits.length > 1) return null; }
  if (!hits.length) return null;
  const [k, v] = hits[0];
  const f = flagOf(v);
  return SC_USED.test(k) && !/^(used|claimed|purchased)$/i.test(String(v).trim()) ? !f : f;
}
const pickStr = (flats, re) => { const x = flats.find(([k, v]) => re.test(String(k).split(".").pop()) && typeof v === "string" && v.trim()); return x ? x[1].trim() : ""; };
async function statusData(env, entry, pid, sid, raw) {
  const flats = flat(raw);
  if (env.STATUS_API) {
    try {
      const u = String(env.STATUS_API).replace(/\{id\}/g, encodeURIComponent(pid)).replace(/\{server\}/g, encodeURIComponent(sid || "")).replace(/\{game\}/g, encodeURIComponent(entry.f.idCheck || entry.f.g2code || ""));
      const r = await fetch(u, { headers: env.STATUS_API_KEY ? { Authorization: "Bearer " + env.STATUS_API_KEY } : {}, signal: AbortSignal.timeout(10000) });
      if (r.ok) flats.push(...flat(await r.json().catch(() => null)));
    } catch {}
  }
  return flats;
}
async function statusCard(env, m, inGroup, g, pid, sidArg) {   // always true: the message was handled
  const chat = m.chat.id, rt = replyTo(m.message_id);
  const out = async (text, extra = {}) => { const r = await send(env, chat, text, { ...rt, disable_web_page_preview: true, ...extra }); if (inGroup) await scheduleDelete(env, chat, r?.result?.message_id, QUOTE_MS); return r; };
  const entry = g.entries.find((e) => e.f.idCheck) || g.entries[0], rq = reqOf(entry);
  if (rq.needsServer && !sidArg) { await out("<b>Server ID မပါပါ</b>\nဥပမာ — <code>ml " + esc(pid) + " 2001</code>"); return true; }
  if (!rq.needsServer && sidArg) { await out("<b>Package မတွေ့ပါ</b> — ရတာ: " + esc([...new Set(g.entries.flatMap((e) => e.packages.map((x) => String(x.amount ?? "")).filter(Boolean)))].slice(0, 14).join(" · "))); return true; }
  const sid = rq.needsServer ? sidArg : "";
  if (!entry.f.idCheck) { await out("<b>ဒီ Game မှာ ID စစ်လို့မရပါ</b>"); return true; }
  const r = await checkPlayer(entry.f.idCheck, pid, sid, "");
  if (r.outcome === "invalid") { await out(r.reason === "server" ? "<b>Server ID မကိုက်ပါ</b>" : "<b>ဒီ Player ID ကို မတွေ့ပါ</b>"); return true; }
  if (r.outcome !== "valid") { await out("<b>ID စစ်မရပါ</b> — ခဏနေ ပြန်ပို့ပါ"); return true; }
  const flats = await statusData(env, entry, pid, sid, r.raw);
  const hist = ((await KV.get("ph:" + pid + ":" + sid, "json").catch(() => null)) || {})[g.name] || {};
  const dd = [], pb = [];
  for (const tab of tabsOf(entry)) { const nm = tab.label + " " + tab.key; if (/double|2x/i.test(nm)) dd.push(tab); else if (/pass|bundle|package|weekly|monthly|elite|epic/i.test(nm)) pb.push(tab); }
  let known = 0;
  const mark = (label, hint, isDd) => {
    const clean = String(label).replace(/\s*[🔥⭐]\s*$/u, "");
    let f = flagFor(clean, flats, hint);
    if (f !== null) known++;                                  // only what a provider really said counts
    if (f === null && isDd && hist[clean]) f = false;
    return f === true ? "✅" : f === false ? "❌" : "➖";
  };
  const secPb = pb.flatMap((t) => t.rows.map((x) => x[0])).slice(0, 12).map((l) => `${mark(l, null, false)} ${esc(String(l).replace(/\s*[🔥⭐]\s*$/u, ""))}`);
  const secDd = dd.flatMap((t) => t.rows.map((x) => x[0])).slice(0, 12).map((l) => `${esc(String(l).replace(/\s*[🔥⭐]\s*$/u, "").replace(/\s*diamonds?$/i, ""))} ${mark(l, /double|first|2x/i, true)}`);
  const name = r.name || pickStr(flats, /^(name|nickname|nick|role_?name|username)$/i), region = pickStr(flats, /^(region|country|country_?name)$/i);
  const L = LINE;
  let text = `🎮 <b>${esc(g.name)}${entry.server ? " · " + esc(entry.server) : ""}</b>\n${L}\n<code>ID     </code> <code>${esc(pid)}</code>\n` + (sid ? `<code>Server </code> <code>${esc(sid)}</code>\n` : "") + `<code>Name   </code> <b>${esc(name || "-")}</b>\n` + (region ? `<code>Region </code> ${esc(region)}\n` : "");
  if (known) {                                          // a provider / STATUS_API told us: show the tiers
    if (secPb.length) text += `${L}\n<b>Pass &amp; Bundle</b>\n${secPb.join("\n")}\n`;
    if (secDd.length) text += `${L}\n<b>Double Diamonds</b>\n${secDd.join("  ·  ")}\n`;
    text += `${L}\n✅ ဝယ်လို့ရ · ❌ မရ/သုံးပြီး · ➖ မသိ`;
  } else {                                              // nobody tells: only show what THIS bot delivered (no guessing)
    const hs = Object.entries(hist).sort((x, y) => y[1] - x[1]).slice(0, 12);
    text += `${L}\n<b>ဒီ Bot က ဝယ်ပေးပြီးသား</b>\n` + (hs.length ? hs.map(([am, t]) => `✓ ${esc(am)} · ${esc(dateMM(t))}`).join("\n") : "<i>မရှိသေးပါ</i>");
  }
  const copy = [{ text: "📋 ID Copy", copy_text: { text: String(pid) } }];
  if (sid) copy.push({ text: "📋 Server Copy", copy_text: { text: String(sid) } });
  await out(text, { reply_markup: { inline_keyboard: [copy] } });
  return true;
}
async function chkParse(env, m, inGroup, body) {         // "ml 1159045022 13678" -> { g, pid, sid } | error text
  const store = await loadStore(env);
  if (!store.groups) return { err: "⚠ Store data မရနိုင်သေးပါ" };
  let pool = store.groups;
  if (inGroup) { const al = await getAllowed(m.chat.id); pool = pool.filter((x) => al.includes(x.key)); }
  const p = parseBuyLine(body, await abbrMap({ groups: pool }), null);
  if (!p) return { err: "ပုံစံ — <code>/chk ml 1159045022 13678</code>" };
  return { g: p.g, pid: p.pid, sid: (p.segs[0].tk.find((x) => /^\d{2,7}$/.test(x))) || "" };
}
async function chkCommand(env, m, inGroup) {
  const body = String(m.text || "").replace(/^\/chk(@\w+)?\s*/i, "").trim();
  const r = body ? await chkParse(env, m, inGroup, body) : { err: "ပုံစံ — <code>/chk ml 1159045022 13678</code>" };
  if (r.err) { const x = await send(env, m.chat.id, r.err, replyTo(m.message_id)); if (inGroup) await scheduleDelete(env, m.chat.id, x?.result?.message_id, 30 * 1000); return true; }
  return statusCard(env, m, inGroup, r.g, r.pid, r.sid);
}
async function rawCommand(env, m) {                      // owner: what the providers really answer for this ID
  const body = String(m.text || "").replace(/^\/raw(@\w+)?\s*/i, "").trim();
  const r = body ? await chkParse(env, m, false, body) : { err: "ပုံစံ — <code>/raw ml 1159045022 13678</code>" };
  if (r.err) return send(env, m.chat.id, r.err);
  const entry = r.g.entries.find((e) => e.f.idCheck) || r.g.entries[0];
  const c = entry.f.idCheck ? await checkPlayer(entry.f.idCheck, r.pid, r.sid, "") : { outcome: "unknown" };
  const parts = [`<b>checkPlayerId</b> · ${esc(c.outcome)}\n<pre>${esc(cut(JSON.stringify(c.raw ?? null, null, 1), 1500))}</pre>`];
  if (env.STATUS_API) {
    try {
      const u = String(env.STATUS_API).replace(/\{id\}/g, encodeURIComponent(r.pid)).replace(/\{server\}/g, encodeURIComponent(r.sid || "")).replace(/\{game\}/g, encodeURIComponent(entry.f.idCheck || ""));
      const x = await fetch(u, { headers: env.STATUS_API_KEY ? { Authorization: "Bearer " + env.STATUS_API_KEY } : {}, signal: AbortSignal.timeout(10000) });
      parts.push(`<b>STATUS_API</b> · HTTP ${x.status}\n<pre>${esc(cut(await x.text(), 1500))}</pre>`);
    } catch (e) { parts.push("<b>STATUS_API</b> · error"); }
  } else parts.push("<i>STATUS_API မသတ်မှတ်ရသေးပါ</i>");
  return send(env, m.chat.id, parts.join("\n\n"));
}

async function groupAdminText(env, m) {                 // admin REPLIES to the bot's card in a group with the ID / Character Name it asked for
  const rep = m.reply_to_message;
  if (!rep) return false;
  const ss = await getSS(m.from.id);
  if (!ss || ss.chat !== m.chat.id || ss.mid !== rep.message_id || !["id", "char"].includes(ss.step)) return false;
  return (await adminText(env, m)) !== false;
}


/* ----- admin price quote in a group: type amounts / package names (86, wp, wp 2, 86 172 wp) or a tab name (diamond, pass) ----- */
const QUOTE_MS = 5 * 60 * 1000;                         // quotes disappear after 5 minutes
const MAX_QTY = 6;
const Q_STOP = /ဈေးနှုန်း|ဈေး|ဘယ်လောက်|ကျပ်|ပေးပါ|ပေး|လဲ|လား|\b(?:price|prices|rate|mmk|ks|kyat|pls|please)\b/gi;
const isFiller = (x) => x !== "x" && Q_FILLER.has(x);
function quoteTokens(text, forTab) {
  let s = String(text || "").toLowerCase().replace(Q_STOP, " ");
  if (!forTab) s = s.replace(/weekly\s*diamond\s*pass|weekly\s*pass|\bwkp\b/g, "wp").replace(/(^|[^\d])([1-6])wp\b/g, "$1wp x $2").replace(/[×*]/g, " x ");
  s = s.replace(/(\d)([a-z])/g, "$1 $2").replace(/([a-z])(\d)/g, "$1 $2");
  return s.split(Q_SPLIT).filter(Boolean);
}
const TAB_ALIAS = { currency: ["diamond", "diamonds", "dia", "currency"], package: ["package", "pass", "pkg"] };
function tabMatches(pool, text) {                       // the whole message is a tab name -> that tab's table
  const q = quoteTokens(text, true);
  if (!q.length) return [];
  const key = [...q].sort().join(" ");
  const exact = [], loose = [];
  for (const group of pool) group.entries.forEach((entry, ei) => {
    for (const tab of tabsOf(entry)) {
      const names = [tab.label, tab.key, ...(TAB_ALIAS[tab.key] || [])].map((n) => quoteTokens(n, true));
      if (names.some((n) => [...n].sort().join(" ") === key)) exact.push({ group, entry, tab });
      else if (names.slice(0, 2).some((n) => q.every((x) => n.includes(x)))) loose.push({ group, entry, tab });
    }
  });
  const seen = new Set();
  return (exact.length ? exact : loose).filter((h) => { const k = h.group.id + "|" + h.entry.id + "|" + h.tab.key; if (seen.has(k)) return false; seen.add(k); return true; });
}
function quoteItems(text) {                             // "86 172 wp 2 x3" -> [{86},{172},{wp qty 2}]
  const tk = quoteTokens(text, false).filter((x) => !isFiller(x));
  const items = [];
  for (let i = 0; i < tk.length; i++) {
    const t = tk[i], last = items[items.length - 1];
    if (t === "x") {
      if (last && /^\d+$/.test(tk[i + 1] || "")) { const n = Number(tk[++i]); last.over = n > MAX_QTY; last.qty = Math.min(Math.max(1, n), MAX_QTY); }
      continue;
    }
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (last && !last.num && !last.qty && n >= 1 && n <= MAX_QTY) { last.qty = n; continue; }   // "wp 2" = 2 weekly passes
      items.push({ toks: [t], num: true, qty: 0, text: t });
    } else if (last && !last.num && !last.qty) { last.toks.push(t); last.text += " " + t; }          // "twilight pass" = one name
    else items.push({ toks: [t], num: false, qty: 0, text });
  }
  items.forEach((it) => { if (!it.num) it.text = it.toks.join(" "); });
  return items;
}
function resolveItem(pool, it) {
  const find = (toks) => {
    const key = [...toks].sort().join(" "), numeric = toks.every((x) => /^\d+$/.test(x));
    const exact = [], loose = [];
    for (const group of pool) group.entries.forEach((entry, ei) => entry.packages.forEach((p, pi) => {
      const have = amtTokens(p.amount);
      if (!have.length) return;
      if ([...have].sort().join(" ") === key) exact.push({ group, ei, pi });
      else if (toks.length === 1 && /^[a-z]{2,6}$/.test(toks[0]) && pkgInit(p.amount) === toks[0]) exact.push({ group, ei, pi });
      else if (!numeric && toks.every((x) => have.includes(x))) loose.push({ group, ei, pi });
    }));
    return exact.length ? exact : loose;
  };
  const r = find(it.toks);
  if (r.length || it.toks.length < 2) return r.length ? r : null;
  const out = [];                                       // "wp twilight" typed without a comma: try each word on its own
  for (const t of it.toks) { const x = find([t]); if (!x.length) return null; out.push(...x); }
  return out;
}
function quoteHtml(pool, items) {
  const sections = new Map(), warn = [];
  for (const it of items) {
    const r = resolveItem(pool, it);
    if (!r) { warn.push(it); continue; }
    for (const h of r) {
      const k = h.group.id + "|" + h.ei;
      if (!sections.has(k)) sections.set(k, { group: h.group, entry: h.group.entries[h.ei], lines: [] });
      sections.get(k).lines.push({ p: h.group.entries[h.ei].packages[h.pi], qty: it.qty || 1 });
    }
  }
  const html = [...sections.values()].map((sec) => quoteSection(sec.group.name, sec.entry.server, sec.lines.map(({ p, qty }) => {
    const unit = Number(p.price), ok = p.price !== undefined && p.price !== null && p.price !== "" && Number.isFinite(unit);
    return { amount: String(p.amount ?? "-"), qty, unit: ok ? unit : null };      // the price is always the store's current price
  })));
  return { html: html.join("\n"), warn, found: sections.size };
}
function quoteSection(game, server, lines) {              // one game's quote card from the "quote" + "qrow" templates
  let total = 0, priced = true;
  const rows = lines.map(({ amount, qty, unit }) => {
    const ok = unit !== null && unit !== undefined;
    if (ok) total += unit * qty; else priced = false;
    return tplOut("qrow", {
      amount: esc(amount), qty: qty > 1 ? String(qty) : "", qtyx: qty > 1 ? ` ×${qty}` : "",
      unit: ok ? fmt(unit) : "-", price: ok ? fmt(unit * qty) : "-", pricetag: ok ? `<code>${fmt(unit * qty)}</code> Ks` : "-",
    });
  });
  return tplOut("quote", {
    game: esc(game), server: esc(server || ""), title: esc(game) + (server ? " · " + esc(server) : ""), rows: rows.join("\n"),
    total: fmt(total), count: String(lines.length),
    totalline: lines.length > 1 ? `━━━━━━\nစုစုပေါင်း — <code>${fmt(total)}</code> Ks${priced ? "" : " (ဈေးမရှိတာ ပါနေပါတယ်)"}` : "",
  });
}
let ALLG = { t: 0, s: null };
async function allGroupGames(env) {                     // every game that is set for at least one group (cached 60 s)
  if (ALLG.s && Date.now() - ALLG.t < 60000) return ALLG.s;
  const s = new Set();
  for (const g of await listGroups(env)) for (const k of await getAllowed(g.id)) s.add(k);
  ALLG = { t: Date.now(), s };
  return s;
}
async function priceQuote(env, m, priv) {               // true = answered.  priv = the admin typed it in the bot's private chat
  const chat = m.chat.id, text = String(m.text || "").trim();
  if (!text || text.length > 120 || text.startsWith("/")) return false;
  if (/\d{8,}/.test(text.replace(/[\s,.\-]/g, ""))) return false;          // a Player ID / phone number in the message = an order line, never a price question
  const store = await loadStore(env);
  if (!store.groups) return false;
  let pool;
  if (priv) { const s = await allGroupGames(env); pool = store.groups.filter((g) => !s.size || s.has(g.key)); }   // private: the games of all groups (all games if no group is set yet)
  else { const al = await getAllowed(chat); if (!al.length) return false; pool = store.groups.filter((g) => al.includes(g.key)); }
  if (!pool.length) return false;
  const tm = tabMatches(pool, text);
  if (tm.length) {                                      // a tab name: that tab's bordered table
    for (const h of tm) {
      const ids = await sendTable(env, chat, m.message_id, h.group, h.entry, h.tab.label, h.tab.rows);
      for (const id of ids) await scheduleDelete(env, chat, id, QUOTE_MS);
    }
    return true;
  }
  const items = quoteItems(text);
  if (!items.length) return false;
  const q = quoteHtml(pool, items);
  if (!q.found) return false;
  if (q.warn.some((w) => w.num !== true)) return false;   // other words in the message = normal chat, not a quote
  let out = q.html;
  if (q.warn.length) out += `\n⚠️ မတွေ့ပါ: ${q.warn.map((w) => `<code>${esc(w.text)}</code>`).join(" ")}`;
  if (items.some((i) => i.over)) out += `\n⚠️ တစ်ခုကို အများဆုံး ${MAX_QTY} ခုပါ`;
  const r = await send(env, chat, out, replyTo(m.message_id));
  await scheduleDelete(env, chat, r?.result?.message_id, QUOTE_MS);
  return true;
}

/* ----- buying from the provider ----- */
const mapStatus = (s) => {
  s = String(s || "").toUpperCase();
  if (/FAIL|CANCEL|REFUND|REJECT|ERROR/.test(s)) return "failed";
  if (/COMPLET|SUCCESS|DONE/.test(s)) return "completed";
  return "processing";
};
const itemText = (x) => (typeof x === "string" ? x : x && typeof x === "object" ? Object.entries(x).map(([k, v]) => `${k}: ${v}`).join("  ") : String(x));
async function fulfill(env, o, entry, pkg) {            // -> fields to merge into the order
  const unsure = UNSURE;
  try {
    if (o.provider === "g2bulk") {
      const { res, data } = await g2Call(env, `/v1/games/${encodeURIComponent(entry.f.g2code)}/order`, {
        catalogue_name: pkg.g2bulk, player_id: o.pid, server_id: o.sid || undefined, charname: o.cname || undefined, remark: `Bot order ${o.id}`, callback_url: (await hookUrl(env)) || undefined,
      }, o.idem);
      if (res.status === 401) return { status: "failed", error: "G2Bulk API key မမှန်ပါ (401)" };
      if (!res.ok || data.success === false) return res.status >= 500 ? { status: "unknown", error: unsure } : { status: "failed", error: errMsg(data, res) };
      return { status: mapStatus(data.status || data.order?.status || "PENDING"), ref: String(data.order_id ?? data.order?.order_id ?? "") };
    }
    if (o.provider === "voucher") {
      const { res, data } = await g2Call(env, `/v1/products/${encodeURIComponent(pkg.voucherId)}/purchase`, { quantity: 1 }, o.idem);
      if (res.status === 401) return { status: "failed", error: "G2Bulk API key မမှန်ပါ (401)" };
      if (!res.ok || data.success === false) return res.status >= 500 ? { status: "unknown", error: unsure } : { status: "failed", error: errMsg(data, res) };
      const st = mapStatus(data.status);
      const items = Array.isArray(data.delivery_items) ? data.delivery_items.map(itemText) : [];
      const ref = String(data.order_id || "");
      if (st === "failed") return { status: "failed", ref, error: "G2Bulk voucher order failed/refunded" };
      if (st === "completed" && items.length) return { status: "completed", ref, delivery: items };
      return { status: "processing", ref, poll: data.poll_url || (ref ? `/v1/orders/${ref}/delivery` : "") };
    }
    if (o.provider === "fazercard") {
      const keys = Array.isArray(entry.f.fzFields) && entry.f.fzFields.length ? entry.f.fzFields : ["player_id"];
      const fields = {};
      keys.forEach((k) => { fields[k] = /server|zone/i.test(k) ? o.sid || "" : o.pid || ""; });
      const res = await fetch(`${FZ}/topups/order`, {
        method: "POST", headers: { "X-API-Key": env.FAZERCARD_KEY || "", "Idempotency-Key": o.idem, "Content-Type": "application/json" },
        body: JSON.stringify({ category_id: entry.f.fzCat, offer_id: pkg.fazercardOfferId, fields }), signal: AbortSignal.timeout(25000),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) return res.status >= 500 ? { status: "unknown", error: unsure } : { status: "failed", error: String(data.error || `FazerCards HTTP ${res.status}`) };
      return { status: mapStatus((data.order && data.order.status) || "processing"), ref: String((data.order && data.order.id) || "") };
    }
    return { status: "failed", error: "Provider မသတ်မှတ်ရသေးပါ" };
  } catch { return { status: "unknown", error: unsure }; }
}
async function g2OrderFromList(env, ref) {              // GET /games/orders (documented, with or without /v1) -> { order } | null
  if (await g2Blocked()) return null;
  for (const path of ["/v1/games/orders", "/games/orders"]) {
    try {
      const r = await fetch(G2 + path + "?page=1&limit=100", { headers: { "X-API-Key": env.G2BULK_KEY || "" }, signal: AbortSignal.timeout(10000) });
      if (r.status === 401) { await g2AuthFailed(env); return null; }
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const x = ((j && j.orders) || []).find((y) => String(y.order_id) === String(ref));
      if (x) return { order: x };
    } catch {}
  }
  return null;
}
async function pollOrder(env, o) {                      // -> {status, delivery?, error?} when it has finished, else null
  try {
    if (!o.ref) return null;
    if (o.provider === "g2bulk") {
      const r1 = await g2Call(env, "/v1/games/order/status", { order_id: o.ref });
      let data = r1.res.ok ? r1.data : null;
      if (!data || !(data.order || data.status)) data = await g2OrderFromList(env, o.ref);   // docs give no body for /order/status: the documented order list is the safety net
      if (!data) return null;
      const st = String((data.order && data.order.status) || data.status || "").toUpperCase();
      const refunded = (data.order && data.order.is_refunded === true) || data.is_refunded === true;
      if (refunded || /FAIL|REFUND|CANCEL/.test(st)) return { status: "failed", error: "G2Bulk က Order ကို မအောင်မြင်/Refund လုပ်လိုက်ပါတယ်" };
      if (st === "COMPLETED") return { status: "completed" };
      return null;
    }
    if (o.provider === "voucher") {
      const url = String(o.poll || "").startsWith("/") ? G2 + o.poll : "";
      if (!url || (await g2Blocked())) return null;
      const res = await fetch(url, { headers: { "X-API-Key": env.G2BULK_KEY || "" }, signal: AbortSignal.timeout(15000) });
      if (res.status === 401) { await g2AuthFailed(env); return null; }
      if (res.status === 410) return { status: "failed", error: "G2Bulk voucher order failed/refunded" };
      if (res.status !== 200) return null;
      const d = await res.json().catch(() => ({}));
      return Array.isArray(d.delivery_items) && d.delivery_items.length ? { status: "completed", delivery: d.delivery_items.map(itemText) } : null;
    }
    if (o.provider === "fazercard") {
      const res = await fetch(`${FZ}/orders/${encodeURIComponent(o.ref)}`, { headers: { "X-API-Key": env.FAZERCARD_KEY || "" }, signal: AbortSignal.timeout(15000) });
      const d = await res.json().catch(() => ({}));
      if (!d.ok) return null;
      const st = mapStatus(d.order && d.order.status);
      return st === "processing" ? null : { status: st, ...(st === "failed" ? { error: "FazerCards order failed/refunded" } : {}) };
    }
  } catch {}
  return null;
}
const UNSURE = "Provider နဲ့ ချိတ်ဆက်မှု ပြတ်သွားပါတယ် — Order ဝင်/မဝင် Provider မှာ ကိုယ်တိုင်စစ်ပါ၊ ထပ်မဝယ်ပါနဲ့";
const dayKey = (t) => new Date((t || Date.now()) + 6.5 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");   // Myanmar day
const ORDER_KEY = { completed: "done", failed: "fail", unknown: "unk" };      // everything else = "proc"
function orderVars(o) {
  const codes = Array.isArray(o.delivery) ? o.delivery.map((c) => `<code>${esc(c)}</code>`) : [];
  const sname = o.sname && o.sname !== o.sid ? esc(o.sname) : "";
  return {
    id: esc(o.id), game: esc(o.game), server: esc(o.server || ""), title: esc(o.game) + (o.server ? " · " + esc(o.server) : ""),
    amount: esc(o.amount), price: fmt(o.price), pid: esc(o.pid || ""), sid: esc(o.sid || ""), sname,
    serverid: o.sid ? `<code>${esc(o.sid)}</code>${sname ? ` (${sname})` : ""}` : "", cname: esc(o.cname || ""), pname: esc(o.pname || ""),
    provider: esc(o.plabel || ""), ref: esc(o.ref || ""), via: esc(o.plabel || "") + (o.ref ? ` · <code>${esc(o.ref)}</code>` : ""),
    codes: codes.join("\n"), codeblock: codes.length ? "<b>Code</b>\n" + codes.join("\n") : "",
    error: esc(o.error || ""), by: esc(o.by || ""), src: esc(o.src || ""), byline: esc(o.by || "") + (o.src ? ` · 👥 ${esc(o.src)}` : ""),
    date: dateMM(o.done || o.at), status: STATUS_LABEL[o.status] || "Processing",
  };
}
function orderText(o, forceDefault) {
  const t = tplOut(ORDER_KEY[o.status] || "proc", orderVars(o), forceDefault);
  return o.lowbal != null ? t + `\n\n⚠ <b>API Balance နည်းနေပါပြီ</b> — ${Number(o.lowbal).toFixed(2)} USD (${LOWBAL_USD} USD အောက်)\nအမြန်ဖြည့်ပါ` : t;
}
function orderMarkup(o) {
  const rows = [];
  const T = tplNow();
  if (o.status === "completed") rows.push([btn(T.b_done, "nop", "success")]);
  else if (o.status === "failed") rows.push([btn(T.b_fail, "nop", "danger")]);
  else if (o.status === "unknown") rows.push([btn(T.b_unk, "nop")]);
  else rows.push([btn(T.b_proc, "nop"), btn(T.b_check, `zr:${o.id}`, "primary")]);
  if (o.status !== "processing") rows.push([btn(T.b_again, "zn", "primary")]);
  return { inline_keyboard: rows };
}
async function saveOrder(o) {
  const final = !["processing", "placing"].includes(o.status);
  if (final && !o.done) o.done = Date.now();
  await KV.put("or:" + o.id, JSON.stringify(o), { expirationTtl: 90 * 86400 }).catch(() => {});
  await KV.put("od:" + dayKey(o.at) + ":" + o.id, JSON.stringify({ u: o.uid, by: o.by, g: o.game, a: o.amount, p: o.price, s: o.status }), { expirationTtl: 45 * 86400 }).catch(() => {});
  if (o.status === "placing") { await KV.put("pend:" + o.id, "1", { expirationTtl: 3600 }).catch(() => {}); await KV.put("pendany", "1", { expirationTtl: 7200 }).catch(() => {}); }
  else await KV.delete("pend:" + o.id).catch(() => {});
  if (o.status === "processing" && o.ref) { await KV.put("open:" + o.id, "1", { expirationTtl: 3 * 86400 }).catch(() => {}); await KV.put("openany", "1", { expirationTtl: 3 * 86400 }).catch(() => {}); }
  else await KV.delete("open:" + o.id).catch(() => {});
  if (o.ref && o.provider === "g2bulk") await KV.put("ref:g2:" + o.ref, o.id, { expirationTtl: 3 * 86400 }).catch(() => {});   // callback lookup: G2Bulk order_id -> our order
  // "openany" / "pendany" are cheap flags: the every-minute cron only does a KV list when one of them exists (no open order = one KV read, nothing else)
}
async function recordBought(o) {                        // what this bot already delivered to an ID (used by the status card)
  if (!o.pid) return;
  const k = "ph:" + o.pid + ":" + (o.sid || "");
  const h = (await KV.get(k, "json").catch(() => null)) || {};
  (h[o.game] = h[o.game] || {})[o.amount] = Date.now();
  await KV.put(k, JSON.stringify(h), { expirationTtl: 400 * 86400 }).catch(() => {});
}
// Log line (never the codes) for LOG_CHAT_ID; owners are always told when an order Failed / is Unknown.
async function notifyFinal(env, o) {
  if (o.notified || !["completed", "failed", "unknown"].includes(o.status)) return;
  o.notified = true;
  if (o.status === "completed") await recordBought(o).catch(() => {});
  if (o.status === "failed" && /^(g2bulk|voucher)$/.test(o.provider)) await KV.put("bal:refund", String(Date.now()), { expirationTtl: 300 }).catch(() => {});   // a refund is not a deposit
  await saveOrder(o);
  const to = new Set(idList(env.LOG_CHAT_ID));
  if (o.status !== "completed") idList(env.OWNER_IDS).forEach((x) => to.add(x));
  const icon = { completed: "✅", failed: "❌", unknown: "⚠️" }[o.status];
  const text = `${icon} <b>${STATUS_LABEL[o.status]}</b> · <code>${esc(o.id)}</code>\n🎮 ${esc(o.game)}${o.server ? " · " + esc(o.server) : ""}\n📦 ${esc(o.amount)} · <b>${fmt(o.price)} MMK</b>\n🆔 <code>${esc(o.pid || "-")}</code>\n🙋 ${esc(o.by)}${o.src ? " · 👥 " + esc(o.src) : ""}${o.error ? "\n⚠️ " + esc(o.error) : ""}`;
  for (const id of to) { if (String(id) === String(o.chat)) continue; await send(env, id, text, { disable_notification: o.status === "completed" }).catch(() => {}); }
}
async function recoverPending(env) {                    // the worker died while calling the provider: never leave that order hanging silently
  if (!KV) return;
  if (!(await KV.get("pendany").catch(() => null))) return;
  const l = await KV.list({ prefix: "pend:", limit: 20 });
  if (!l.keys.length) await KV.delete("pendany").catch(() => {});
  for (const k of l.keys) {
    const o = await KV.get("or:" + k.name.slice(5), "json").catch(() => null);
    if (!o || o.status !== "placing") { await KV.delete(k.name).catch(() => {}); continue; }
    if (Date.now() - o.at < 90 * 1000) continue;
    Object.assign(o, { status: "unknown", error: UNSURE });
    await saveOrder(o);
    await renderOrder(env, o);
  }
}
async function sendReport(env, chat, uid, owner, kb) {
  const l = await KV.list({ prefix: "od:" + dayKey() + ":", limit: 1000 });
  const rows = (await Promise.all(l.keys.map((k) => KV.get(k.name, "json").catch(() => null)))).filter((x) => x && (owner || String(x.u) === String(uid)));
  const sum = (a) => a.reduce((n, x) => n + (Number(x.p) || 0), 0);
  const of = (st) => rows.filter((x) => x.s === st);
  const done = of("completed");
  const group = (arr, key) => { const m = new Map(); arr.forEach((x) => { const v = m.get(x[key]) || { n: 0, t: 0 }; v.n++; v.t += Number(x.p) || 0; m.set(x[key], v); }); return m; };
  const by = group(done, "g"), who = owner ? group(done, "by") : new Map();
  const wait = of("processing").length + of("placing").length;
  let t = `📊 <b>ယနေ့ အရောင်း</b> · ${esc(dateMM().split(",")[0])}\n${LINE}\n`;
  if (!rows.length) t += "ဒီနေ့ Order မရှိသေးပါ";
  else {
    t += `✅ ပြီးစီး  <b>${done.length}</b> ခု · <b>${fmt(sum(done))} MMK</b>\n`;
    if (wait) t += `⏳ Processing  ${wait}\n`;
    if (of("failed").length) t += `❌ Failed  ${of("failed").length}\n`;
    if (of("unknown").length) t += `⚠️ မသေချာ  ${of("unknown").length}\n`;
    if (by.size) t += `${LINE}\n` + [...by].map(([g, v]) => `🎮 ${esc(g)} — ${v.n} ခု · <code>${fmt(v.t)}</code> Ks`).join("\n");
    if (who.size > 1) t += `\n${LINE}\n` + [...who].map(([n, v]) => `🙋 ${esc(n)} — ${v.n} ခု · <code>${fmt(v.t)}</code> Ks`).join("\n");
  }
  return send(env, chat, t.slice(0, 3900), { reply_markup: kb });
}
async function renderOrder(env, o) {
  await loadTpl(env).catch(() => {});
  const put = (text) => tg(env, "editMessageText", { chat_id: o.chat, message_id: o.mid, text, parse_mode: "HTML", reply_markup: orderMarkup(o), disable_web_page_preview: true }).catch(() => null);
  let text = orderText(o);
  let r = await put(text);
  if (r && !r.ok && /parse|entit/i.test(r.description || "")) { text = orderText(o, true); r = await put(text); }   // a broken custom card never blocks the order result
  if (r && !r.ok && !/not modified/i.test(r.description || "")) await send(env, o.chat, text, { reply_markup: orderMarkup(o) }).catch(() => {});
  await notifyFinal(env, o).catch(() => {});
}
async function refreshOrder(env, id) {
  const o = await KV.get("or:" + id, "json").catch(() => null);
  if (!o || o.status !== "processing") return;
  const r = await pollOrder(env, o);
  if (!r) return;
  Object.assign(o, r);
  await saveOrder(o);
  await renderOrder(env, o);
}
async function pollOpenOrders(env, full) {              // every minute: finish the orders that were still Processing.  full = also balance watch (every 5 min)
  if (!KV) return;
  if (await KV.get("openany").catch(() => null)) {
    const l = await KV.list({ prefix: "open:", limit: 20 });
    if (!l.keys.length) await KV.delete("openany").catch(() => {});
    await Promise.all(l.keys.map((k) => refreshOrder(env, k.name.slice(5)).catch(() => {})));
  }
  await recoverPending(env).catch(() => {});
  if (full) await watchBalance(env).catch(() => {});
}
// Same message + same player + same package always gives the SAME key, so a double tap can never buy twice at the provider.
const PLACING = new Set();
async function idemKey(uid, ss) {
  const raw = [uid, ss.mid, ss.gid, ss.ei, ss.pi, ss.pid, ss.sid, ss.cname, ss.price].join("|");
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  // G2Bulk wants a real 36-char UUID (8-4-4-4-12) in X-Idempotency-Key: build a deterministic v5-style one from the hash.
  const b = [...new Uint8Array(d)].slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
async function confirmOrder(env, chat, uid, ss, store, from) {
  const lockKey = uid + ":" + ss.mid;
  if (PLACING.has(lockKey)) return;
  PLACING.add(lockKey);
  try { return await confirmOrderInner(env, chat, uid, ss, store, from); } finally { PLACING.delete(lockKey); }
}
async function confirmOrderInner(env, chat, uid, ss, store, from) {
  const { group, entry, pkg } = ctxOf(store, ss);
  if (!entry || !pkg || String(pkg.amount ?? "-") !== ss.amount || (Number(pkg.price) || 0) !== ss.price)
    return show(env, chat, ss, { text: "⚠️ Package / ဈေး ပြောင်းသွားပါပြီ — 🛒 ဝယ်ယူရန် ကနေ ပြန်ရွေးပါ", markup: { inline_keyboard: [] } });
  const pv = providerOf(entry, pkg);
  if (!pv.ok || !keyReady(env, pv)) return show(env, chat, ss, detailView(env, store, ss));
  const o = {
    id: "A" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase(), idem: await idemKey(uid, ss),
    uid, by: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(uid), src: ss.src || "", chat, mid: ss.mid,
    game: group.name, server: entry.server, amount: ss.amount, price: ss.price, pid: ss.pid, sid: ss.sid, sname: ss.sname, cname: ss.cname, pname: ss.pname,
    provider: pv.key, plabel: pv.label, status: "placing", ref: "", at: Date.now(),
  };
  await show(env, chat, ss, { text: "⏳ <b>Provider ဆီ ဝယ်နေပါတယ်...</b>\n\n" + summary(ss), markup: { inline_keyboard: [] } });
  o.mid = ss.mid || o.mid;
  await saveOrder(o);                                   // written BEFORE the provider is called, so a crash can never lose the order
  Object.assign(o, await fulfill(env, o, entry, pkg));
  await markBalance(env, o);
  await saveOrder(o);
  await renderOrder(env, o);
  await delSS(uid);
}

/* ----- callbacks (tags start with "z", admin only) ----- */
async function onAdminCallback(q, env) {
  const chat = q.message.chat.id, uid = q.from.id, mid = q.message.message_id;
  const p = String(q.data).split(":"), tag = p[0];
  const ans = (text, alert) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text, show_alert: !!alert } : {}) });
  if (tag === "zq") { await ans(); await delSS(uid); return delMsg(env, chat, mid); }
  if (tag === "zr") { await ans("🔄 စစ်နေပါတယ်"); return refreshOrder(env, p[1]); }
  if (tag === "zn") {
    await ans();
    if (await adminStart(env, uid, "")) return;
    const r = await send(env, chat, "📩 Bot ကို private မှာ <b>Start</b> အရင်နှိပ်ပါ", { reply_markup: { inline_keyboard: [[{ text: "▶️ Bot ကို Start", url: `https://t.me/${await botName(env)}?start=admin` }]] } });
    return scheduleDelete(env, chat, r?.result?.message_id, 30 * 1000);
  }
  let ss = await getSS(uid);
  if (!ss && tag === "zl") ss = { step: "list", src: "" };
  if (!ss) return ans("Session ကုန်သွားပါပြီ — 🛒 ဝယ်ယူရန် ကို ပြန်နှိပ်ပါ", true);
  const stale = !!ss.mid && ss.mid !== mid;             // a button of an older card must never confirm the newest order
  ss.mid = mid;
  const store = await loadStore(env);
  if (!store.groups) return ans("Store data မရနိုင်သေးပါ", true);
  const save = () => putSS(uid, ss);
  if (tag === "zx") { await ans(); await delSS(uid); return tg(env, "editMessageText", { chat_id: chat, message_id: mid, text: "❌ ပယ်ဖျက်ပြီးပါပြီ", reply_markup: { inline_keyboard: [[btn("🛒 ပြန်စမယ်", "zn", "primary")]] } }).catch(() => {}); }
  if (tag === "zl") { await ans(); ss.step = "list"; await show(env, chat, ss, gameListView(store, p[1], Number(p[2]) || 0)); return save(); }
  if (tag === "zg") {
    const g = store.byId.get(p[1]);
    if (!g) return ans("Game မတွေ့တော့ပါ", true);
    await ans();
    ss.gid = g.id; ss.tab = 0; ss.page = 0;
    if (g.entries.length > 1) { ss.step = "srv0"; await show(env, chat, ss, serverListView(g)); }
    else { ss.ei = 0; ss.step = "pkg"; await show(env, chat, ss, pkgView(store, ss)); }
    return save();
  }
  if (tag === "zs") { await ans(); ss.ei = Number(p[1]) || 0; ss.tab = 0; ss.page = 0; ss.step = "pkg"; await show(env, chat, ss, pkgView(store, ss)); return save(); }
  if (tag === "zt") { await ans(); ss.tab = Number(p[1]) || 0; ss.page = Number(p[2]) || 0; await show(env, chat, ss, pkgView(store, ss)); return save(); }
  if (tag === "zbp") { await ans(); ss.step = "pkg"; await show(env, chat, ss, pkgView(store, ss)); return save(); }
  if (tag === "zm") {
    const { group, entry } = ctxOf(store, { ...ss, pi: 0 });
    if (!entry) return ans("မတွေ့ပါ", true);
    await ans();
    return sendPrice(env, chat, group, entry, 0);
  }
  if (tag === "zp") {
    await ans();
    const ok = await pickPackage(env, chat, ss, store, Number(p[1]) || 0);
    if (!ok) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "Package မတွေ့ပါ", show_alert: true }).catch(() => {});
    return save();
  }
  if (tag === "zv") {
    const o = (ss.srvOpts || [])[Number(p[1])];
    if (!o) return ans("Server မတွေ့ပါ", true);
    await ans(); ss.sid = o[0]; ss.sname = o[1];
    await advance(env, chat, ss, store);
    return save();
  }
  if (tag === "zw") { await ans(); ss.spage = Number(p[1]) || 0; await show(env, chat, ss, srvSelectView(ss)); return save(); }
  if (tag === "zk") {                                  // quick order matched several: the admin picked one
    const c = ss.step === "pickq" && (ss.cands || [])[Number(p[1])];
    if (!c || !store.byId.get(c.gid)) return ans("Session ကုန်သွားပါပြီ — ID + amount ပြန်ပို့ပါ", true);
    await ans();
    ss.gid = c.gid; ss.ei = c.ei; ss.tab = 0; ss.page = 0;
    await pickPackage(env, chat, ss, store, c.pi, { pid: ss.qpid, sid: c.sid });
    return save();
  }
  if (tag === "zi") {
    await ans(); ss.pid = ""; ss.sid = ""; ss.sname = ""; ss.cname = ""; ss.pname = ""; ss.err = ""; ss.warn = "";
    await advance(env, chat, ss, store);
    return save();
  }
  if (tag === "zc") {
    if (stale) return ans("⛔ ဒီ card က အဟောင်းပါ — နောက်ဆုံး Order card ကို သုံးပါ", true);
    if (ss.step !== "detail") return ans("⏳ ဆက်လုပ်နေပါပြီ / Order ကို ပြန်စပါ", true);
    ss.step = "placing"; await save();                 // a second tap now finds the order already being placed
    await ans();
    return confirmOrder(env, chat, uid, ss, store, q.from);
  }
  return ans();
}

/* ---------- Owner: 🎨 Card ပြင်ရန် (edit the cards from the bot) ---------- */
function sampleCard(key) {                               // the card with sample data (uses whatever template is active right now)
  const o = { id: "A1B2C3", game: "Mobile Legends", server: "Global", amount: "86 Diamonds", price: 5200, pid: "123456789", sid: "2001", sname: "", cname: "", pname: "Player Name", plabel: "G2Bulk", ref: "98765", by: "Admin", src: "Group A", at: Date.now(), status: "processing" };
  if (key === "done") Object.assign(o, { status: "completed", delivery: ["ABCD-EFGH-1234"] });
  else if (key === "fail") Object.assign(o, { status: "failed", error: "Insufficient balance" });
  else if (key === "unk") Object.assign(o, { status: "unknown", ref: "", error: "Provider နဲ့ ချိတ်ဆက်မှု ပြတ်သွားပါတယ်" });
  if (TPL_BTN_KEYS.includes(key)) {
    const st = { b_done: "completed", b_fail: "failed", b_unk: "unknown", b_again: "failed" }[key] || "processing";
    return { text: "🔘 ခလုတ် Preview", markup: orderMarkup({ ...o, status: st, id: "PREVIEW" }) };
  }
  if (["proc", "done", "fail", "unk"].includes(key)) return { text: orderText(o), markup: orderMarkup({ ...o, id: "PREVIEW" }) };
  if (key === "detail") return { text: tplOut("detail", detailVars({ title: "Mobile Legends · Global", amount: "86 Diamonds", price: 5200, pid: "123456789", sid: "2001", pname: "Player Name" }, "G2Bulk", "")), markup: { inline_keyboard: [[btn("✅ Confirm", "nop", "success")]] } };
  if (key === "quote" || key === "qrow") return { text: quoteSection("Mobile Legends", "Global", [{ amount: "86 Diamonds", qty: 1, unit: 5200 }, { amount: "Weekly Pass", qty: 2, unit: 6100 }]) };
  return { text: tplOut("ptable", { game: "Mobile Legends", server: "Global", title: "Mobile Legends · Global", label: "Diamond", part: "" }) };
}
function previewWith(key, html) {                        // sample card with a template that is not saved yet
  const prev = TPLC.v;
  TPLC.v = { ...tplNow(), [key]: html };
  try { return sampleCard(key); } finally { TPLC.v = prev; }
}
function tplMenuView() {
  const c = tplNow()._custom || {};
  const rows = TPL_KEYS.map((k) => [btn((c[k] ? "🎨 " : "") + TPL_LABEL[k], "ev:" + k, "primary")]);
  rows.push([btn((TPL_BTN_KEYS.some((k) => c[k]) ? "🎨 " : "") + "🔘 ခလုတ်စာသားများ", "eb", "primary")]);
  rows.push([btn("♻️ အားလုံး Default ပြန်ထား", "ez"), btn("❌ ပိတ်", "ax", "danger")]);
  return { text: "🎨 <b>Card ပြင်ဆင်ရန်</b>\nပြင်ချင်တဲ့ card ကို ရွေးပါ 👇\n🎨 = ပြင်ထားပြီးသား", markup: { inline_keyboard: rows } };
}
function btnMenuView() {
  const c = tplNow()._custom || {};
  const rows = TPL_BTN_KEYS.map((k) => [btn((c[k] ? "🎨 " : "") + TPL_LABEL[k], "ev:" + k, "primary")]);
  rows.push([btn("⬅️ Card များ", "ec")]);
  return { text: "🔘 <b>Order card အောက်က ခလုတ်စာသားများ</b>\nပြင်ချင်တာ ရွေးပါ 👇", markup: { inline_keyboard: rows } };
}
function tplCardView(key) {
  const custom = !!(tplNow()._custom || {})[key];
  if (TPL_BTN_KEYS.includes(key)) return {
    text: `<b>${TPL_LABEL[key]}</b>\n${custom ? "🎨 ပြင်ထားတဲ့ စာသား သုံးနေပါတယ်" : "Default စာသား သုံးနေပါတယ်"}\n<code>${esc(tplNow()[key])}</code>\n\n${TPL_HINT[key]}`,
    markup: { inline_keyboard: [[btn("✏️ ပြင်မယ်", "ee:" + key, "primary"), btn("👁 Preview", "ep:" + key)], [btn("♻️ Default ပြန်ထား", "er:" + key, "danger"), btn("⬅️ ခလုတ်များ", "eb")]] },
  };
  return {
    text: `<b>${TPL_LABEL[key]}</b>\n${custom ? "🎨 ပြင်ထားတဲ့ ပုံစံ သုံးနေပါတယ်" : "Default ပုံစံ သုံးနေပါတယ်"}\n\n${TPL_HINT[key]}`,
    markup: { inline_keyboard: [
      [btn("✏️ ပြင်မယ်", "ee:" + key, "primary"), btn("👁 Preview", "ep:" + key)],
      [btn("📖 Placeholder", "ef:" + key), btn("📄 HTML code", "eh:" + key)],
      [btn("♻️ Default ပြန်ထား", "er:" + key, "danger"), btn("⬅️ Card များ", "ec")],
    ] },
  };
}
const phHelp = (key) => PH_LIST[key].map(([n, d]) => `<code>{${n}}</code> — ${d}`).join("\n");
function editPrompt(key) {
  if (TPL_BTN_KEYS.includes(key)) return {
    text: `✏️ <b>${TPL_LABEL[key]}</b> ကို ပြင်မယ်\n\nခလုတ်ပေါ်မှာ ပေါ်စေချင်တဲ့ စာကို <b>တစ်ကြောင်းတည်း</b> (စာလုံး ၄၀ အထိ) ပို့ပါ။ ပုံမှန် emoji ထည့်လို့ရပါတယ် — ခလုတ်ထဲမှာ bold / premium emoji မပြနိုင်ပါဘူး (Telegram ကန့်သတ်ချက်)။`,
    markup: { inline_keyboard: [[btn("❌ ပယ်ဖျက်", "ev:" + key, "danger")]] },
  };
  return {
    text: `✏️ <b>${TPL_LABEL[key]}</b> ကို ပြင်မယ်\n\n` +
      "ပို့ချင်တဲ့ စာကို Telegram ထဲမှာ ကိုယ်တိုင် format လုပ်ပြီး <b>message တစ်ခုတည်း</b> ပို့ပါ — bold, italic, underline, strike, spoiler, mono, code block, quote, link, premium emoji အကုန်ရပါတယ်။ Bot က ဒီအတိုင်း မှတ်ထားပါမယ်။\n\n" +
      "တန်ဖိုးတွေကို placeholder နဲ့ ထည့်ပါ (live တန်ဖိုး / store ဈေးနဲ့ အစားထိုးမယ်)။ Placeholder ပါတဲ့ စာကြောင်းမှာ တန်ဖိုးမရှိရင် အဲဒီစာကြောင်းက အလိုလို ပျောက်ပါမယ်။\n" + phHelp(key) +
      "\n\nHTML နဲ့ တိုက်ရိုက်ရေးချင်ရင် <code>html:</code> နဲ့ စပြီး ရေးပါ။",
    markup: { inline_keyboard: [[btn("❌ ပယ်ဖျက်", "ev:" + key, "danger")]] },
  };
}
async function tplEditText(env, m) {                     // the owner's next message is the new card; false = not editing
  const uid = m.from.id, chat = m.chat.id, t = String(m.text || "");
  const st = await KV.get("ed:" + uid, "json").catch(() => null);
  if (!st || !TPL_DEF[st.key]) return false;
  if (KB_LABELS.has(t.trim()) || /^\/\w+/.test(t.trim())) { await KV.delete("ed:" + uid).catch(() => {}); return false; }   // a keyboard button / command ends the editing
  const key = st.key;
  const back = { inline_keyboard: [[btn(TPL_BTN_KEYS.includes(key) ? "⬅️ ခလုတ်များ" : "⬅️ Card များ", TPL_BTN_KEYS.includes(key) ? "eb" : "ec"), btn("✏️ ထပ်ပြင်", "ee:" + key)]] };
  const isBtn = TPL_BTN_KEYS.includes(key);
  if (isBtn && (t.includes("\n") || [...t.trim()].length > 40)) { await send(env, chat, "⚠️ ခလုတ်စာသားက တစ်ကြောင်းတည်း၊ စာလုံး ၄၀ အထိပါ — ပြန်ပို့ပါ"); return true; }
  const html = isBtn ? t.trim() : (/^html:/i.test(t.trim()) ? t.trim().replace(/^html:\s*/i, "") : entitiesToHtml(t, m.entities)).trim();
  if (!html) { await send(env, chat, "⚠️ စာမပါပါဘူး — ပြန်ပို့ပါ"); return true; }
  if (html.length > 3000) { await send(env, chat, `⚠️ ရှည်လွန်းပါတယ် (${html.length} / 3000) — တိုတိုလေး ပြန်ပို့ပါ`); return true; }
  const card = previewWith(key, html);
  const r = await send(env, chat, card.text, { ...(card.markup ? { reply_markup: card.markup } : {}), disable_web_page_preview: true });
  if (!r?.ok) {
    await send(env, chat, `⚠️ Telegram က ဒီပုံစံကို လက်မခံပါ\n<code>${esc(r?.description || "error")}</code>\nပြင်ပြီး ပြန်ပို့ပါ၊ မပြင်တော့ရင် ❌ နှိပ်ပါ`, { reply_markup: { inline_keyboard: [[btn("❌ ပယ်ဖျက်", "ev:" + key, "danger")]] } });
    return true;
  }
  await saveTpl(env, key, html);
  await KV.delete("ed:" + uid).catch(() => {});
  const bad = isBtn ? [] : unknownPh(key, html);
  await send(env, chat, `✅ <b>${TPL_LABEL[key]}</b> သိမ်းပြီးပါပြီ — အပေါ်က preview အတိုင်း ပေါ်ပါမယ်${bad.length ? `\n⚠️ မသိတဲ့ placeholder: ${bad.map((x) => `<code>{${x}}</code>`).join(" ")}` : ""}`, { reply_markup: back });
  return true;
}
async function onTplCallback(q, env, ans, edit) {
  const chat = q.message.chat.id, uid = q.from.id;
  const [tag, k] = String(q.data).split(":");
  const key = TPL_DEF[k] ? k : "";
  if (tag === "ec") { await ans(); await KV.delete("ed:" + uid).catch(() => {}); return edit(tplMenuView()); }
  if (tag === "ez") {
    await ans();
    return edit({ text: "♻️ <b>Card အားလုံးကို Default ပြန်ထားမလား?</b>\nပြင်ထားတာ အကုန်ပျက်သွားပါမယ်", markup: { inline_keyboard: [[btn("✅ ဟုတ်ပါတယ်", "ezy", "danger"), btn("⬅️ မလုပ်တော့ဘူး", "ec")]] } });
  }
  if (tag === "ezy") { await ans("♻️ Default ပြန်ထားပြီး"); await saveTpl(env, null, null); return edit(tplMenuView()); }
  if (tag === "eb") { await ans(); return edit(btnMenuView()); }
  if (!key) return ans();
  if (tag === "ev") { await ans(); await KV.delete("ed:" + uid).catch(() => {}); return edit(tplCardView(key)); }
  if (tag === "ee") {
    await ans();
    await KV.put("ed:" + uid, JSON.stringify({ key }), { expirationTtl: 1800 }).catch(() => {});
    return edit(editPrompt(key));
  }
  if (tag === "ep") {
    await ans();
    const c = sampleCard(key);
    return send(env, chat, c.text, { ...(c.markup ? { reply_markup: c.markup } : {}), disable_web_page_preview: true });
  }
  if (tag === "ef") { await ans(); return send(env, chat, `📖 <b>${TPL_LABEL[key]}</b> — placeholder များ\n\n${phHelp(key)}`); }
  if (tag === "eh") { await ans(); return send(env, chat, `📄 <b>${TPL_LABEL[key]}</b> — HTML code\n<pre>${esc(String(tplNow()[key]).slice(0, 3500))}</pre>`); }
  if (tag === "er") { await ans("♻️ Default ပြန်ထားပြီး"); await saveTpl(env, key, null); return edit(tplCardView(key)); }
  return ans();
}

async function onPrivate(m, env) {
  const chat = m.chat.id, uid = m.from?.id;
  const t = String(m.text || "").trim();
  if (/^\/id(@\w+)?$/i.test(t)) return send(env, chat, `🆔 User ID: <code>${uid}</code>\n💬 Chat ID: <code>${chat}</code>`);
  const admin = isAdmin(env, uid), owner = isOwner(env, uid), kb = owner ? KB : KB_ADMIN;
  if (owner && (await tplEditText(env, m))) return;      // the owner is sending the new text of a card
  if (admin) {
    if (t === "🛒 ဝယ်ယူရန်" || /^\/admin(@\w+)?(\s+list)?$/i.test(t) || /^\/start(@\w+)?\s+admin$/i.test(t)) {
      if (/^\/start/i.test(t)) await send(env, chat, "🛒 <b>Admin ဝယ်ယူရန်</b> — ခလုတ်ကို အောက်မှာ တင်ပေးထားပါတယ်", { reply_markup: kb });
      if (!(await adminStart(env, uid, ""))) await send(env, chat, "⚠️ ပို့မရပါ၊ ခဏနေ ပြန်စမ်းပါ။", { reply_markup: kb });
      return;
    }
    if (/^\/(start|help)(@\w+)?$/i.test(t) || t === "ℹ️ အကူအညီ") {
      if (t.startsWith("/")) await send(env, chat, WELCOME(owner), { reply_markup: kb });   // /start also puts the keyboard back
      const gv = guideView("", owner);
      return send(env, chat, gv.text, { reply_markup: gv.markup, disable_web_page_preview: true });
    }
    if (t === "📊 ယနေ့ အရောင်း" || /^\/today(@\w+)?$/i.test(t)) return sendReport(env, chat, uid, owner, kb);
    if (/^\/balance(@\w+)?$/i.test(t)) return sendBalance(env, chat);
    if (/^\/chk(@\w+)?(\s|$)/i.test(t)) { await chkCommand(env, m, false); return; }
    if (owner && /^\/raw(@\w+)?(\s|$)/i.test(t)) return rawCommand(env, m);
    if (owner && /^\/abbr(@\w+)?(\s|$)/i.test(t)) return abbrCommand(env, chat, t);
    if (await autoBuy(env, m, false)) return;          // "abbr ID [server] package" -> bought at once
    { const s0 = await getSS(uid);                     // "86" / "wp 2" / "86 172 wp" / "diamond" -> price card (not while the bot waits for an ID / Character Name)
      if (!(s0 && ["id", "char"].includes(s0.step)) && (await priceQuote(env, m, true))) return; }
  }
  if (admin && !owner) {
    if ((await adminText(env, m)) !== false) return;
    return send(env, chat, quickHint(t), { reply_markup: KB_ADMIN });
  }
  if (!owner && idList(env.OWNER_IDS).length) return;   // outsiders: no reply at all
  if (!owner)
    return send(env, chat, idList(env.OWNER_IDS).length ? "👋 ဒီ Bot ကို <b>Group ထဲမှာ</b> သုံးပါ — Group မှာ <code>List</code> သို့ <code>ဈေး</code> လို့ ရိုက်ရင် ဈေးနှုန်း ပေါ်လာပါမယ်။" : "⚠️ OWNER_IDS မထည့်ရသေးပါ။ /id နဲ့ ID ယူပြီး Worker variable မှာ ထည့်ပါ။");
  if (t === "🎨 Card ပြင်ရန်" || /^\/cards(@\w+)?$/i.test(t)) { const v = tplMenuView(); return send(env, chat, v.text, { reply_markup: v.markup }); }
  if (t === "👥 Group စီမံရန်") { const v = await groupsMenu(env); return send(env, chat, v.text, { reply_markup: v.markup.inline_keyboard.length ? v.markup : KB }); }
  if (t === "📋 သတ်မှတ်ထားတာများ" || /^\/summary(@\w+)?$/i.test(t)) return sendSummary(env, chat);
  if (t === "🔄 Game list refresh" || /^\/reload(@\w+)?$/i.test(t)) {
    const s = await loadStore(env, true);
    return send(env, chat, s.groups ? `🔄 Refresh လုပ်ပြီးပါပြီ\n💎 Top Up: ${s.groups.filter((g) => g.kind === "t").length}\n🎟 Voucher: ${s.groups.filter((g) => g.kind === "v").length}` : "⚠️ Store data မရနိုင်သေးပါ", { reply_markup: KB });
  }
  if ((await adminText(env, m)) !== false) return;
  return send(env, chat, quickHint(t), { reply_markup: KB });
}

async function onOwnerCallback(q, env) {
  const chat = q.message.chat.id, mid = q.message.message_id;
  const [tag, c, a, b, d] = String(q.data).split(":");
  const ans = (text) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) });
  const edit = async (v) => {
    const r = await tg(env, "editMessageText", { chat_id: chat, message_id: mid, text: v.text, parse_mode: "HTML", reply_markup: v.markup }).catch(() => null);
    if (r && !r.ok && !/not modified/i.test(r.description || "")) console.error(r.description);
  };
  if (tag === "ax") { await ans(); return tg(env, "deleteMessage", { chat_id: chat, message_id: mid }).catch(() => {}); }
  if (/^e[a-z]*$/.test(tag)) return onTplCallback(q, env, ans, edit);      // 🎨 Card editor
  if (tag === "ab") { await ans(); return edit(await groupsMenu(env)); }
  if (tag === "ac") { await ans(); return edit(await pickerView(env, c, "", 0)); }
  if (tag === "ak") { await ans(); return edit(await pickerView(env, c, a, Number(b) || 0)); }
  if (tag === "ad") {
    await ans("✅ သိမ်းပြီးပါပြီ");
    const title = (await KV.get("grp:" + c).catch(() => "")) || c;
    await send(env, c, "📋 ဈေးနှုန်းကြည့်ရန် အောက်က <b>Price List</b> ခလုတ်ကို နှိပ်ပါ", { reply_markup: KB_GROUP }).catch(() => {});
    return edit({ text: `✅ <b>${esc(title)}</b> — Game ${(await getAllowed(c)).length} ခု သတ်မှတ်ပြီးပါပြီ\nအဲဒီ Group မှာ <code>List</code> လို့ပို့ရင် ဒီ Game တွေပဲ ကျမယ်`, markup: { inline_keyboard: [[{ text: "⬅️ Group များ", callback_data: "ab" }]] } });
  }
  if (tag === "aa") return ans(`Game ${MAX_GAMES} ခုပဲ ရွေးလို့ရပါတယ်`);
  if (tag === "at" || tag === "an") {
    const store = await loadStore(env);
    if (!store.groups) return ans("Store data မရနိုင်သေးပါ");
    let sel = await getAllowed(c);
    const kind = tag === "at" ? b : a;
    const page = Number(tag === "at" ? d : b) || 0;
    if (tag === "at") {
      const g = store.byId.get(a);
      if (!g) return ans("Game မတွေ့တော့ပါ");
      if (sel.includes(g.key)) sel = sel.filter((k) => k !== g.key);
      else {
        if (sel.length >= MAX_GAMES) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: `Game ${MAX_GAMES} ခုပဲ ရွေးလို့ရပါတယ် — တစ်ခုခု အရင်ဖြုတ်ပါ`, show_alert: true });
        sel = [...sel, g.key];
      }
    } else {
      const keys = store.groups.filter((g) => g.kind === kind).map((g) => g.key);
      sel = sel.filter((k) => !keys.includes(k));
    }
    await KV.put("gg:" + c, JSON.stringify(sel));
    await ans();
    return edit(await pickerView(env, c, kind, page));
  }
  return ans();
}

async function onCallback(q, env) {
  if (!q.message || String(q.data) === "spin") return tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  const inGroup = q.message.chat.type !== "private";
  const isZ = /^z[a-z]*(:|$)/.test(String(q.data));   // admin order buttons (also used in a group now)
  if (inGroup && !isZ) return onGroupCallback(q, env);
  if (String(q.data) === "nop") return tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  if (/^h(:|x$)/.test(String(q.data))) {                 // ℹ️ guide buttons (admins and owners)
    if (!isAdmin(env, q.from.id)) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "⛔ Admin ပဲ သုံးလို့ရပါတယ်", show_alert: true });
    return onGuideCallback(q, env);
  }
  if (isZ) {
    if (!isAdmin(env, q.from.id)) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "⛔ Admin ပဲ သုံးလို့ရပါတယ်", show_alert: true });
    return onAdminCallback(q, env);
  }
  if (!isOwner(env, q.from.id)) return tg(env, "answerCallbackQuery", { callback_query_id: q.id, text: "⛔ Owner ပဲ သုံးလို့ရပါတယ်", show_alert: true });
  return onOwnerCallback(q, env);
}

// The bot was added to / removed from a group: remember it right away (no need to wait for a message).
async function onMyChat(c, env) {
  if (!["group", "supergroup"].includes(c.chat?.type)) return;
  const st = c.new_chat_member?.status;
  if (["member", "administrator"].includes(st)) {
    await KV.put("grp:" + c.chat.id, String(c.chat.title || c.chat.id).slice(0, 60)).catch(() => {});
    SEEN.add(c.chat.id);
  } else if (["left", "kicked"].includes(st)) {
    await KV.delete("grp:" + c.chat.id).catch(() => {});
    SEEN.delete(c.chat.id);
  }
}

async function handle(u, env) {
  if (!KV) return;
  await loadTpl(env).catch(() => {});                    // the card templates (cached 20 s) are read synchronously by the card builders
  if (u.callback_query) {
    const sp = startButtonSpinner(env.BOT_TOKEN, u.callback_query);
    try { return await onCallback(u.callback_query, env); } finally { await sp.end(); }
  }
  if (u.my_chat_member) return onMyChat(u.my_chat_member, env);
  const m = u.message;
  if (!m || !m.text) return;
  if (m.chat.type === "private") return onPrivate(m, env);
  if (m.chat.type === "group" || m.chat.type === "supergroup") return onGroupMessage(m, env);
}

export default {
  async fetch(req, env, ctx) {
    KV = env.STATE || null;
    const url = new URL(req.url);
    if (url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
      const r = await tg(env, "setWebhook", { url: `${url.origin}/`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query", "my_chat_member"] });
      await tg(env, "setMyCommands", { commands: [{ command: "start", description: "ℹ️ အကူအညီ" }] }).catch(() => {});   // buttons replace the commands
      await tg(env, "setMyCommands", { commands: [], scope: { type: "all_group_chats" } }).catch(() => {});
      for (const id of [...new Set([...idList(env.OWNER_IDS), ...idList(env.ADMIN_IDS)])])   // owners / admins: the ≡ menu also lists  💳 API Balance
        await tg(env, "setMyCommands", { commands: [{ command: "balance", description: "💳 API Balance စစ်ရန်" }, { command: "start", description: "ℹ️ အကူအညီ" }], scope: { type: "chat", chat_id: Number(id) } }).catch(() => {});
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
    }
    if (!ORIGIN || ORIGIN !== url.origin) ORIGIN = url.origin;
    if (url.pathname === "/g2hook") {                    // G2Bulk "order finished" callback
      if (req.method !== "POST" || url.searchParams.get("k") !== (await hookKey(env))) return new Response("Forbidden", { status: 403 });
      const b = await req.json().catch(() => null);
      const ref = b && (b.order_id ?? (b.order && b.order.order_id));
      if (KV && ref !== undefined && ref !== null) ctx.waitUntil(g2Hook(env, String(ref)).catch((e) => console.error(e)));
      return new Response("OK");
    }
    if (req.method !== "POST") return new Response("OK");
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
    const update = await req.json();
    if (update.callback_query) {   // never leave a tapped button spinning while the real work runs
      const cid = update.callback_query.id;
      ctx.waitUntil(new Promise((r) => setTimeout(r, Number(env.CB_FAST_ACK_MS) >= 0 && env.CB_FAST_ACK_MS !== undefined && env.CB_FAST_ACK_MS !== "" ? Number(env.CB_FAST_ACK_MS) : CB_FAST_ACK_MS))
        .then(() => (ACKED.has(cid) ? null : tg(env, "answerCallbackQuery", { callback_query_id: cid })))
        .catch(() => {}));
    }
    ctx.waitUntil(handle(update, env).catch((e) => console.error(e)));
    if (KV && Date.now() - LAST_SWEEP > 60 * 1000) {      // traffic: open orders every minute, the heavier jobs (cleanup list, balance) every 5 minutes
      const heavy = Date.now() - LAST_HEAVY > 5 * 60 * 1000;
      LAST_SWEEP = Date.now();
      if (heavy) { LAST_HEAVY = Date.now(); ctx.waitUntil(sweep(env).catch(() => {})); }
      ctx.waitUntil(pollOpenOrders(env, heavy).catch(() => {}));
    }
    return new Response("OK");
  },
  async scheduled(event, env, ctx) {                     // cron "* * * * *": cheap every minute, heavy only on minutes 0,5,10 ...
    KV = env.STATE || null;
    LAST_SWEEP = Date.now();
    const heavy = new Date(event.scheduledTime || Date.now()).getUTCMinutes() % 5 === 0;
    if (heavy) { LAST_HEAVY = Date.now(); ctx.waitUntil(sweep(env).catch((e) => console.error(e))); }
    ctx.waitUntil(pollOpenOrders(env, heavy).catch((e) => console.error(e)));
  },
};
