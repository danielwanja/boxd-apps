import { Database } from "bun:sqlite";
import { page, html, json, esc, clientIp, rateLimit, CSS, SITE, basePath, stripBase } from "../shared/lib";

/** JSON for inline <script>: escapes "<" so values can't close the script tag. */
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const PORT = Number(process.env.PORT ?? 3003);
const BASE = basePath("widgets");

const db = new Database(`${import.meta.dir}/widgets.db`, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS counters (id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0)");
const bump = db.query<{ count: number }, [string]>(
  "INSERT INTO counters (id, count) VALUES (?1, 1) ON CONFLICT(id) DO UPDATE SET count = count + 1 RETURNING count");
const read = db.query<{ count: number }, [string]>("SELECT count FROM counters WHERE id = ?");

// --- weather (Open-Meteo, no key), cached 10 min ------------------------------

const WMO: Record<number, [string, string]> = {
  0: ["Clear", "☀️"], 1: ["Mostly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
  45: ["Fog", "🌫️"], 48: ["Fog", "🌫️"], 51: ["Drizzle", "🌦️"], 53: ["Drizzle", "🌦️"], 55: ["Drizzle", "🌦️"],
  61: ["Rain", "🌧️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"], 66: ["Freezing rain", "🌧️"], 67: ["Freezing rain", "🌧️"],
  71: ["Snow", "🌨️"], 73: ["Snow", "🌨️"], 75: ["Heavy snow", "❄️"], 77: ["Snow grains", "🌨️"],
  80: ["Showers", "🌦️"], 81: ["Showers", "🌧️"], 82: ["Violent showers", "⛈️"], 85: ["Snow showers", "🌨️"], 86: ["Snow showers", "🌨️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm, hail", "⛈️"], 99: ["Thunderstorm, hail", "⛈️"],
};
const weatherCache = new Map<string, { at: number; data: unknown }>();

async function weather(city: string, units: "c" | "f") {
  const key = `${city.toLowerCase()}|${units}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;

  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`,
    { signal: AbortSignal.timeout(6000) }).then((r) => r.json()) as any;
  const place = geo.results?.[0];
  if (!place) return null;
  const params = new URLSearchParams({
    latitude: place.latitude, longitude: place.longitude, timezone: "auto",
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m",
    daily: "temperature_2m_max,temperature_2m_min", forecast_days: "1",
    temperature_unit: units === "f" ? "fahrenheit" : "celsius",
    wind_speed_unit: units === "f" ? "mph" : "kmh",
  });
  const w = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(6000) })
    .then((r) => r.json()) as any;
  const [text, icon] = WMO[w.current.weather_code] ?? ["", "🌡️"];
  const data = {
    place: [place.name, place.admin1, place.country_code].filter(Boolean).join(", "),
    temp: Math.round(w.current.temperature_2m), feels: Math.round(w.current.apparent_temperature),
    high: Math.round(w.daily.temperature_2m_max[0]), low: Math.round(w.daily.temperature_2m_min[0]),
    humidity: w.current.relative_humidity_2m, wind: Math.round(w.current.wind_speed_10m),
    windUnit: units === "f" ? "mph" : "km/h", unit: units === "f" ? "°F" : "°C", text, icon,
  };
  weatherCache.set(key, { at: Date.now(), data });
  return data;
}

// --- widget pages (rendered inside an iframe) --------------------------------

const WIDGET_CSS = `
html,body{background:transparent}
body{padding:0;overflow:hidden}
.w{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:1px}
.label{color:var(--muted);font-size:13px;margin-bottom:2px}
.big{font-size:2rem;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums}
.sub{color:var(--muted);font-size:13px;margin-top:4px}
.units{display:flex;gap:14px;flex-wrap:wrap}
.units div{text-align:center;min-width:48px}
.units small{color:var(--muted);display:block;font-size:12px}
.brandlink{float:right;font-size:11px;color:var(--muted);text-decoration:none;opacity:.7}
`;

function widgetShell(p: URLSearchParams, body: string, script = ""): string {
  const theme = p.get("theme");
  const themeAttr = theme === "light" || theme === "dark" ? ` data-theme="${theme}"` : "";
  return `<!doctype html><html lang="en"${themeAttr}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}${WIDGET_CSS}</style></head>
<body><div class="w">${body}</div>
<script>
const frameId = ${js(p.get("_id") ?? "")};
const report = () => parent.postMessage({ dwidget: frameId, height: document.documentElement.scrollHeight }, "*");
new ResizeObserver(report).observe(document.body);
${script}
</script></body></html>`;
}

const widgets: Record<string, (p: URLSearchParams) => string | Promise<string>> = {
  clock(p) {
    const tz = p.get("tz") || "UTC";
    return widgetShell(p, `
<div class="label">${esc(p.get("label") || tz.replaceAll("_", " "))}</div>
<div class="big" id="t">--:--</div><div class="sub" id="d"></div>`, `
const tz = ${js(tz)}, h12 = ${js(p.get("format") === "12")}, secs = ${js(p.get("seconds") !== "0")};
let tf, df;
try {
  tf = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "2-digit", minute: "2-digit", second: secs ? "2-digit" : undefined, hour12: h12 });
  df = new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
} catch { document.getElementById("t").textContent = "Unknown time zone"; }
const tick = () => { const n = new Date(); document.getElementById("t").textContent = tf.format(n); document.getElementById("d").textContent = df.format(n); };
if (tf) { tick(); setInterval(tick, 1000); }`);
  },

  countdown(p) {
    const to = p.get("to") || `${new Date().getUTCFullYear() + 1}-01-01T00:00`;
    return widgetShell(p, `
<div class="label">${esc(p.get("label") || "Countdown")}</div>
<div class="units big" id="u"></div><div class="sub" id="s"></div>`, `
const target = new Date(${js(to)});
const done = ${js(p.get("done") || "It's here! 🎉")};
const u = document.getElementById("u");
document.getElementById("s").textContent = isNaN(target) ? "" : target.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
function tick() {
  if (isNaN(target)) { u.textContent = "Invalid date"; return; }
  let s = Math.max(0, Math.floor((target - Date.now()) / 1000));
  if (s === 0) { u.textContent = done; return; }
  const parts = [["days", Math.floor(s / 86400)], ["hrs", Math.floor(s / 3600) % 24], ["min", Math.floor(s / 60) % 60], ["sec", s % 60]];
  u.innerHTML = parts.map(([k, v]) => "<div>" + String(v).padStart(2, "0") + "<small>" + k + "</small></div>").join("");
}
tick(); setInterval(tick, 1000);`);
  },

  async weather(p) {
    const city = (p.get("city") || "London").slice(0, 80);
    const units = p.get("units") === "f" ? "f" : "c";
    let w: any = null;
    try { w = await weather(city, units); } catch {}
    if (!w) return widgetShell(p, `<div class="label">Weather</div><div>Couldn't find weather for “${esc(city)}”.</div>`);
    return widgetShell(p, `
<div class="label">${esc(p.get("label") || w.place)}</div>
<div style="display:flex;align-items:center;gap:12px">
  <div style="font-size:2.2rem" aria-hidden="true">${w.icon}</div>
  <div><div class="big">${w.temp}${w.unit}</div><div class="sub" style="margin:0">${esc(w.text)} · feels ${w.feels}${w.unit}</div></div>
</div>
<div class="sub">H ${w.high}° · L ${w.low}° · Humidity ${w.humidity}% · Wind ${w.wind} ${w.windUnit}</div>`);
  },

  counter(p) {
    const id = (p.get("id") || "").toLowerCase();
    if (!/^[a-z0-9._-]{1,64}$/.test(id)) return widgetShell(p, `<div class="label">Counter</div><div>Set an <code>id</code> for this counter.</div>`);
    return widgetShell(p, `
<div class="label">${esc(p.get("label") || "Visitors")}</div>
<div class="big" id="n">…</div>`, `
fetch(${js(BASE + "/api/counter/" + id)}, { method: "POST" }).then((r) => r.json())
  .then((d) => { document.getElementById("n").textContent = d.count.toLocaleString(); })
  .catch(() => { document.getElementById("n").textContent = "–"; });`);
  },
};

// --- embed script -------------------------------------------------------------

const EMBED_JS = `(() => {
  const BASE_URL = ${js(SITE.widgets)};
  const ORIGIN = new URL(BASE_URL).origin;
  let n = 0;
  function mount(el) {
    if (el.dataset.dwidgetMounted) return;
    el.dataset.dwidgetMounted = "1";
    const id = "dw" + (++n) + Math.random().toString(36).slice(2, 7);
    const params = new URLSearchParams({ _id: id });
    for (const [k, v] of Object.entries(el.dataset)) if (k !== "dwidget" && k !== "dwidgetMounted") params.set(k, v);
    const f = document.createElement("iframe");
    f.src = BASE_URL + "/w/" + encodeURIComponent(el.dataset.dwidget) + "?" + params;
    f.title = el.dataset.dwidget + " widget";
    f.loading = "lazy";
    f.style.cssText = "border:0;width:100%;height:110px;display:block;color-scheme:normal";
    f.dataset.dwidgetFrame = id;
    el.replaceChildren(f);
  }
  window.addEventListener("message", (e) => {
    if (e.origin !== ORIGIN || !e.data || !e.data.dwidget) return;
    const f = document.querySelector('iframe[data-dwidget-frame="' + e.data.dwidget + '"]');
    if (f) f.style.height = Math.ceil(e.data.height) + "px";
  });
  const scan = () => document.querySelectorAll("[data-dwidget]").forEach(mount);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan); else scan();
  window.dwidgets = { scan };
})();`;

// --- builder page -------------------------------------------------------------

const builder = page({
  title: "Web widgets",
  active: "Widgets",
  head: `<style>
.layout{display:grid;gap:16px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
@media (max-width:720px){.layout{grid-template-columns:minmax(0,1fr)}}
.fields input,.fields select{width:100%}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.tabs button{background:transparent;color:var(--muted);border:1px solid var(--border)}
.tabs button[aria-selected=true]{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}
.preview{background:repeating-conic-gradient(var(--code) 0 25%,transparent 0 50%) 0 0/16px 16px;border-radius:12px;padding:16px;min-height:140px}
</style>`,
  body: `
<h1>Web widgets</h1>
<p class="lede">Pick a widget, set it up, and paste two lines of HTML into any site.</p>
<div class="tabs" role="tablist" id="tabs"></div>
<div class="layout">
  <div class="card stack fields" id="fields"></div>
  <div class="stack">
    <div><label>Preview</label><div class="preview" id="preview"></div></div>
    <div><label>Embed code</label><pre id="code"></pre></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="ghost" type="button" id="copy">Copy embed code</button>
      <a class="btn" id="open" target="_blank" rel="noopener" style="background:transparent;color:var(--text);border:1px solid var(--border)">Open widget</a></div>
  </div>
</div>
<script src="${BASE}/embed.js"></script>
<script>
const zones = (() => { try { return Intl.supportedValuesOf("timeZone"); } catch { return ["UTC"]; } })();
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
if (!zones.includes(localTz)) zones.unshift(localTz);
const nextYear = new Date().getFullYear() + 1 + "-01-01T00:00";
const theme = { name: "theme", label: "Theme", type: "select", options: [["auto", "Match visitor"], ["light", "Light"], ["dark", "Dark"]] };
const DEFS = {
  clock: { title: "Clock", fields: [
    { name: "tz", label: "Time zone", type: "select", options: zones.map((z) => [z, z.replaceAll("_", " ")]), value: localTz },
    { name: "label", label: "Label (optional)", placeholder: "e.g. London office" },
    { name: "format", label: "Format", type: "select", options: [["24", "24-hour"], ["12", "12-hour"]] },
    { name: "seconds", label: "Seconds", type: "select", options: [["1", "Show"], ["0", "Hide"]] }, theme] },
  countdown: { title: "Countdown", fields: [
    { name: "to", label: "Count down to", type: "datetime-local", value: nextYear },
    { name: "label", label: "Label", value: "New Year" },
    { name: "done", label: "Message when finished", value: "It's here! 🎉" }, theme] },
  weather: { title: "Weather", fields: [
    { name: "city", label: "City", value: "London" },
    { name: "units", label: "Units", type: "select", options: [["c", "Celsius"], ["f", "Fahrenheit"]] },
    { name: "label", label: "Label (optional)" }, theme] },
  counter: { title: "Visitor counter", fields: [
    { name: "id", label: "Counter ID (unique to your site)", value: "my-site-" + Math.random().toString(36).slice(2, 7) },
    { name: "label", label: "Label", value: "Visitors" }, theme] },
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let current = "clock";

function fieldHtml(f) {
  const id = "f-" + f.name;
  const input = f.type === "select"
    ? '<select id="' + id + '" name="' + f.name + '">' + f.options.map(([v, t]) =>
        '<option value="' + esc(v) + '"' + (v === f.value ? " selected" : "") + '>' + esc(t) + '</option>').join("") + '</select>'
    : '<input id="' + id + '" name="' + f.name + '" type="' + (f.type || "text") + '" value="' + esc(f.value || "") + '" placeholder="' + esc(f.placeholder || "") + '">';
  return '<div><label for="' + id + '">' + esc(f.label) + '</label>' + input + '</div>';
}

function values() {
  const out = {};
  for (const f of DEFS[current].fields) {
    const v = document.getElementById("f-" + f.name).value.trim();
    if (v && !(f.name === "theme" && v === "auto")) out[f.name] = v;
  }
  return out;
}

let timer;
function update() {
  const v = values();
  const attrs = Object.entries(v).map(([k, val]) => " data-" + k + '="' + esc(val) + '"').join("");
  const snippet = '<div data-dwidget="' + current + '"' + attrs + '></div>\\n<script async src="${SITE.widgets}/embed.js"><\\/script>';
  document.getElementById("code").textContent = snippet;
  document.getElementById("open").href = "${BASE}/w/" + current + "?" + new URLSearchParams(v);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const el = document.createElement("div");
    el.dataset.dwidget = current;
    for (const [k, val] of Object.entries(v)) el.dataset[k] = val;
    document.getElementById("preview").replaceChildren(el);
    window.dwidgets.scan();
  }, 300);
}

function select(name) {
  current = name;
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.w === name));
  document.getElementById("fields").innerHTML = DEFS[name].fields.map(fieldHtml).join("");
  update();
}

document.getElementById("tabs").innerHTML = Object.entries(DEFS).map(([k, d]) => '<button role="tab" data-w="' + k + '">' + d.title + '</button>').join("");
document.getElementById("tabs").addEventListener("click", (e) => { if (e.target.dataset.w) select(e.target.dataset.w); });
document.getElementById("fields").addEventListener("input", update);
document.getElementById("copy").addEventListener("click", async (e) => {
  try { await navigator.clipboard.writeText(document.getElementById("code").textContent); e.target.textContent = "Copied"; setTimeout(() => e.target.textContent = "Copy embed code", 1500); } catch {}
});
select("clock");
</script>`,
});

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = stripBase(url.pathname, BASE) ?? "/404";
    if (path === "/health") return new Response("ok");
    if (path === "/") return html(builder);

    if (path === "/embed.js") {
      return new Response(EMBED_JS, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" },
      });
    }

    const w = path.match(/^\/w\/([a-z]+)$/);
    if (w && widgets[w[1]]) {
      return html(await widgets[w[1]](url.searchParams), {
        headers: { "content-security-policy": "frame-ancestors *", "cache-control": "no-cache" },
      });
    }

    const c = path.match(/^\/api\/counter\/([a-z0-9._-]{1,64})$/);
    if (c) {
      // Count each visitor at most once per 30 min per counter.
      const fresh = req.method === "POST" && rateLimit(`count:${c[1]}:${clientIp(req, server)}`, 1, 30 * 60_000);
      const row = fresh ? bump.get(c[1]) : read.get(c[1]);
      return json({ id: c[1], count: row?.count ?? 0 });
    }

    return html(page({ title: "Not found", active: "Widgets", body: "<h1>Not found</h1>" }), { status: 404 });
  },
});

console.log(`widgets on :${PORT}`);
