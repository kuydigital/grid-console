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

/* ---------- BLE + app state ---------- */
const ble = { device: null, server: null, service: null, req: null, all: null, q: [] };
const state = {
  mode: "offline", profile: GENERIC, name: "—",
  basic: { h24: true, tone: true, light: false, vib: false },
  alarms: [], info: { name: "—", fw: "—", city: "—", condition: "—" }, lastSync: "—",
  gatt: [],
};
const mounted = [];   // [{id, root, mod}]
let clockTimer = null;

/* ---------- BLE primitives ---------- */
function onNotify(ev) { ble.q.push(new Uint8Array(ev.target.value.buffer)); }
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
    const ctx = { state, profile: state.profile, request, safeRead, writeAll, log, refreshAll, pad, clamp, hex, fmtHM };
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

/* ---------- boot ---------- */
$("connectBtn").addEventListener("click", connect);
state.profile = PROFILES[0] || GENERIC; buildUI();   // preview the first profile's tabs before connecting
setMode(navigator.bluetooth ? "offline" : "demo");
log("Grid Console ready. Turn your phone's Bluetooth off, hold the watch's lower-left button to pair, then Connect.", "m");
