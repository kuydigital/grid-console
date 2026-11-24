// Grid Console — engine. Copyright (c) 2026 KUYDIGITAL. MIT License.
// The engine is model-agnostic: it connects, routes the watch to a profile
// (profiles/*.js), and builds the UI from that profile's `features` list using
// the shared feature modules below. Per-model byte layouts come from the profile.
import { PROFILES, CASIO_SERVICES, GENERIC, matchProfile } from "./profiles/registry.js";

/* ---------- tiny helpers ---------- */
const $ = (id) => document.getElementById(id);
const pad = (n) => (n < 10 ? "0" + n : "" + n);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ascii = (a, s) => Array.from(a.slice(s)).filter((b) => b >= 32 && b < 127).map((b) => String.fromCharCode(b)).join("").replace(/\0+$/, "").trim();
function log(msg, cls) { const d = document.createElement("div"); if (cls) d.className = cls; d.innerHTML = msg; const L = $("log"); L.appendChild(d); L.scrollTop = L.scrollHeight; }
function fmtHM(h, m, h24) { return h24 ? pad(h) + ":" + pad(m) : (h % 12 || 12) + ":" + pad(m) + " " + (h < 12 ? "AM" : "PM"); }
const bcd = (n) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff;
const unbcd = (b) => (b == null ? 0 : ((b >> 4) & 0x0f) * 10 + (b & 0x0f));
const utf8 = (s) => Array.from(new TextEncoder().encode(s));
const ts15 = () => { const d = new Date(); return "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "T" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); };
const field = (arr, bytes) => { arr.push(bytes.length & 0xff, (bytes.length >> 8) & 0xff); for (let i = 0; i < bytes.length; i++) arr.push(bytes[i]); };
const NAME_RE = /[^A-Z0-9/+\-_!?&]/g;
const normName = (s) => (s || "").toUpperCase().replace(/ /g, "_").replace(NAME_RE, "").slice(0, 14);
let noteId = 1;
let findAudio = null;

// Shared Casio 2C/"All Features" world-time city table (protocol fact; family-wide).
// name -> [A, B, offset, dstOffset, dstRules] (from Gadgetbridge CasioTimeZone + capture)
const CITY_TABLE = {
  "PAGO PAGO": [0xd7, 0, 0xd4, 4, 0], "HONOLULU": [0x7b, 0, 0xd8, 4, 0], "ANCHORAGE": [0x0c, 0, 0xdc, 4, 1],
  "LAS VEGAS": [0x9c, 0, 0xe0, 4, 1], "LOS ANGELES": [0xa1, 0, 0xe0, 4, 1], "DENVER": [0x54, 0, 0xe4, 4, 1],
  "CHICAGO": [0x42, 0, 0xe8, 4, 1], "NEW YORK": [0xca, 0, 0xec, 4, 1], "HALIFAX": [0x71, 0, 0xf0, 4, 1],
  "RIO DE JANEIRO": [0xf1, 0, 0xf4, 4, 0], "UTC": [0, 0, 0, 0, 0], "LONDON": [0xa0, 0, 0, 4, 2],
  "PARIS": [0xdc, 0, 0x04, 4, 2], "ATHENS": [0x13, 0, 0x08, 4, 2], "JEDDAH": [0x85, 0, 0x0c, 4, 0],
  "DUBAI": [0x5b, 0, 0x10, 4, 0], "KARACHI": [0x8b, 0, 0x14, 4, 0], "DELHI": [0x52, 0, 0x16, 4, 0],
  "DHAKA": [0x56, 0, 0x18, 4, 0], "YANGON": [0x2f, 1, 0x1a, 4, 0], "BANGKOK": [0x1c, 0, 0x1c, 4, 0],
  "HONG KONG": [0x7a, 0, 0x20, 4, 0], "PYONGYANG": [0xea, 0, 0x24, 4, 0], "TOKYO": [0x19, 1, 0x24, 4, 0],
  "ADELAIDE": [0x05, 0, 0x26, 4, 4], "SYDNEY": [0x0f, 1, 0x28, 4, 4], "NOUMEA": [0xcd, 0, 0x2c, 4, 0],
  "WELLINGTON": [0x2b, 1, 0x30, 4, 5], "NUKUALOFA": [0xd0, 0, 0x34, 4, 0], "KIRITIMATI": [0x93, 0, 0x38, 4, 0],
};

/* ---------- BLE + app state ---------- */
const ble = { device: null, server: null, service: null, req: null, all: null, note: null, convoyReq: null, convoyRx: null, q: [], convoy: [] };
const state = {
  mode: "offline", profile: GENERIC, name: "—",
  basic: { h24: true, tone: true, light: false, vib: false },
  alarms: [], info: { name: "—", fw: "—", city: "—", condition: "—" }, lastSync: "—",
  timers: [], repeat: 1, cities: ["—", "—"],
  person: { female: false, right: false }, activity: { date: "—", steps: "—", cals: "—" },
  gatt: [],
};
const mounted = [];   // [{id, root, mod}]
let clockTimer = null;

/* ---------- BLE primitives ---------- */
function onNotify(ev) {
  const raw = new Uint8Array(ev.target.value.buffer);
  // Casio feature responses are prefixed 0xff 0x81; strip it so profile byte offsets line up.
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0x81) { ble.q.push(raw.subarray(2)); return; }
  // Unsolicited watch-initiated frame (e.g. find-phone) — let mounted modules react.
  for (const x of mounted) { if (x.mod.onFrame) { try { x.mod.onFrame(raw, x.root, x.ctx); } catch (e) {} } }
}
function onConvoy(ev) { const d = new Uint8Array(ev.target.value.buffer); for (let i = 0; i < d.length; i++) ble.convoy.push(d[i]); }
async function request(bytes, t = 2500) {
  ble.q.length = 0;
  await ble.req.writeValueWithoutResponse(new Uint8Array(bytes));
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (ble.q.length) return ble.q.shift(); await delay(30); }
  return null;
}
async function safeRead(bytes) { try { return await request(bytes); } catch (e) { return null; } }
async function writeAll(bytes) { await ble.all.writeValueWithResponse(new Uint8Array(bytes)); }

async function connect() {
  if (state.mode === "live") { disconnect(); return; }
  if (!navigator.bluetooth) { log("Web Bluetooth not available — use Chrome or Edge over HTTPS.", "e"); return; }
  try {
    log("Requesting device…", "m");
    ble.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: CASIO_SERVICES });
    ble.device.addEventListener("gattserverdisconnected", () => { if (state.mode === "live") { log("Link dropped.", "e"); setMode("offline"); } });
    ble.server = await ble.device.gatt.connect();
    state.name = ble.device.name || "(unnamed)";
    log("Connected to <b>" + state.name + "</b>. Discovering services…", "g");
    await discover();
    route();
    await bindChars();
    if (ble.all) { await ble.all.startNotifications(); ble.all.addEventListener("characteristicvaluechanged", onNotify); }
    if (ble.convoyRx) { try { await ble.convoyRx.startNotifications(); ble.convoyRx.addEventListener("characteristicvaluechanged", onConvoy); } catch (e) {} }
    setMode("live");
    await refresh();
  } catch (e) { log("Connect failed: " + e.message, "e"); setMode(navigator.bluetooth ? "offline" : "demo"); }
}
function disconnect() { try { ble.device && ble.device.gatt.connected && ble.device.gatt.disconnect(); } catch (e) {} setMode("offline"); }

async function discover() {
  state.gatt = [];
  const svcs = await ble.server.getPrimaryServices();
  for (const s of svcs) {
    const chars = await s.getCharacteristics();
    state.gatt.push({ service: s.uuid, chars: chars.map((c) => ({ uuid: c.uuid, props: c.properties })) });
  }
}

/* ---------- routing: watch -> profile ---------- */
function route() {
  const p = matchProfile(state.name) || GENERIC;
  state.profile = p;
  ble.service = null; ble.req = null; ble.all = null;
  buildUI();
  const mb = $("modelbar");
  if (p.id === "generic") mb.innerHTML = 'Connected: <b>' + state.name + '</b> &#183; <span class="warn">no profile — Diagnostic mode.</span> Capture &amp; submit its protocol to add support.';
  else mb.innerHTML = 'Profile: <b>' + p.label + '</b> &#183; ' + (p.verified ? '<span class="ok">verified on hardware</span>' : '<span class="warn">&#9888; unverified on this model</span>');
}

// Resolve characteristic GATT objects for the active profile (call after connect)
async function bindChars() {
  const p = state.profile;
  if (!p.service) return;
  try {
    const svc = await ble.server.getPrimaryService(p.service);
    ble.service = svc;
    if (p.chars.req) ble.req = await svc.getCharacteristic(p.chars.req);
    if (p.chars.all) ble.all = await svc.getCharacteristic(p.chars.all);
    // Optional channels: notification sink (Signal/Finder) and convoy pair (Activity).
    ble.note = ble.convoyReq = ble.convoyRx = null;
    if (p.chars.note) { try { ble.note = await svc.getCharacteristic(p.chars.note); } catch (e) {} }
    if (p.chars.convoyReq) { try { ble.convoyReq = await svc.getCharacteristic(p.chars.convoyReq); } catch (e) {} }
    if (p.chars.convoyRx) { try { ble.convoyRx = await svc.getCharacteristic(p.chars.convoyRx); } catch (e) {} }
  } catch (e) { log("Service bind failed: " + e.message, "e"); }
}

/* ---------- UI build / mode ---------- */
function buildUI() {
  const tabs = $("tabs"), panels = $("panels");
  tabs.innerHTML = ""; panels.innerHTML = ""; mounted.length = 0;
  (state.profile.features || ["diagnostic"]).forEach((fid, i) => {
    const mod = MODULES[fid]; if (!mod) return;
    const tab = document.createElement("button");
    tab.className = "tab"; tab.setAttribute("role", "tab"); tab.setAttribute("data-sec", fid);
    tab.setAttribute("aria-selected", i === 0 ? "true" : "false"); tab.textContent = mod.label;
    tabs.appendChild(tab);
    const sec = document.createElement("section"); sec.setAttribute("data-sec", fid); sec.hidden = i !== 0;
    sec.innerHTML = '<div class="panel">' + mod.html(state.profile) + "</div>";
    panels.appendChild(sec);
    const ctx = { state, profile: state.profile, request, safeRead, writeAll, log, refreshAll, pad, clamp, hex, fmtHM, ble, delay, ascii, bcd, unbcd, utf8, ts15, field, normName };
    if (mod.mount) mod.mount(sec, ctx);
    mounted.push({ id: fid, root: sec, mod, ctx });
  });
  tabs.onclick = (ev) => {
    const t = ev.target.closest(".tab"); if (!t) return;
    const sec = t.getAttribute("data-sec");
    tabs.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-selected", x === t ? "true" : "false"));
    panels.querySelectorAll("section[data-sec]").forEach((s) => (s.hidden = s.getAttribute("data-sec") !== sec));
  };
  refreshAll();
}
function setMode(m) {
  state.mode = m;
  $("chip").setAttribute("data-mode", m);
  $("chipText").textContent = m === "live" ? "Live Link" : (m === "demo" ? "Preview" : "Offline");
  $("connectBtn").textContent = m === "live" ? "Disconnect" : "Connect";
  const live = m === "live";
  $("panels").querySelectorAll("[data-write]").forEach((e) => (e.disabled = !live));
  if (m === "offline") { $("modelbar").innerHTML = "No watch connected &#183; Bluetooth control for Casio G&#8209;Shock watches."; }
  refreshAll();
}
function refreshAll() { mounted.forEach((x) => x.mod.refresh && x.mod.refresh(x.root, x.ctx)); }

/* read everything the active profile knows about */
async function refresh() {
  for (const x of mounted) { if (x.mod.load) { try { await x.mod.load(x.ctx); } catch (e) {} } }
  state.lastSync = new Date().toLocaleTimeString();
  refreshAll();
  log("Readout refreshed.", "g");
}

/* ===================================================================
   SHARED FEATURE MODULES
   Each is reusable across models; per-model specifics come from `profile`.
   =================================================================== */
const MODULES = {
  /* ---- TIME ---- */
  time: {
    label: "Time",
    html: () => `
      <p class="eyebrow">Time</p>
      <div class="lcd">
        <div class="lcd-top"><span>TIME</span><span><b id="t_mer"></b> <span id="t_fmt">24H</span></span></div>
        <div class="big"><span class="ghost">88:88</span><span class="digits" id="t_time">--:--</span> <span class="secs" id="t_secs">--</span></div>
        <div class="lcd-bot"><span id="t_date">—</span><span>UNIT <b id="t_unit">—</b></span></div>
      </div>
      <div class="actions">
        <button class="primary" id="t_sync" data-write disabled>Sync Watch Time</button>
        <button id="t_refresh" data-write disabled>Refresh Readout</button>
      </div>
      <p class="note" style="margin-top:12px">Clock shows <b>this device's</b> time in the watch's 12/24 format. <b>Sync</b> sets the watch clock to now.</p>`,
    mount(root, ctx) {
      root.querySelector("#t_sync").onclick = async () => {
        if (ctx.state.mode !== "live") return;
        try {
          const d = new Date();
          await ctx.writeAll([0x09, d.getFullYear() - 2000, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), (d.getDay() + 6) % 7, 0, 1]);
          ctx.log("Watch time synced to " + d.toLocaleTimeString() + ".", "g");
        } catch (e) { ctx.log("Sync failed: " + e.message, "e"); }
      };
      root.querySelector("#t_refresh").onclick = () => refresh();
      if (clockTimer) clearInterval(clockTimer);
      clockTimer = setInterval(() => MODULES.time.refresh(root, ctx), 1000);
    },
    refresh(root, ctx) {
      const d = new Date(), h = d.getHours(), h24 = ctx.state.basic.h24;
      root.querySelector("#t_time").textContent = h24 ? pad(h) + ":" + pad(d.getMinutes()) : (h % 12 || 12) + ":" + pad(d.getMinutes());
      root.querySelector("#t_mer").textContent = h24 ? "" : (h < 12 ? "AM" : "PM");
      root.querySelector("#t_fmt").textContent = h24 ? "24H" : "12H";
      root.querySelector("#t_secs").textContent = pad(d.getSeconds());
      root.querySelector("#t_date").textContent = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()] + " " + pad(d.getDate());
      root.querySelector("#t_unit").textContent = (ctx.state.info.name || "—").replace(/^CASIO\s+/i, "");
    },
  },

  /* ---- ALARMS ---- */
  alarms: {
    label: "Alarm",
    html: (p) => `<p class="eyebrow">Alarms &#183; ${p.alarms ? p.alarms.count : 5}</p><div id="al_list"></div>`,
    mount(root, ctx) {
      root.querySelector("#al_list").addEventListener("click", (ev) => {
        const btn = ev.target.closest("button"), row = ev.target.closest(".alarm"); if (!btn || !row) return;
        const n = +row.getAttribute("data-n"), a = ctx.state.alarms[n - 1];
        if (btn.hasAttribute("data-set")) {
          const hEl = row.querySelector("[data-h]"), ap = row.querySelector("[data-ap]");
          let hh = clamp(+hEl.value || 0, ap ? 1 : 0, ap ? 12 : 23);
          if (ap) { hh = hh % 12; if (ap.value === "PM") hh += 12; }
          writeAlarm(ctx, n, hh, clamp(+row.querySelector("[data-m]").value || 0, 0, 59), true);
        } else if (btn.hasAttribute("data-toggle")) writeAlarm(ctx, n, a.h, a.m, !a.on);
      });
    },
    async load(ctx) {
      const L = ctx.profile.alarms || { count: 5, feat1: 0x15, featN: 0x16 };
      ctx.state.alarms = [];
      const a1 = await ctx.safeRead([L.feat1]); ctx.state.alarms[0] = a1 ? { h: a1[3], m: a1[4], on: (a1[1] & 0x40) !== 0 } : { h: 0, m: 0, on: false };
      const aN = await ctx.safeRead([L.featN]);
      for (let n = 2; n <= L.count; n++) { const o = 1 + (n - 2) * 4; ctx.state.alarms[n - 1] = aN ? { h: aN[o + 2], m: aN[o + 3], on: (aN[o] & 0x40) !== 0 } : { h: 0, m: 0, on: false }; }
    },
    refresh(root, ctx) {
      if (!ctx.state.alarms.length) { const c = (ctx.profile.alarms || { count: 5 }).count; ctx.state.alarms = Array.from({ length: c }, (_, i) => ({ h: 6 + i, m: 0, on: false })); }
      const dis = ctx.state.mode !== "live" ? " disabled" : "", h24 = ctx.state.basic.h24, box = root.querySelector("#al_list");
      box.innerHTML = ctx.state.alarms.map((a, i) => {
        const n = i + 1; let editHour;
        if (h24) editHour = `<input type="number" min="0" max="23" value="${a.h}" data-h${dis}>`;
        else { const mer = a.h < 12 ? "AM" : "PM"; editHour = `<input type="number" min="1" max="12" value="${a.h % 12 || 12}" data-h${dis}><select data-ap${dis}><option${mer === "AM" ? " selected" : ""}>AM</option><option${mer === "PM" ? " selected" : ""}>PM</option></select>`; }
        return `<div class="alarm" data-n="${n}"><span class="idx">AL${n}</span><span class="t">${fmtHM(a.h, a.m, h24)}</span>` +
          `<span class="state ${a.on ? "on" : "off"}">${a.on ? "On" : "Off"}</span>` +
          `<span class="edit">${editHour}<span class="colon-sep">:</span><input type="number" min="0" max="59" value="${a.m}" data-m${dis}>` +
          `<button class="mini" data-set${dis}>Set</button><button class="mini" data-toggle${dis}>${a.on ? "Off" : "On"}</button></span></div>`;
      }).join("");
    },
  },

  /* ---- SETTINGS ---- */
  settings: {
    label: "Set",
    html: () => `
      <p class="eyebrow">Display &amp; Sound</p>
      <div class="toggle"><span class="lab">24-Hour Time<small>12h / 24h format</small></span><button class="sw" id="s_h24" aria-pressed="false" data-write disabled></button></div>
      <div class="toggle"><span class="lab">Button Tone<small>key beep on/off</small></span><button class="sw" id="s_tone" aria-pressed="false" data-write disabled></button></div>
      <div class="toggle"><span class="lab">Auto Light<small>tilt-to-light</small></span><button class="sw" id="s_light" aria-pressed="false" data-write disabled></button></div>
      <div class="toggle"><span class="lab">Key Vibration<small>haptic feedback</small></span><button class="sw" id="s_vib" aria-pressed="false" data-write disabled></button></div>`,
    mount(root, ctx) {
      const map = { s_h24: "h24", s_tone: "tone", s_light: "light", s_vib: "vib" };
      Object.keys(map).forEach((id) => { root.querySelector("#" + id).onclick = () => writeBasic(ctx, map[id], !ctx.state.basic[map[id]]); });
    },
    async load(ctx) { const b = ctx.profile.basic; const a = await ctx.safeRead([b.feat]); if (a) parseBasic(ctx, a); },
    refresh(root, ctx) {
      root.querySelector("#s_h24").setAttribute("aria-pressed", ctx.state.basic.h24 ? "true" : "false");
      root.querySelector("#s_tone").setAttribute("aria-pressed", ctx.state.basic.tone ? "true" : "false");
      root.querySelector("#s_light").setAttribute("aria-pressed", ctx.state.basic.light ? "true" : "false");
      root.querySelector("#s_vib").setAttribute("aria-pressed", ctx.state.basic.vib ? "true" : "false");
    },
  },

  /* ---- TIMERS ---- */
  timers: {
    label: "Timer",
    html: (p) => `
      <p class="eyebrow">Interval Timers &#183; ${(p.timers ? p.timers.count : 5)} Slots</p>
      <div class="row"><label class="k" for="tm_rep">Auto-Repeat</label>
        <input type="number" id="tm_rep" min="1" max="20" value="1" data-write disabled>
        <span class="note">cycles (1&#8211;20)</span></div>
      <div class="tlist" id="tm_list" style="margin-top:12px"></div>
      <div class="actions"><button class="primary" id="tm_send" data-write disabled>Send Timers</button></div>
      <p class="note">Names up to 14 chars (A&#8211;Z 0&#8211;9 and / + - _ ! ? &amp;). Each slot is mm:ss (minutes 0&#8211;60, seconds 0&#8211;59). Empty = skipped.</p>`,
    mount(root, ctx) {
      const L = ctx.profile.timers || { count: 5 };
      if (!ctx.state.timers.length) ctx.state.timers = Array.from({ length: L.count }, (_, i) => ({ name: "", min: i === 0 ? 5 : 0, sec: 0 }));
      root.querySelector("#tm_send").onclick = () => sendTimers(ctx, root);
    },
    async load(ctx) {
      const L = ctx.profile.timers; if (!L) return;
      const cfg = await ctx.safeRead([L.cfg]);
      if (cfg) { ctx.state.repeat = clamp(cfg[1] || 1, 1, 20); for (let i = 0; i < L.count; i++) { const b = 2 + i * 3; ctx.state.timers[i] = { ...(ctx.state.timers[i] || { name: "" }), sec: unbcd(cfg[b]), min: unbcd(cfg[b + 1]) }; } }
      for (let s = 0; s < L.count; s++) { const nm = await ctx.safeRead([L.name, s + 1]); if (nm) ctx.state.timers[s].name = ctx.ascii(nm, 2); }
    },
    refresh(root, ctx) {
      const L = ctx.profile.timers || { count: 5 };
      if (!ctx.state.timers.length) ctx.state.timers = Array.from({ length: L.count }, (_, i) => ({ name: "", min: i === 0 ? 5 : 0, sec: 0 }));
      const dis = ctx.state.mode !== "live" ? " disabled" : "", rep = root.querySelector("#tm_rep");
      if (rep) rep.value = ctx.state.repeat || 1;
      root.querySelector("#tm_list").innerHTML = ctx.state.timers.map((tm, i) =>
        `<div class="trow" data-i="${i}"><span class="idx">T${i + 1}</span>` +
        `<input type="text" maxlength="14" value="${tm.name || ""}" data-name placeholder="NAME" data-write${dis}>` +
        `<input type="number" min="0" max="60" value="${tm.min}" data-mm aria-label="T${i + 1} minutes" data-write${dis}>` +
        `<span class="colon-sep">:</span><input type="number" min="0" max="59" value="${tm.sec}" data-ss aria-label="T${i + 1} seconds" data-write${dis}></div>`).join("");
    },
  },

  /* ---- WORLD TIME ---- */
  world: {
    label: "World",
    html: () => `
      <p class="eyebrow">World Time &#183; Cities</p>
      <div class="tiles">
        <div class="tile"><div class="k">Home (Slot 0)</div><div class="v" id="w_c0">—</div></div>
        <div class="tile"><div class="k">World (Slot 1)</div><div class="v" id="w_c1">—</div></div>
      </div>
      <div class="row" style="margin-top:14px">
        <label class="k" for="w_slot">Slot</label>
        <select id="w_slot" data-write disabled><option value="1">World</option><option value="0">Home</option></select>
        <label class="k" for="w_city">City</label>
        <select id="w_city" data-write disabled></select>
        <button class="primary" id="w_set" data-write disabled>Set City</button>
      </div>
      <p class="note" style="margin-top:12px">Writes the full timezone session the watch expects (reverse-engineered from the official app). Verified live on a GBD-200 for Wellington, Tokyo and Las Vegas.</p>`,
    mount(root, ctx) {
      const sel = root.querySelector("#w_city");
      Object.keys(CITY_TABLE).sort().forEach((c) => { const o = document.createElement("option"); o.value = o.textContent = c; sel.appendChild(o); });
      sel.value = "TOKYO";
      root.querySelector("#w_set").onclick = () => applyWorldCity(ctx, root);
    },
    async load(ctx) {
      const W = ctx.profile.world; if (!W) return;
      const c0 = await ctx.safeRead([W.list, 0]); if (c0) ctx.state.cities[0] = ctx.ascii(c0, 2);
      const c1 = await ctx.safeRead([W.list, 1]); if (c1) ctx.state.cities[1] = ctx.ascii(c1, 2);
    },
    refresh(root, ctx) {
      root.querySelector("#w_c0").textContent = ctx.state.cities[0] || "—";
      root.querySelector("#w_c1").textContent = ctx.state.cities[1] || "—";
    },
  },

  /* ---- SIGNAL (push notification) ---- */
  signal: {
    label: "Signal",
    html: () => `
      <p class="eyebrow">Signal &#183; Push Notification</p>
      <div class="row"><label class="k" for="sg_title">Title</label><input type="text" id="sg_title" maxlength="32" value="GRID" style="flex:1 1 160px" data-write disabled></div>
      <div class="row"><label class="k" for="sg_msg">Message</label><input type="text" id="sg_msg" maxlength="120" value="SYSTEM ONLINE" style="flex:1 1 220px" data-write disabled></div>
      <div class="row">
        <label class="k" for="sg_cat">Icon</label>
        <select id="sg_cat" data-write disabled>
          <option value="0">Other</option><option value="1">Incoming Call</option><option value="2">Missed Call</option>
          <option value="4">Message</option><option value="5">Schedule</option><option value="6">Email</option>
          <option value="7">News</option><option value="8">Fitness</option><option value="11">Entertainment</option>
        </select>
        <label class="k" style="margin-left:8px"><input type="checkbox" id="sg_buzz" checked data-write disabled> Buzz</label>
      </div>
      <div class="actions"><button class="primary" id="sg_send" data-write disabled>Send To Watch</button><button class="warn" id="sg_clear" data-write disabled>Clear Last</button></div>
      <p class="note">Pushes a notification over the watch's notification characteristic (bytes transmitted inverted, per the Casio protocol). Needs a model whose profile declares a notification channel.</p>`,
    mount(root, ctx) {
      root.querySelector("#sg_send").onclick = () => sendNotification(ctx, root, false);
      root.querySelector("#sg_clear").onclick = () => sendNotification(ctx, root, true);
    },
  },

  /* ---- FINDER (two-way) ---- */
  finder: {
    label: "Finder",
    html: () => `
      <p class="eyebrow">Phone Finder &#183; Two-Way</p>
      <div class="actions"><button class="primary" id="fn_buzz" data-write disabled>Buzz My Watch</button></div>
      <p id="fn_alert" class="note" style="color:var(--red);font-size:15px" hidden>&#128227; THE WATCH IS LOOKING FOR THIS PHONE</p>
      <p class="note" style="margin-top:12px"><b>Buzz My Watch</b> pushes an alert so the watch vibrates/beeps. When you hold the watch's button to <b>find your phone</b>, this page sounds an alarm — keep it open with sound on.</p>`,
    mount(root, ctx) { root.querySelector("#fn_buzz").onclick = () => buzzWatch(ctx); },
    onFrame(raw, root, ctx) { if (raw.length > 1 && raw[0] === 0x0a && raw[1] === 0x02) findPhoneAlarm(root, ctx); },
  },

  /* ---- ACTIVITY (read-only) ---- */
  activity: {
    label: "Activity",
    html: () => `
      <p class="eyebrow">Activity &#183; Today</p>
      <div class="tiles">
        <div class="tile"><div class="k">Date (UTC)</div><div class="v small" id="ac_date">—</div></div>
        <div class="tile"><div class="k">Steps</div><div class="v" id="ac_steps">—</div></div>
        <div class="tile"><div class="k">Calories</div><div class="v" id="ac_cals">—</div></div>
      </div>
      <div class="actions"><button class="primary" id="ac_read" data-write disabled>Read Activity</button></div>
      <p class="note">Reads the step/calorie totals the watch logged for today (convoy channel). Read-only. Needs a model whose profile declares the convoy channel.</p>`,
    mount(root, ctx) { root.querySelector("#ac_read").onclick = () => readActivity(ctx, root); },
    refresh(root, ctx) {
      root.querySelector("#ac_date").textContent = ctx.state.activity.date;
      root.querySelector("#ac_steps").textContent = ctx.state.activity.steps;
      root.querySelector("#ac_cals").textContent = ctx.state.activity.cals;
    },
  },

  /* ---- PROFILE (wrist / gender bits) ---- */
  profile: {
    label: "Profile",
    html: () => `
      <p class="eyebrow">Profile &#183; Wrist &amp; Gender</p>
      <div class="toggle"><span class="lab">Wrist<small>left / right</small></span><button class="sw" id="pf_wrist" aria-pressed="false" data-write disabled></button></div>
      <div class="toggle"><span class="lab">Gender<small>male / female</small></span><button class="sw" id="pf_gender" aria-pressed="false" data-write disabled></button></div>
      <p class="note" style="margin-top:10px">Toggle = right wrist / female (the official app's profile bits). Height, weight and birthday are stored on the watch but not transmitted over Bluetooth, so they can't be read or set here.</p>`,
    mount(root, ctx) {
      root.querySelector("#pf_wrist").onclick = () => writePerson(ctx, "wrist", !ctx.state.person.right);
      root.querySelector("#pf_gender").onclick = () => writePerson(ctx, "gender", !ctx.state.person.female);
    },
    async load(ctx) { const P = ctx.profile.person; if (!P) return; const a = await ctx.safeRead([P.feat]); if (a) parsePerson(ctx, a); },
    refresh(root, ctx) {
      root.querySelector("#pf_wrist").setAttribute("aria-pressed", ctx.state.person.right ? "true" : "false");
      root.querySelector("#pf_gender").setAttribute("aria-pressed", ctx.state.person.female ? "true" : "false");
    },
  },

  /* ---- STATUS ---- */
  status: {
    label: "Status",
    html: () => `
      <p class="eyebrow">Status &#183; Health</p>
      <div class="tiles">
        <div class="tile"><div class="k">Link</div><div class="v small" id="st_link">—</div></div>
        <div class="tile"><div class="k">Module</div><div class="v small" id="st_mod">—</div></div>
        <div class="tile"><div class="k">Firmware</div><div class="v small" id="st_fw">—</div></div>
        <div class="tile"><div class="k">Home City</div><div class="v" id="st_city">—</div></div>
        <div class="tile"><div class="k">Watch Condition &#183; 0x28</div><div class="v small" id="st_cond">—</div></div>
        <div class="tile"><div class="k">Last Readout</div><div class="v small" id="st_sync">—</div></div>
        <div class="tile"><div class="k">Battery</div><div class="v small">No gauge</div></div>
      </div>
      <p class="note" style="margin-top:12px"><b>Battery:</b> most G&#8209;Shock BT watches expose no battery level over Bluetooth (no standard Battery Service, no field in the Casio frames) — only a low-battery warning on the watch. This tab shows link health and the raw watch-condition block instead.</p>`,
    async load(ctx) {
      const I = ctx.profile.info; if (!I) return;
      const nm = await ctx.safeRead([I.name]); if (nm) ctx.state.info.name = ascii(nm, 1);
      const fw = await ctx.safeRead([I.version]); if (fw) ctx.state.info.fw = fw[1] + "." + fw[2] + "." + fw[3];
      const ct = await ctx.safeRead([I.city]); if (ct) ctx.state.info.city = ascii(ct, 2);
      const cd = await ctx.safeRead([I.condition]); if (cd) ctx.state.info.condition = hex(cd.slice(1, 7));
    },
    refresh(root, ctx) {
      root.querySelector("#st_link").textContent = ctx.state.mode === "live" ? "Live Link" : (ctx.state.mode === "demo" ? "Preview" : "Offline");
      root.querySelector("#st_mod").textContent = ctx.state.info.name || "—";
      root.querySelector("#st_fw").textContent = ctx.state.info.fw || "—";
      root.querySelector("#st_city").textContent = ctx.state.info.city || "—";
      root.querySelector("#st_cond").textContent = ctx.state.info.condition || "—";
      root.querySelector("#st_sync").textContent = ctx.state.lastSync || "—";
    },
  },

  /* ---- DIAGNOSTIC (works on ANY watch) ---- */
  diagnostic: {
    label: "Diagnostic",
    html: () => `
      <p class="eyebrow">Diagnostic &#183; Capture</p>
      <p class="note">Dump the watch's Bluetooth structure and probe its feature codes, then export a report to help add a profile for this model. Nothing is written to the watch by a dump; the probe only sends read requests.</p>
      <div class="actions">
        <button id="d_dump" data-write disabled>Dump GATT</button>
        <button id="d_probe" data-write disabled>Probe Features</button>
        <button id="d_export">Export Report (JSON)</button>
      </div>
      <div class="tiles"><div class="tile" style="grid-column:1/-1"><div class="k">Result</div><div class="v small" id="d_out" style="font-size:12px;white-space:pre-wrap">—</div></div></div>`,
    mount(root, ctx) {
      const out = root.querySelector("#d_out");
      const report = { generatedAt: null, device: null, gatt: [], probe: [] };
      root.querySelector("#d_dump").onclick = () => {
        report.device = ctx.state.name; report.gatt = ctx.state.gatt;
        out.textContent = ctx.state.gatt.map((s) => s.service + "\n" + s.chars.map((c) => "  " + c.uuid + "  [" + Object.keys(c.props).filter((k) => c.props[k]).join(",") + "]").join("\n")).join("\n\n") || "(no services)";
        ctx.log("GATT dumped (" + ctx.state.gatt.length + " services).", "g");
      };
      root.querySelector("#d_probe").onclick = async () => {
        if (ctx.state.mode !== "live" || !ble.req) { ctx.log("Probe needs a known request characteristic (Casio profile).", "e"); return; }
        out.textContent = "Probing 0x01–0x4f…"; report.probe = [];
        for (let code = 1; code <= 0x4f; code++) {
          const r = await request([code], 400);
          if (r) report.probe.push({ code: "0x" + code.toString(16).padStart(2, "0"), bytes: hex(r) });
        }
        out.textContent = report.probe.length ? report.probe.map((p) => p.code + " → " + p.bytes).join("\n") : "No feature codes responded.";
        ctx.log("Feature probe done (" + report.probe.length + " responded).", "g");
      };
      root.querySelector("#d_export").onclick = () => {
        report.generatedAt = new Date().toISOString(); report.device = ctx.state.name; if (!report.gatt.length) report.gatt = ctx.state.gatt;
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
        a.download = "gridconsole-" + (ctx.state.name || "watch").replace(/[^A-Za-z0-9]+/g, "_") + ".json";
        a.click(); URL.revokeObjectURL(a.href);
        ctx.log("Report exported — attach it to a GitHub issue to request support. (Review it first; it names your watch.)", "g");
      };
    },
  },
};

/* ---------- shared writers (Casio 2C family) ---------- */
async function writeAlarm(ctx, n, h, m, enable) {
  if (ctx.state.mode !== "live") return;
  const L = ctx.profile.alarms;
  try {
    if (n === 1) { await ctx.writeAll([L.feat1, enable ? 0x40 : 0, 0x40, h, m]); }
    else { const cur = await request([L.featN]); const arr = Array.from(cur); const o = 1 + (n - 2) * 4; arr[o] = enable ? 0x40 : 0; arr[o + 1] = 0x40; arr[o + 2] = h; arr[o + 3] = m; await ctx.writeAll(arr); }
    await delay(150); await MODULES.alarms.load(ctx); refreshAll();
    ctx.log("Alarm " + n + " &#8594; " + fmtHM(h, m, ctx.state.basic.h24) + " " + (enable ? '<span class="g">ON</span>' : "OFF"));
  } catch (e) { ctx.log("Alarm " + n + " write failed: " + e.message, "e"); }
}
function parseBasic(ctx, a) { const b = ctx.profile.basic; ctx.state.basic = { h24: (a[1] & b.h24Bit) !== 0, tone: (a[1] & b.toneBit) === 0, light: (a[1] & b.lightBit) === 0, vib: a[b.vibByte] === 0x01 }; }
async function writeBasic(ctx, which, on) {
  if (ctx.state.mode !== "live") return;
  const b = ctx.profile.basic, prev = { ...ctx.state.basic };
  ctx.state.basic[which] = on; refreshAll();
  try {
    const cur = await request([b.feat]); const arr = Array.from(cur);
    if (which === "h24") { on ? (arr[1] |= b.h24Bit) : (arr[1] &= ~b.h24Bit); }
    if (which === "tone") { on ? (arr[1] &= ~b.toneBit) : (arr[1] |= b.toneBit); }
    if (which === "light") { on ? (arr[1] &= ~b.lightBit) : (arr[1] |= b.lightBit); }
    if (which === "vib") { arr[b.vibByte] = on ? 1 : 0; }
    await ctx.writeAll(arr); await delay(150); const rb = await request([b.feat]); if (rb) parseBasic(ctx, rb);
    refreshAll(); ctx.log("Setting: " + which + " &#8594; " + (on ? '<span class="g">ON</span>' : "OFF"));
  } catch (e) { ctx.state.basic = prev; refreshAll(); ctx.log("Setting write failed (reverted): " + e.message, "e"); }
}

/* ---- timers ---- */
async function sendTimers(ctx, root) {
  if (ctx.state.mode !== "live") return;
  const L = ctx.profile.timers;
  try {
    const repeat = clamp(parseInt(root.querySelector("#tm_rep").value, 10) || 1, 1, 20);
    const rows = root.querySelectorAll(".trow"), cfg = [L.cfg, repeat];
    for (let i = 0; i < L.count; i++) {
      const r = rows[i];
      const mn = clamp(parseInt(r.querySelector("[data-mm]").value, 10) || 0, 0, 60);
      const sc = clamp(parseInt(r.querySelector("[data-ss]").value, 10) || 0, 0, 59);
      const skip = (mn === 0 && sc === 0);
      cfg.push(skip ? 0 : bcd(sc), skip ? 0 : bcd(mn), 0);
      const nm = normName(r.querySelector("[data-name]").value), frame = [L.name, i + 1];
      for (let c = 0; c < nm.length; c++) frame.push(nm.charCodeAt(c));
      while (frame.length < 20) frame.push(0);
      await writeAll(frame); await delay(60);
    }
    await writeAll(cfg); await delay(150); await MODULES.timers.load(ctx); refreshAll();
    ctx.log("Interval timers written (" + repeat + "x repeat).", "g");
  } catch (e) { ctx.log("Timer write failed: " + e.message, "e"); }
}

/* ---- world time (full session, Casio 2C family) ---- */
function nameFrame(listFeat, slot, name) { const f = [listFeat, slot]; for (let i = 0; i < name.length; i++) f.push(name.charCodeAt(i)); while (f.length < 20) f.push(0); return f; }
async function applyWorldCity(ctx, root) {
  if (ctx.state.mode !== "live") return;
  const W = ctx.profile.world;
  const slot = parseInt(root.querySelector("#w_slot").value, 10), city = root.querySelector("#w_city").value, t = CITY_TABLE[city];
  if (!t) return;
  try {
    ctx.log("Setting " + city + " (slot " + slot + ")…");
    const pair = Array.from(await request([W.pair, 0]));
    const e = [Array.from(await request([W.zone, 0])), Array.from(await request([W.zone, 1]))];
    const f = [Array.from(await request([W.list, 0])), Array.from(await request([W.list, 1]))];
    const A = t[0], B = t[1];
    if (slot === 0) { pair[3] = 0x02; pair[5] = A; pair[6] = B; } else { pair[4] = 0x02; pair[7] = A; pair[8] = B; }
    e[slot] = [W.zone, slot, A, B, t[2], t[3], t[4]];
    f[slot] = nameFrame(W.list, slot, city);
    const frames = [[0x21, 0x00, 0x01], pair, e[0], e[1], f[0], f[1], [0x2f, 0x0e, 0x04, 0x00, 0x1e, 0x00], [0x21, 0x01, 0x01]];
    for (let i = 0; i < frames.length; i++) { await writeAll(frames[i]); await delay(80); }
    await delay(400);
    const c0 = await safeRead([W.list, 0]); if (c0) ctx.state.cities[0] = ascii(c0, 2);
    const c1 = await safeRead([W.list, 1]); if (c1) ctx.state.cities[1] = ascii(c1, 2);
    refreshAll();
    ctx.log(ctx.state.cities[slot] === city ? city + " set." : "Set attempted; watch shows " + ctx.state.cities[slot], ctx.state.cities[slot] === city ? "g" : "o");
  } catch (e2) { ctx.log("World set failed: " + e2.message, "e"); }
}

/* ---- signal (push notification over the note characteristic, bytes inverted) ---- */
async function sendNotification(ctx, root, del) {
  if (ctx.state.mode !== "live" || !ble.note) { if (!ble.note) ctx.log("Notification channel unavailable on this watch.", "e"); return; }
  try {
    const id = noteId++, cat = parseInt(root.querySelector("#sg_cat").value, 10) || 0;
    const alert = del ? 0 : (root.querySelector("#sg_buzz").checked ? 1 : 0);
    const arr = [id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, (id >> 24) & 0xff, del ? 0x02 : 0x00, alert, del ? 0 : cat];
    utf8(ts15()).forEach((b) => arr.push(b));
    if (del) { field(arr, []); field(arr, []); field(arr, []); field(arr, []); }
    else { field(arr, []); field(arr, utf8(root.querySelector("#sg_title").value).slice(0, 32)); field(arr, []); field(arr, utf8(root.querySelector("#sg_msg").value).slice(0, 250)); }
    await ble.note.writeValueWithoutResponse(new Uint8Array(arr.map((b) => (~b) & 0xff)));
    ctx.log(del ? "Clear sent to watch." : "Notification pushed to watch.", "g");
  } catch (e) { ctx.log("Notification failed: " + e.message, "e"); }
}

/* ---- finder (two-way) ---- */
async function buzzWatch(ctx) {
  if (ctx.state.mode !== "live" || !ble.note) { ctx.log("Notification channel unavailable.", "e"); return; }
  const id = noteId++;
  const arr = [id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, (id >> 24) & 0xff, 0x00, 0x01, 0x00];
  utf8(ts15()).forEach((b) => arr.push(b));
  field(arr, []); field(arr, utf8("FIND WATCH").slice(0, 32)); field(arr, []); field(arr, utf8("Where are you?").slice(0, 250));
  try { await ble.note.writeValueWithoutResponse(new Uint8Array(arr.map((b) => (~b) & 0xff))); ctx.log("Buzzed the watch.", "g"); }
  catch (e) { ctx.log("Buzz failed: " + e.message, "e"); }
}
function findPhoneAlarm(root, ctx) {
  ctx.log("Watch is looking for this phone!", "o");
  const el = root.querySelector("#fn_alert"); if (el) el.hidden = false;
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    findAudio = findAudio || new AC();
    const t0 = findAudio.currentTime;
    for (let i = 0; i < 6; i++) {
      const o = findAudio.createOscillator(), g = findAudio.createGain();
      o.type = "square"; o.frequency.value = i % 2 ? 880 : 1320;
      g.gain.value = 0.0001; o.connect(g); g.connect(findAudio.destination);
      const s = t0 + i * 0.35; o.start(s); g.gain.setValueAtTime(0.25, s); g.gain.setValueAtTime(0.0001, s + 0.25); o.stop(s + 0.3);
    }
  } catch (e) {}
  setTimeout(() => { if (el) el.hidden = true; }, 6000);
}

/* ---- activity (convoy channel, inverted payload) ---- */
async function readActivity(ctx, root) {
  if (ctx.state.mode !== "live" || !ble.convoyReq) { ctx.log("Activity channel unavailable on this watch.", "e"); return; }
  ble.convoy = [];
  try {
    ctx.log("Requesting activity…");
    await ble.convoyReq.writeValueWithResponse(new Uint8Array(ctx.profile.activity.convoyRead));
    await delay(3000);
    if (ble.convoy.length < 13) { ctx.log("No activity payload (" + ble.convoy.length + " bytes).", "o"); return; }
    const raw = ble.convoy.map((b) => (~b) & 0xff);
    let steps = (raw[7] | (raw[8] << 8) | (raw[9] << 16) | (raw[10] << 24)) >>> 0; if (steps === 0xfffffffe) steps = 0;
    let cals = raw[11] | (raw[12] << 8); if (cals === 0xfffe) cals = 0;
    ctx.state.activity = { date: (2000 + raw[2]) + "-" + pad(raw[3]) + "-" + pad(raw[4]), steps, cals };
    refreshAll(); ctx.log("Activity: " + steps + " steps, " + cals + " cal.", "g");
  } catch (e) { ctx.log("Activity read failed: " + e.message, "e"); }
}

/* ---- profile bits (0x45 on the GBD-200) ---- */
function parsePerson(ctx, a) { const P = ctx.profile.person; ctx.state.person = { female: (a[1] & P.genderBit) !== 0, right: (a[1] & P.wristBit) !== 0 }; }
async function writePerson(ctx, which, on) {
  if (ctx.state.mode !== "live") return;
  const P = ctx.profile.person;
  try {
    const cur = await request([P.feat]), arr = Array.from(cur);
    if (which === "gender") { on ? (arr[1] |= P.genderBit) : (arr[1] &= ~P.genderBit); }
    if (which === "wrist") { on ? (arr[1] |= P.wristBit) : (arr[1] &= ~P.wristBit); }
    await writeAll(arr); await delay(150); const rb = await request([P.feat]); if (rb) parsePerson(ctx, rb);
    refreshAll(); ctx.log("Profile: " + which + " &#8594; " + (on ? '<span class="g">ON</span>' : "OFF"));
  } catch (e) { ctx.log("Profile write failed: " + e.message, "e"); refreshAll(); }
}

/* ---------- boot ---------- */
$("connectBtn").addEventListener("click", connect);
state.profile = PROFILES[0] || GENERIC; buildUI();   // preview the first profile's tabs before connecting
setMode(navigator.bluetooth ? "offline" : "demo");
log("Grid Console ready. Turn your phone's Bluetooth off, hold the watch's lower-left button to pair, then Connect.", "m");
