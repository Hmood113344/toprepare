// ══════════════════════════════════════════════════════════════════════════
// لوحة تحضير — نظام تبصيم عسكري (ملف واحد شامل) — مرتبط بموقع فلاش
// ══════════════════════════════════════════════════════════════════════════

const express = require("express");
const session = require("express-session");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const mongoose = require("mongoose");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

// ══════════════════════════════════════════════════════════════════════════
// 1) الإعدادات
// ══════════════════════════════════════════════════════════════════════════
const CONFIG = {
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || "",
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET || "",
    DISCORD_CALLBACK_URL: process.env.DISCORD_CALLBACK_URL || "",
    BOT_TOKEN: process.env.BOT_TOKEN || "",
    GUILD_ID: process.env.GUILD_ID || "",
    // نفس رابط قاعدة بيانات موقع فلاش — عشان نقرأ نفس منسوبين موقع فلاش (الاسم/اليونت/الرتبة) بدون ما نكررهم يدوياً
    MONGO_URI: process.env.MONGO_URI || "",

    SITE_NAME: "لوحة تحضير",
    SESSION_SECRET: process.env.SESSION_SECRET || "غيّر_هذا_السر_تحضير_2026",
    PORT: process.env.PORT || 7800,

    // نفس رولات موقع فلاش بالضبط — عشان "من يحق له الدخول" يطابق فلاش تمامًا
    MILITARY_ROLE_IDS: [
        "1500064443537686588",
        "1533192878510178304",
        "1500064767082233926",
    ],
    SENIOR_ADMIN_IDS: [
        "1003511814140743825",
        "1231269832201207808",
        "1458502584481484952",
    ],

    // نفس رولات القطاعات بموقع فلاش — تستخدم هنا لعرض قطاع العسكري فقط (بدون قيادة)
    PATROL_ROLE_ID: process.env.PATROL_ROLE_ID || "1500064443537686588",
    ROAD_SECURITY_ROLE_ID: process.env.ROAD_SECURITY_ROLE_ID || "1533192878510178304",
    ANTI_DRUGS_ROLE_ID: "1500064767082233926",
    SECTORS: {
        patrol: "الدوريات",
        roadSecurity: "أمن الطرق",
        antiDrugs: "مكافحة المخدرات",
    },

    HOLD_SECONDS: 3,          // مدة الضغط المطلوبة على البصمة
    FAIL_RATE: 0.25,          // احتمال فشل البصمة عشوائياً (تقريبًا مرة كل 4 محاولات)
    LOG_LIMIT: 200,           // أقصى عدد سجلات يرجع بكل طلب (نفس نمط فلاش لتفادي تجمّد قاعدة البيانات)
};

// ══════════════════════════════════════════════════════════════════════════
// 2) قاعدة البيانات
// ══════════════════════════════════════════════════════════════════════════
mongoose.connect(CONFIG.MONGO_URI)
    .then(() => console.log("✅ MongoDB connected"))
    .catch(err => console.log("❌ MongoDB error:", err));

// نفس موديل منسوبين فلاش بالضبط (نفس اسم الموديل ⇐ نفس الكولكشن بقاعدة البيانات)
// strict:false عشان ما يضيع أي حقل موجود بمستند فلاش حتى لو ما عرّفناه هنا
const PersonnelSchema = new mongoose.Schema({
    discord: { type: String, required: true, unique: true },
    discordTag: String,
    registeredName: { type: String, default: null },
    unit: { type: String, default: null },
    rank: { type: String, default: "جندي" },
    points: { type: Number, default: 0 },
    isBlocked: { type: Boolean, default: false },
    isDismissed: { type: Boolean, default: false },
    blockUntil: { type: Date, default: null },
}, { strict: false });
const Personnel = mongoose.model("Personnel", PersonnelSchema);

// حالة الحضور الحالية لكل عسكري (سجل واحد يتحدث)
const AttendanceStatusSchema = new mongoose.Schema({
    discord: { type: String, required: true, unique: true },
    discordTag: String,
    registeredName: String,
    unit: String,
    rank: String,
    sectorLabel: String,
    status: { type: String, enum: ["in", "out"], default: "out" },
    lastCheckInAt: { type: Date, default: null },
    lastCheckOutAt: { type: Date, default: null },
    todayCount: { type: Number, default: 0 }, // عدد مرات تسجيل الحضور اليوم
    updatedAt: { type: Date, default: Date.now },
});
const AttendanceStatus = mongoose.model("AttendanceStatus", AttendanceStatusSchema);

// سجل كل حركة تحضير/انصراف (تاريخي)
const AttendanceLogSchema = new mongoose.Schema({
    discord: String,
    discordTag: String,
    registeredName: String,
    unit: String,
    rank: String,
    type: { type: String, enum: ["in", "out"] },
    at: { type: Date, default: Date.now },
});
AttendanceLogSchema.index({ at: -1 });
AttendanceLogSchema.index({ discord: 1, at: -1 });
const AttendanceLog = mongoose.model("AttendanceLog", AttendanceLogSchema);

const SettingsSchema = new mongoose.Schema({
    key: { type: String, default: "main", unique: true },
    lockAttendance: { type: Boolean, default: false },   // 🔒 قفل تسجيل الحضور (زر ثابت بالطلب)
    maintenance: { type: Boolean, default: false },      // 🚨 وضع الصيانة (يغلق الموقع بالكامل)
});
const Settings = mongoose.model("AttendanceSettings", SettingsSchema);

async function getSettings() {
    let s = await Settings.findOne({ key: "main" });
    if (!s) s = await Settings.create({ key: "main" });
    return s;
}

function isSeniorAdmin(id) { return CONFIG.SENIOR_ADMIN_IDS.includes(id); }

function isNewDay(prevDate) {
    if (!prevDate) return true;
    const now = new Date();
    return prevDate.toDateString() !== now.toDateString();
}

// ══════════════════════════════════════════════════════════════════════════
// 3) بوت الديسكورد — نفس أسلوب فلاش، فقط للتحقق من الرول والقطاع
// ══════════════════════════════════════════════════════════════════════════
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.Channel],
});
let botReady = false;
client.once("ready", () => { botReady = true; console.log(`🤖 بوت ${CONFIG.SITE_NAME} متصل`); });
if (CONFIG.BOT_TOKEN) client.login(CONFIG.BOT_TOKEN).catch(e => console.log("❌ فشل تسجيل دخول البوت:", e.message));

async function isMilitary(discordId) {
    if (!botReady) return { ok: false, reason: "البوت لسا ما اتصل بديسكورد، حاول بعد ثوانٍ" };
    try {
        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const member = await guild.members.fetch(discordId);
        const has = member.roles.cache.some(r => CONFIG.MILITARY_ROLE_IDS.includes(r.id));
        let sectorLabel = null;
        if (member.roles.cache.has(CONFIG.ANTI_DRUGS_ROLE_ID)) sectorLabel = CONFIG.SECTORS.antiDrugs;
        else if (member.roles.cache.has(CONFIG.PATROL_ROLE_ID)) sectorLabel = CONFIG.SECTORS.patrol;
        else if (member.roles.cache.has(CONFIG.ROAD_SECURITY_ROLE_ID)) sectorLabel = CONFIG.SECTORS.roadSecurity;
        return { ok: has, sectorLabel };
    } catch (e) {
        console.error("❌ isMilitary خطأ:", e.message);
        return { ok: false, reason: e.message };
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 4) تجهيز التطبيق
// ══════════════════════════════════════════════════════════════════════════
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(session({ secret: CONFIG.SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: CONFIG.DISCORD_CLIENT_ID,
    clientSecret: CONFIG.DISCORD_CLIENT_SECRET,
    callbackURL: CONFIG.DISCORD_CALLBACK_URL,
    scope: ["identify", "guilds.members.read"],
}, (accessToken, refreshToken, profile, done) => done(null, profile)));

app.get("/auth/discord", passport.authenticate("discord"));
app.get("/auth/discord/callback", passport.authenticate("discord", { failureRedirect: "/" }), (req, res) => res.redirect("/"));
app.get("/auth/logout", (req, res) => { req.logout(() => res.redirect("/")); });

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: "غير مسجّل دخول" });
}
function ensureSeniorAdmin(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ error: "غير مسجّل دخول" });
    if (!isSeniorAdmin(req.user.id)) return res.status(403).json({ error: "هذا القسم لكبار المسؤولين فقط" });
    next();
}

// ══════════════════════════════════════════════════════════════════════════
// 5) API — الحساب الشخصي والتبصيم
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/me", ensureAuth, async (req, res) => {
    const settings = await getSettings();
    const senior = isSeniorAdmin(req.user.id);

    if (!senior && settings.maintenance) {
        return res.json({ blocked: true, maintenance: true, reason: "🚨 الموقع مغلق حالياً للصيانة بطلب من الإدارة العليا." });
    }

    const check = await isMilitary(req.user.id);
    if (!senior && !check.ok) {
        return res.json({ blocked: true, reason: "هذا الموقع مخصص لمنسوبي الجهات العسكرية فقط" });
    }

    const p = await Personnel.findOne({ discord: req.user.id });
    if (!senior && (!p || p.isBlocked)) {
        return res.json({ blocked: true, reason: p && p.isDismissed ? "🚫 تم فصلك نهائيًا من الخدمة العسكرية." : "🚫 حسابك موقوف بموقع فلاش، راجع الإدارة." });
    }

    let st = await AttendanceStatus.findOne({ discord: req.user.id });
    if (!st) {
        st = await AttendanceStatus.create({
            discord: req.user.id, discordTag: req.user.username,
            registeredName: p ? p.registeredName : null, unit: p ? p.unit : null, rank: p ? p.rank : "جندي",
            sectorLabel: check.sectorLabel || null,
        });
    } else {
        st.registeredName = p ? p.registeredName : st.registeredName;
        st.unit = p ? p.unit : st.unit;
        st.rank = p ? p.rank : st.rank;
        st.sectorLabel = check.sectorLabel || st.sectorLabel;
        await st.save();
    }

    res.json({
        blocked: false,
        discordId: req.user.id,
        discordTag: req.user.username,
        avatar: req.user.avatar ? `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png` : null,
        registeredName: st.registeredName || req.user.username,
        unit: st.unit || "-",
        rank: st.rank || "-",
        sectorLabel: st.sectorLabel || "-",
        status: st.status,
        isSeniorAdmin: senior,
        lockAttendance: settings.lockAttendance,
        maintenance: settings.maintenance,
    });
});

// قائمة الأعضاء المسجّلين بالموقع (يظهرون تحت البصمة بالصفحة الرئيسية) — يُستطلع كل عدة ثوانٍ
app.get("/api/members", ensureAuth, async (req, res) => {
    const list = await AttendanceStatus.find({}).sort({ updatedAt: -1 }).limit(CONFIG.LOG_LIMIT).lean();
    res.json({
        list: list.map(m => ({
            discord: m.discord,
            name: m.registeredName || m.discordTag,
            unit: m.unit || "-",
            rank: m.rank || "-",
            status: m.status,
        })),
    });
});

// محاولة تبصيم (بعد إكمال 3 ثواني ضغط بالواجهة) — نسبة فشل عشوائية + تبديل الحالة عند النجاح
app.post("/api/attendance/scan", ensureAuth, async (req, res) => {
    const settings = await getSettings();
    if (settings.maintenance) return res.status(423).json({ error: "الموقع بوضع الصيانة حالياً" });
    if (settings.lockAttendance) return res.status(423).json({ error: "🔒 تسجيل الحضور مقفل حالياً من قبل الإدارة العليا" });

    const p = await Personnel.findOne({ discord: req.user.id });
    if (!isSeniorAdmin(req.user.id) && (!p || p.isBlocked)) {
        return res.status(403).json({ error: "حسابك موقوف — راجع الإدارة" });
    }

    // فشل عشوائي بالبصمة — يحاكي بصمة حقيقية أحيانًا ما تنجح من أول مرة
    if (Math.random() < CONFIG.FAIL_RATE) {
        return res.json({ success: false });
    }

    let st = await AttendanceStatus.findOne({ discord: req.user.id });
    if (!st) st = await AttendanceStatus.create({ discord: req.user.id, discordTag: req.user.username });

    const now = new Date();
    const newType = st.status === "in" ? "out" : "in";
    st.status = newType;
    if (newType === "in") {
        st.lastCheckInAt = now;
        st.todayCount = isNewDay(st.lastCheckOutAt) && isNewDay(st.updatedAt) ? 1 : st.todayCount + 1;
    } else {
        st.lastCheckOutAt = now;
    }
    st.updatedAt = now;
    await st.save();

    await AttendanceLog.create({
        discord: req.user.id, discordTag: req.user.username,
        registeredName: st.registeredName, unit: st.unit, rank: st.rank,
        type: newType, at: now,
    });

    res.json({ success: true, status: newType, at: now });
});

// ══════════════════════════════════════════════════════════════════════════
// 6) API — لوحة كبار المسؤولين
// ══════════════════════════════════════════════════════════════════════════
app.get("/api/senior/dashboard", ensureSeniorAdmin, async (req, res) => {
    const [total, checkedIn, todayLogs] = await Promise.all([
        AttendanceStatus.countDocuments({}),
        AttendanceStatus.countDocuments({ status: "in" }),
        AttendanceLog.countDocuments({ at: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
    ]);
    const settings = await getSettings();
    res.json({ total, checkedIn, checkedOut: total - checkedIn, todayLogs, settings });
});

app.get("/api/senior/members", ensureSeniorAdmin, async (req, res) => {
    const list = await AttendanceStatus.find({}).sort({ registeredName: 1 }).limit(CONFIG.LOG_LIMIT).lean();
    res.json({ list });
});

// تبديل حالة عضو يدويًا من طرف الإدارة (تحضير/تسكير قسري)
app.post("/api/senior/members/:discord/force/:type", ensureSeniorAdmin, async (req, res) => {
    const { discord, type } = req.params;
    if (!["in", "out"].includes(type)) return res.status(400).json({ error: "نوع غير صحيح" });
    const st = await AttendanceStatus.findOne({ discord });
    if (!st) return res.status(404).json({ error: "العضو غير موجود" });
    const now = new Date();
    st.status = type;
    if (type === "in") st.lastCheckInAt = now; else st.lastCheckOutAt = now;
    st.updatedAt = now;
    await st.save();
    await AttendanceLog.create({ discord, discordTag: st.discordTag, registeredName: st.registeredName, unit: st.unit, rank: st.rank, type, at: now });
    res.json({ ok: true });
});

app.get("/api/senior/log", ensureSeniorAdmin, async (req, res) => {
    const logs = await AttendanceLog.find({}).sort({ at: -1 }).limit(CONFIG.LOG_LIMIT).maxTimeMS(10000).lean();
    res.json({ list: logs });
});

// تقرير مختصر — عدد أيام الحضور لكل عضو خلال آخر 30 يوم
app.get("/api/senior/reports", ensureSeniorAdmin, async (req, res) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const agg = await AttendanceLog.aggregate([
        { $match: { type: "in", at: { $gte: since } } },
        { $group: { _id: "$discord", name: { $first: "$registeredName" }, unit: { $first: "$unit" }, rank: { $first: "$rank" }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: CONFIG.LOG_LIMIT },
    ]).option({ maxTimeMS: 10000 });
    res.json({ list: agg });
});

app.get("/api/senior/settings", ensureSeniorAdmin, async (req, res) => {
    res.json({ settings: await getSettings() });
});
app.post("/api/senior/settings/toggle", ensureSeniorAdmin, async (req, res) => {
    const { field } = req.body; // "lockAttendance" | "maintenance"
    if (!["lockAttendance", "maintenance"].includes(field)) return res.status(400).json({ error: "حقل غير صحيح" });
    const s = await getSettings();
    s[field] = !s[field];
    await s.save();
    res.json({ settings: s });
});
// تسجيل خروج جماعي فوري لكل من هو "حاضر" حاليًا
app.post("/api/senior/force-checkout-all", ensureSeniorAdmin, async (req, res) => {
    const now = new Date();
    const inList = await AttendanceStatus.find({ status: "in" });
    for (const st of inList) {
        st.status = "out";
        st.lastCheckOutAt = now;
        st.updatedAt = now;
        await st.save();
        await AttendanceLog.create({ discord: st.discord, discordTag: st.discordTag, registeredName: st.registeredName, unit: st.unit, rank: st.rank, type: "out", at: now });
    }
    res.json({ ok: true, affected: inList.length });
});
// تصفير عدّاد حضور اليوم لجميع الأعضاء (لا يمسح السجل التاريخي، فقط العداد اليومي)
app.post("/api/senior/reset-today", ensureSeniorAdmin, async (req, res) => {
    await AttendanceStatus.updateMany({}, { $set: { todayCount: 0 } });
    res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════
// 7) الواجهة — صفحة واحدة (SPA)
// ══════════════════════════════════════════════════════════════════════════
app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>${CONFIG.SITE_NAME}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
:root {
    --bg1:#0a1628; --bg2:#0d1f3c; --panel: rgba(255,255,255,0.04); --border: rgba(59,130,246,0.25);
    --gold:#3b82f6; --gold-soft:#60a5fa; --green:#1d4ed8; --green2:#3b82f6;
    --red:#ef4444; --amber:#eab308; --text:#e2e8f0; --muted:#64748b; --ok:#4ade80;
}
body { font-family:'Segoe UI', Tahoma, sans-serif; background:linear-gradient(160deg, var(--bg1), var(--bg2)); color:var(--text); min-height:100vh; padding-bottom:40px; }
.wrap { max-width:520px; margin:0 auto; padding:18px 14px; }
.card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:20px; margin-bottom:16px; box-shadow:0 4px 20px rgba(0,0,0,0.4); }
h1,h2,h3 { color:var(--gold-soft); }
.center { text-align:center; }
.row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.btn { display:inline-block; background:linear-gradient(135deg, var(--green), var(--green2)); color:#fff; border:none; border-radius:8px; padding:0.65rem 1.3rem; font-size:0.9rem; font-weight:700; cursor:pointer; transition:0.2s; }
.btn:hover { filter:brightness(1.1); }
.btn.gray { background:#334155; }
.btn.red { background:linear-gradient(135deg,#b91c1c,var(--red)); }
.btn.sm { padding:0.4rem 0.9rem; font-size:0.8rem; }
.muted { color:var(--muted); }
#toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#0d1f3c; padding:10px 20px; border-radius:10px; border:1px solid var(--gold); z-index:999; display:none; }

/* شعار الدخول */
.login-box { text-align:center; padding-top:80px; }
.login-box .logo { font-size:44px; margin-bottom:10px; }

/* رأس الصفحة الرئيسية */
.profile-head { display:flex; align-items:center; gap:12px; }
.profile-head .avatar { width:56px; height:56px; border-radius:50%; border:3px solid var(--gold); }
.profile-head .info b { font-size:17px; }
.profile-head .info div { font-size:12px; color:var(--muted); margin-top:2px; }

/* ساعة مكة */
.mecca-clock { text-align:center; font-size:13px; color:var(--muted); margin-bottom:4px; }
.mecca-clock b { color:var(--gold-soft); font-size:15px; }

/* دائرة البصمة */
.fp-wrap { display:flex; flex-direction:column; align-items:center; padding:20px 0 6px; user-select:none; }
.fp-ring { position:relative; width:190px; height:190px; border-radius:50%; display:flex; align-items:center; justify-content:center; }
.fp-ring .progress { position:absolute; inset:0; border-radius:50%; background: conic-gradient(var(--gold-soft) calc(var(--p,0)*1%), rgba(255,255,255,0.06) 0); transition:background 0.05s linear; }
.fp-ring .inner { position:relative; width:158px; height:158px; border-radius:50%; background:#0c1a30; border:2px solid var(--border); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; cursor:pointer; transition:transform .15s; }
.fp-ring .inner:active { transform:scale(0.97); }
.fp-ring.scanning .inner { border-color:var(--gold-soft); }
.fp-ring svg { width:64px; height:64px; stroke:var(--gold-soft); }
.fp-timer { font-weight:900; font-size:17px; color:#fff; }
.fp-hint { font-size:12px; color:var(--muted); margin-top:14px; }
.fp-status { text-align:center; min-height:22px; font-size:13px; margin-top:8px; font-weight:700; }
.fp-status.ok { color:var(--ok); }
.fp-status.fail { color:var(--red); }

/* قائمة الأعضاء */
.member-row { display:flex; align-items:center; justify-content:space-between; padding:12px 4px; border-bottom:1px solid var(--border); }
.member-row:last-child { border-bottom:none; }
.member-row b { font-size:14px; }
.member-row .sub { font-size:12px; color:var(--muted); margin-top:2px; }
.dot { width:10px; height:10px; border-radius:50%; background:var(--muted); flex-shrink:0; }
.dot.in { background:var(--ok); box-shadow:0 0 8px var(--ok); }

/* التبويبات الإدارية */
.tabs { display:flex; gap:6px; overflow-x:auto; margin-bottom:14px; }
.tab { flex-shrink:0; padding:8px 14px; border-radius:8px; background:var(--panel); border:1px solid var(--border); font-size:13px; cursor:pointer; color:var(--text); }
.tab.active { background:var(--green2); color:#fff; border-color:var(--green2); }
.stat { text-align:center; padding:14px; }
.stat .num { font-size:26px; font-weight:900; color:var(--gold-soft); }
.stat .lbl { font-size:12px; color:var(--muted); }
.stats-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
</style>
</head>
<body>
<div id="toast"></div>
<div class="wrap" id="app"></div>

<script>
let ME = null;
let holdTimer = null, holdStart = 0, scanning = false;
let currentTab = 'home';
let adminTab = 'dash';

function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2500);
}
async function api(path, opts = {}) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15000);
    try {
        const res = await fetch(path, {
            headers: { 'Content-Type': 'application/json' },
            signal: ctrl.signal, ...opts,
        });
        clearTimeout(timeout);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'حدث خطأ');
        return data;
    } catch (e) {
        clearTimeout(timeout);
        throw new Error(e.name === 'AbortError' ? 'انتهت مهلة الاتصال' : e.message);
    }
}

async function init() {
    try {
        ME = await api('/api/me');
    } catch (e) {
        renderLogin();
        return;
    }
    if (ME.blocked) { renderBlocked(ME); return; }
    renderHome();
    setInterval(pollHome, 5000);
    setInterval(updateClock, 1000);
}

function renderLogin() {
    document.getElementById('app').innerHTML = \`
        <div class="login-box">
            <div class="logo">🪪</div>
            <h1>${CONFIG.SITE_NAME}</h1>
            <p class="muted" style="margin:10px 0 26px;">نظام تحضير وانصراف عسكري بالبصمة — مرتبط بموقع فلاش</p>
            <a class="btn" href="/auth/discord">تسجيل دخول بالديسكورد</a>
        </div>\`;
}
function renderBlocked(data) {
    document.getElementById('app').innerHTML = \`
        <div class="login-box">
            <div class="logo">\${data.maintenance ? '🚨' : '🚫'}</div>
            <h2>غير متاح حالياً</h2>
            <p class="muted" style="margin-top:10px;">\${data.reason}</p>
            <a class="btn gray" style="margin-top:20px;" href="/auth/logout">خروج</a>
        </div>\`;
}

function renderHome() {
    document.getElementById('app').innerHTML = \`
        <div class="card">
            <div class="row">
                <div class="profile-head">
                    \${ME.avatar ? \`<img class="avatar" src="\${ME.avatar}">\` : '<div class="avatar" style="background:#1e3a5f;"></div>'}
                    <div class="info">
                        <b>\${ME.registeredName}</b>
                        <div>\${ME.sectorLabel} • \${ME.unit} • \${ME.rank}</div>
                    </div>
                </div>
                <a class="btn gray sm" href="/auth/logout">خروج</a>
            </div>
            \${ME.isSeniorAdmin ? '<button class="btn sm" style="margin-top:14px;width:100%;" onclick="renderAdmin()">🛡️ لوحة كبار المسؤولين</button>' : ''}
        </div>

        <div class="card">
            <div class="mecca-clock">نظام تبصيم — بتوقيت مكة المكرمة<br><b id="mecca-time">--:--:--</b></div>
            <div class="fp-wrap">
                <div class="fp-ring" id="fp-ring">
                    <div class="progress" id="fp-progress" style="--p:0;"></div>
                    <div class="inner" id="fp-inner">
                        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round">
                            <path d="M12 11c1 0 2 .8 2 2.2 0 2-1 3.5-1 5"/>
                            <path d="M8.5 12c0-2 1.5-3.7 3.5-3.7s3.5 1.7 3.5 3.7c0 1.3-.3 2.3-.7 3.3"/>
                            <path d="M6 11.5c0-3.3 2.7-6 6-6s6 2.7 6 6c0 1-.1 2-.4 3"/>
                            <path d="M4 11c0-4.4 3.6-8 8-8s8 3.6 8 8"/>
                            <path d="M10 15.5c-.5-1-.8-2.2-.8-3.5"/>
                        </svg>
                        <div class="fp-timer" id="fp-timer">اضغط باستمرار</div>
                    </div>
                </div>
                <div class="fp-hint">اضغط مع الاستمرار \${${CONFIG.HOLD_SECONDS}}.0 ثانية لتسجيل \${ME.status === 'in' ? 'الانصراف' : 'الحضور'}</div>
                <div class="fp-status" id="fp-status"></div>
            </div>
        </div>

        <div class="card">
            <h3 style="margin-bottom:8px;">الأعضاء المسجّلون بالموقع</h3>
            <div id="members-list"><p class="muted">جارِ التحميل...</p></div>
        </div>
    \`;
    bindFingerprint();
    updateClock();
    loadMembers();
}

function updateClock() {
    const el = document.getElementById('mecca-time');
    if (!el) return;
    el.textContent = new Date().toLocaleTimeString('ar-SA', { timeZone: 'Asia/Riyadh', hour12: true });
}

async function loadMembers() {
    const box = document.getElementById('members-list');
    if (!box) return;
    let list;
    try { ({ list } = await api('/api/members')); }
    catch (e) { box.innerHTML = \`<p style="color:#f87171;">تعذر التحميل (\${e.message})</p>\`; return; }
    if (!document.getElementById('members-list')) return;
    if (list.length === 0) { box.innerHTML = '<p class="muted">لا يوجد أعضاء مسجّلين بعد</p>'; return; }
    box.innerHTML = list.map(m => \`
        <div class="member-row">
            <div>
                <b>\${m.name}</b>
                <div class="sub">\${m.rank} • \${m.unit}</div>
            </div>
            <div class="dot \${m.status === 'in' ? 'in' : ''}"></div>
        </div>\`).join('');
}
async function pollHome() {
    if (currentTab !== 'home') return;
    loadMembers();
}

// ── منطق الضغط باستمرار على البصمة (3 ثواني) ──
function bindFingerprint() {
    const inner = document.getElementById('fp-inner');
    if (!inner) return;
    inner.addEventListener('pointerdown', startHold);
    inner.addEventListener('pointerup', cancelHold);
    inner.addEventListener('pointerleave', cancelHold);
    inner.addEventListener('pointercancel', cancelHold);
}
function startHold(e) {
    e.preventDefault();
    if (scanning) return;
    holdStart = Date.now();
    document.getElementById('fp-status').textContent = '';
    document.getElementById('fp-status').className = 'fp-status';
    tickHold();
}
function tickHold() {
    const total = ${CONFIG.HOLD_SECONDS} * 1000;
    const elapsed = Date.now() - holdStart;
    const remaining = Math.max(0, total - elapsed);
    const pct = Math.min(100, (elapsed / total) * 100);
    const ring = document.getElementById('fp-progress');
    const timer = document.getElementById('fp-timer');
    if (!ring || !timer) return;
    ring.style.setProperty('--p', pct.toFixed(1));
    timer.textContent = (remaining / 1000).toFixed(1) + ' ث';
    if (elapsed >= total) { doScan(); return; }
    holdTimer = requestAnimationFrame(tickHold);
}
function cancelHold() {
    if (scanning) return;
    cancelAnimationFrame(holdTimer);
    holdStart = 0;
    const ring = document.getElementById('fp-progress');
    const timer = document.getElementById('fp-timer');
    if (ring) ring.style.setProperty('--p', 0);
    if (timer) timer.textContent = 'اضغط باستمرار';
}
async function doScan() {
    cancelAnimationFrame(holdTimer);
    scanning = true;
    const ringEl = document.getElementById('fp-ring');
    const timer = document.getElementById('fp-timer');
    const statusEl = document.getElementById('fp-status');
    if (ringEl) ringEl.classList.add('scanning');
    if (timer) timer.textContent = 'جارِ القراءة...';
    try {
        const data = await api('/api/attendance/scan', { method: 'POST' });
        if (!data.success) {
            statusEl.textContent = '❌ فشلت البصمة، حاول مرة أخرى';
            statusEl.className = 'fp-status fail';
        } else {
            ME.status = data.status;
            statusEl.textContent = data.status === 'in' ? '✅ تم تسجيل الحضور' : '✅ تم تسجيل الانصراف';
            statusEl.className = 'fp-status ok';
            const hint = document.querySelector('.fp-hint');
            if (hint) hint.textContent = \`اضغط مع الاستمرار ${CONFIG.HOLD_SECONDS}.0 ثانية لتسجيل \${ME.status === 'in' ? 'الانصراف' : 'الحضور'}\`;
            loadMembers();
        }
    } catch (e) {
        statusEl.textContent = 'تعذر الاتصال بالخادم — ' + e.message;
        statusEl.className = 'fp-status fail';
    }
    if (ringEl) ringEl.classList.remove('scanning');
    document.getElementById('fp-progress').style.setProperty('--p', 0);
    if (timer) timer.textContent = 'اضغط باستمرار';
    scanning = false;
}

// ══════════════════════════════════════════════════════════════════════════
// لوحة كبار المسؤولين
// ══════════════════════════════════════════════════════════════════════════
const ADMIN_TABS = [
    { id: 'dash', label: '📊 لوحة التحكم' },
    { id: 'members', label: '👥 الأعضاء' },
    { id: 'log', label: '📜 السجل' },
    { id: 'reports', label: '📈 التقارير' },
    { id: 'settings', label: '⚙️ الإعدادات' },
];
function renderAdmin() {
    currentTab = 'admin';
    document.getElementById('app').innerHTML = \`
        <div class="row" style="margin-bottom:14px;">
            <h2>🛡️ لوحة كبار المسؤولين</h2>
            <button class="btn gray sm" onclick="currentTab='home';renderHome();">🏠 الرئيسية</button>
        </div>
        <div class="tabs">\${ADMIN_TABS.map(t => \`<div class="tab \${adminTab === t.id ? 'active' : ''}" onclick="switchAdminTab('\${t.id}')">\${t.label}</div>\`).join('')}</div>
        <div id="admin-content"><div class="card center muted">جارِ التحميل...</div></div>
    \`;
    loadAdminTab();
}
function switchAdminTab(id) { adminTab = id; loadAdminTab(); }
async function loadAdminTab() {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    renderAdminTabsBar();
    if (adminTab === 'dash') return loadDash();
    if (adminTab === 'members') return loadAdminMembers();
    if (adminTab === 'log') return loadLog();
    if (adminTab === 'reports') return loadReports();
    if (adminTab === 'settings') return loadAdminSettings();
}
function renderAdminTabsBar() {
    const bar = document.querySelector('.tabs');
    if (bar) bar.innerHTML = ADMIN_TABS.map(t => \`<div class="tab \${adminTab === t.id ? 'active' : ''}" onclick="switchAdminTab('\${t.id}')">\${t.label}</div>\`).join('');
}

async function loadDash() {
    const box = document.getElementById('admin-content');
    let d;
    try { d = await api('/api/senior/dashboard'); }
    catch (e) { box.innerHTML = \`<div class="card" style="color:#f87171;">تعذر التحميل (\${e.message})</div>\`; return; }
    box.innerHTML = \`
        <div class="stats-grid">
            <div class="card stat"><div class="num">\${d.total}</div><div class="lbl">إجمالي المسجّلين</div></div>
            <div class="card stat"><div class="num" style="color:var(--ok);">\${d.checkedIn}</div><div class="lbl">حاضرون الآن</div></div>
            <div class="card stat"><div class="num">\${d.checkedOut}</div><div class="lbl">منصرفون</div></div>
            <div class="card stat"><div class="num">\${d.todayLogs}</div><div class="lbl">حركات اليوم</div></div>
        </div>\`;
}

async function loadAdminMembers() {
    const box = document.getElementById('admin-content');
    let list;
    try { ({ list } = await api('/api/senior/members')); }
    catch (e) { box.innerHTML = \`<div class="card" style="color:#f87171;">تعذر التحميل (\${e.message})</div>\`; return; }
    box.innerHTML = list.length === 0 ? '<div class="card center muted">لا يوجد أعضاء بعد</div>' : list.map(m => \`
        <div class="card row">
            <div>
                <b>\${m.registeredName || m.discordTag}</b>
                <div class="sub muted" style="font-size:12px;">\${m.rank || '-'} • \${m.unit || '-'} • \${m.sectorLabel || '-'}</div>
            </div>
            <div class="row" style="gap:6px;">
                <span class="dot \${m.status === 'in' ? 'in' : ''}"></span>
                <button class="btn sm \${m.status === 'in' ? 'gray' : ''}" onclick="forceStatus('\${m.discord}','in')">تحضير</button>
                <button class="btn sm red" onclick="forceStatus('\${m.discord}','out')">انصراف</button>
            </div>
        </div>\`).join('');
}
async function forceStatus(discord, type) {
    try { await api('/api/senior/members/' + discord + '/force/' + type, { method: 'POST' }); toast('تم التحديث'); loadAdminMembers(); }
    catch (e) { toast(e.message); }
}

async function loadLog() {
    const box = document.getElementById('admin-content');
    let list;
    try { ({ list } = await api('/api/senior/log')); }
    catch (e) { box.innerHTML = \`<div class="card" style="color:#f87171;">تعذر التحميل (\${e.message})</div>\`; return; }
    box.innerHTML = list.length === 0 ? '<div class="card center muted">لا يوجد سجل بعد</div>' : list.map(l => \`
        <div class="card row">
            <div>
                <b>\${l.registeredName || l.discordTag}</b>
                <div class="sub muted" style="font-size:12px;">\${l.unit || '-'} • \${l.rank || '-'}</div>
            </div>
            <div style="text-align:left;">
                <div style="color:\${l.type === 'in' ? 'var(--ok)' : 'var(--red)'};font-weight:700;">\${l.type === 'in' ? 'حضور' : 'انصراف'}</div>
                <div class="muted" style="font-size:11px;">\${new Date(l.at).toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' })}</div>
            </div>
        </div>\`).join('');
}

async function loadReports() {
    const box = document.getElementById('admin-content');
    let list;
    try { ({ list } = await api('/api/senior/reports')); }
    catch (e) { box.innerHTML = \`<div class="card" style="color:#f87171;">تعذر التحميل (\${e.message})</div>\`; return; }
    box.innerHTML = \`<div class="card"><p class="muted" style="font-size:13px;margin-bottom:10px;">عدد أيام الحضور خلال آخر 30 يوم</p></div>\` +
        (list.length === 0 ? '<div class="card center muted">لا توجد بيانات بعد</div>' : list.map((r, i) => \`
        <div class="card row">
            <div><b>\${i + 1}. \${r.name || '-'}</b><div class="sub muted" style="font-size:12px;">\${r.unit || '-'} • \${r.rank || '-'}</div></div>
            <div class="num" style="font-size:20px;color:var(--gold-soft);">\${r.count}</div>
        </div>\`).join(''));
}

async function loadAdminSettings() {
    const box = document.getElementById('admin-content');
    let settings;
    try { ({ settings } = await api('/api/senior/settings')); }
    catch (e) { box.innerHTML = \`<div class="card" style="color:#f87171;">تعذر التحميل (\${e.message})</div>\`; return; }
    box.innerHTML = \`
        <div class="card">
            <button class="btn \${settings.lockAttendance ? 'red' : ''}" style="width:100%;margin-bottom:10px;" onclick="toggleSetting('lockAttendance')">
                🔒 \${settings.lockAttendance ? 'إلغاء قفل تسجيل الحضور' : 'قفل تسجيل الحضور'}
            </button>
            <button class="btn \${settings.maintenance ? 'red' : ''}" style="width:100%;margin-bottom:10px;" onclick="toggleSetting('maintenance')">
                🚨 \${settings.maintenance ? 'إلغاء وضع الصيانة' : 'تفعيل وضع الصيانة'}
            </button>
            <button class="btn gray" style="width:100%;margin-bottom:10px;" onclick="forceCheckoutAll()">
                🚪 تسجيل خروج جماعي فوري للجميع
            </button>
            <button class="btn gray" style="width:100%;" onclick="resetToday()">
                🔄 تصفير عدّاد حضور اليوم
            </button>
        </div>\`;
}
async function toggleSetting(field) {
    try { await api('/api/senior/settings/toggle', { method: 'POST', body: JSON.stringify({ field }) }); toast('تم الحفظ'); loadAdminSettings(); }
    catch (e) { toast(e.message); }
}
async function forceCheckoutAll() {
    if (!confirm('متأكد تبي تسجل خروج جميع الحاضرين الآن؟')) return;
    try { const r = await api('/api/senior/force-checkout-all', { method: 'POST' }); toast('تم تسجيل خروج ' + r.affected + ' عضو'); }
    catch (e) { toast(e.message); }
}
async function resetToday() {
    if (!confirm('متأكد تبي تصفّر عدّاد حضور اليوم لجميع الأعضاء؟')) return;
    try { await api('/api/senior/reset-today', { method: 'POST' }); toast('تم التصفير'); }
    catch (e) { toast(e.message); }
}

init();
</script>
</body>
</html>`);
});

app.listen(CONFIG.PORT, "0.0.0.0", () => {
    console.log(`🚀 ${CONFIG.SITE_NAME} server running on port ${CONFIG.PORT}`);
});
