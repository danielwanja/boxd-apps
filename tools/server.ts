import tls from "node:tls";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { page, html, json, clientIp, rateLimit, HOSTNAME, basePath, stripBase } from "../shared/lib";

const PORT = Number(process.env.PORT ?? 3002);
const BASE = basePath("tools");

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA"] as const;

class UserError extends Error {}

/** Normalise user input to a bare hostname or IP ("https://Foo.com/x" -> "foo.com"). */
function parseTarget(raw: string | null): string {
  let s = (raw ?? "").trim().toLowerCase();
  if (!s) throw new UserError("Enter a domain or IP address.");
  if (/^[a-z]+:\/\//.test(s)) {
    try { s = new URL(s).hostname; } catch { throw new UserError("That doesn't look like a valid URL."); }
  }
  s = s.replace(/^\[|\]$/g, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (net.isIP(s)) return s;
  s = s.replace(/^\[?([^\]]*?)\]?:\d+$/, "$1");
  if (net.isIP(s)) return s;
  if (!DOMAIN_RE.test(s)) throw new UserError("That doesn't look like a valid domain.");
  return s;
}

const privateIps = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) privateIps.addSubnet(addr, prefix, "ipv4");
// IPv6 (IPv4-mapped addresses are matched by the IPv4 rules): loopback/unspecified, IPv4-translated, NAT64, discard, docs, 6to4, ULA, link-local, multicast.
for (const [addr, prefix] of [
  ["::", 127], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) privateIps.addSubnet(addr, prefix, "ipv6");

function isPrivate(ip: string): boolean {
  ip = ip.replace(/^\[|\]$/g, "");
  if (!net.isIP(ip)) return true;
  return privateIps.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

/** Resolve a host to a public IP, refusing anything internal (SSRF guard). */
async function publicAddress(host: string): Promise<string> {
  host = host.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new UserError(`Could not resolve ${host}.`);
  if (addrs.some((a) => isPrivate(a.address))) throw new UserError("Private and internal addresses are not allowed.");
  return addrs[0].address;
}

async function run(cmd: string[], timeoutMs = 10_000): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return (out || err).trim();
}

// --- tools -----------------------------------------------------------------

async function whois(target: string) {
  const text = await run(["whois", target], 15_000);
  if (!text) throw new UserError("No WHOIS data returned.");
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const m = text.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, "im"));
      if (m) return m[1].trim();
    }
    return null;
  };
  return {
    target,
    summary: {
      Registrar: pick("Registrar", "registrar"),
      Created: pick("Creation Date", "created", "Registered on"),
      Updated: pick("Updated Date", "last-modified", "changed"),
      Expires: pick("Registry Expiry Date", "Registrar Registration Expiration Date", "Expiry Date", "paid-till"),
      Status: pick("Domain Status", "status"),
      Organisation: pick("Registrant Organization", "OrgName", "org-name", "organisation"),
      Country: pick("Registrant Country", "Country", "country"),
      "Name servers": [...new Set([...text.matchAll(/^\s*Name Server:\s*(\S+)/gim)].map((m) => m[1].toLowerCase()))].join(", ") || null,
    },
    raw: text.slice(0, 20_000),
  };
}

async function dns(target: string) {
  if (net.isIP(target)) {
    const ptr = await run(["dig", "+short", "-x", target, "@1.1.1.1"]);
    return { target, records: { PTR: ptr ? ptr.split("\n") : [] } };
  }
  const results = await Promise.all(
    DNS_TYPES.map(async (t) => {
      const out = await run(["dig", "+noall", "+answer", "+time=3", "+tries=1", target, t, "@1.1.1.1"]);
      const rows = out.split("\n").filter(Boolean)
        .map((l) => l.split(/\s+/))
        .filter((p) => p[3] === t)
        .map((p) => ({ ttl: Number(p[1]), value: p.slice(4).join(" ") }));
      return [t, rows] as const;
    }),
  );
  return { target, records: Object.fromEntries(results) };
}

function ssl(target: string, port: number): Promise<object> {
  return publicAddress(target).then((ip) => new Promise((resolve, reject) => {
    const sock = tls.connect({ host: ip, port, servername: net.isIP(target) ? undefined : target, rejectUnauthorized: false });
    const timer = setTimeout(() => { sock.destroy(); reject(new UserError("TLS connection timed out.")); }, 8000);
    sock.once("error", (e) => { clearTimeout(timer); reject(new UserError(`TLS error: ${e.message}`)); });
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const c = sock.getPeerCertificate(true);
      const chain: { subject: string; issuer: string }[] = [];
      let cur: any = c;
      const seen = new Set<string>();
      while (cur && cur.fingerprint256 && !seen.has(cur.fingerprint256) && chain.length < 6) {
        seen.add(cur.fingerprint256);
        chain.push({ subject: cur.subject?.CN ?? cur.subject?.O ?? "?", issuer: cur.issuer?.CN ?? cur.issuer?.O ?? "?" });
        cur = cur.issuerCertificate;
      }
      const validTo = new Date(c.valid_to);
      resolve({
        target, port, ip,
        trusted: sock.authorized,
        error: sock.authorizationError ? String(sock.authorizationError) : null,
        protocol: sock.getProtocol(),
        cipher: sock.getCipher()?.name,
        subject: c.subject?.CN,
        issuer: [c.issuer?.CN, c.issuer?.O].filter(Boolean).join(" · "),
        validFrom: new Date(c.valid_from).toISOString(),
        validTo: validTo.toISOString(),
        daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86_400_000),
        names: (c.subjectaltname ?? "").split(", ").map((s: string) => s.replace(/^DNS:/, "")).filter(Boolean),
        serial: c.serialNumber,
        fingerprint256: c.fingerprint256,
        chain,
      });
      sock.end();
    });
  }));
}

/** GET a URL over a socket pinned to an already-vetted IP, so DNS can't rebind to an internal address. */
function pinnedGet(url: URL, ip: string): Promise<{ status: number; headers: Record<string, string> }> {
  const family = net.isIPv6(ip) ? 6 : 4;
  const lookupPinned = (_h: string, o: any, cb: any) => (o?.all ? cb(null, [{ address: ip, family }]) : cb(null, ip, family));
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(url, {
      method: "GET", lookup: lookupPinned as any,
      headers: { "user-agent": "tools.d.boxd.sh header checker" },
    }, (res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      resolve({ status: res.statusCode ?? 0, headers });
      res.destroy();
    });
    req.setTimeout(8000, () => req.destroy(new Error("timed out")));
    req.on("error", (e) => reject(new UserError(`Request failed: ${e.message}`)));
    req.end();
  });
}

async function headers(raw: string) {
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`); }
  catch { throw new UserError("Enter a valid URL."); }
  const hops: { url: string; status: number; timeMs: number; headers: Record<string, string> }[] = [];
  for (let i = 0; i < 10; i++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new UserError("Only http(s) URLs are supported.");
    parseTarget(url.hostname);
    const ip = await publicAddress(url.hostname);
    const t0 = performance.now();
    const r = await pinnedGet(url, ip);
    hops.push({ url: url.toString(), status: r.status, timeMs: Math.round(performance.now() - t0), headers: r.headers });
    const loc = r.headers.location;
    if (r.status >= 300 && r.status < 400 && loc) {
      try { url = new URL(loc, url); } catch { break; }
    } else break;
  }
  return { hops };
}

async function myIp(req: Request, server: any) {
  const ip = clientIp(req, server);
  const ptr = net.isIP(ip) ? await run(["dig", "+short", "-x", ip, "@1.1.1.1"]).catch(() => "") : "";
  return { ip, version: net.isIPv6(ip) ? 6 : 4, reverseDns: ptr || null, userAgent: req.headers.get("user-agent") };
}

// --- UI --------------------------------------------------------------------

const ui = page({
  title: "Web tools",
  active: "Tools",
  head: `<style>
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.tabs button{background:transparent;color:var(--muted);border:1px solid var(--border)}
.tabs button[aria-selected=true]{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}
dl.kv{display:grid;grid-template-columns:minmax(110px,max-content) 1fr;gap:6px 16px;margin:0}
dl.kv dt{color:var(--muted)} dl.kv dd{margin:0;word-break:break-word}
details summary{cursor:pointer;color:var(--muted);margin-top:12px}
h3{font-size:1rem;margin:18px 0 8px}
</style>`,
  body: `
<h1>Web tools</h1>
<p class="lede">Look up domains, DNS, certificates and headers. Run from a server, so you see what the internet sees.</p>
<div class="tabs" role="tablist" id="tabs">
  <button role="tab" data-tool="whois">WHOIS</button>
  <button role="tab" data-tool="dns">DNS</button>
  <button role="tab" data-tool="ssl">SSL certificate</button>
  <button role="tab" data-tool="headers">HTTP headers</button>
  <button role="tab" data-tool="ip">My IP</button>
</div>
<div class="card stack">
  <form id="f" class="row"><input id="q" name="q" autocomplete="off" autocapitalize="off" spellcheck="false"><button id="go">Look up</button></form>
  <div id="out"></div>
</div>
<script>
const PLACEHOLDER = { whois: "example.com or 8.8.8.8", dns: "example.com", ssl: "example.com or example.com:8443",
  headers: "https://example.com", ip: "" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const kv = (o) => '<dl class="kv">' + Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "")
  .map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join("") + '</dl>';
let tool = "whois";

const render = {
  whois: (d) => kv(Object.fromEntries(Object.entries(d.summary).map(([k, v]) => [k, v && esc(v)]))) +
    '<details><summary>Raw WHOIS</summary><pre>' + esc(d.raw) + '</pre></details>',
  dns: (d) => Object.entries(d.records).map(([t, rows]) => '<h3>' + t + '</h3>' + (rows.length
    ? '<div class="tablewrap"><table><tbody>' + rows.map((r) => typeof r === "string"
        ? '<tr><td><code>' + esc(r) + '</code></td></tr>'
        : '<tr><td style="word-break:break-all"><code>' + esc(r.value) + '</code></td><td class="muted" style="width:90px">TTL ' + r.ttl + '</td></tr>').join("") + '</tbody></table></div>'
    : '<p class="muted" style="margin:0">No records</p>')).join(""),
  ssl: (d) => kv({
    Status: d.trusted ? '<span class="ok">Trusted</span>' : '<span class="err">Not trusted: ' + esc(d.error) + '</span>',
    "Common name": esc(d.subject), Issuer: esc(d.issuer),
    "Valid from": esc(d.validFrom.slice(0, 10)),
    Expires: esc(d.validTo.slice(0, 10)) + ' <span class="' + (d.daysLeft < 14 ? "err" : "muted") + '">(' + d.daysLeft + ' days)</span>',
    Protocol: esc(d.protocol + " · " + d.cipher), "Server IP": esc(d.ip),
    Names: d.names.map((n) => '<code>' + esc(n) + '</code>').join(" "),
    Chain: d.chain.map((c) => esc(c.subject)).join(" → "),
    "SHA-256": '<code style="word-break:break-all">' + esc(d.fingerprint256) + '</code>',
  }),
  headers: (d) => d.hops.map((h, i) => '<h3>' + (i + 1) + '. <span class="' + (h.status < 400 ? "ok" : "err") + '">' + h.status +
    '</span> <span style="word-break:break-all;font-weight:400">' + esc(h.url) + '</span> <span class="muted" style="font-weight:400">' + h.timeMs + ' ms</span></h3>' +
    '<div class="tablewrap"><table><tbody>' + Object.entries(h.headers).map(([k, v]) =>
      '<tr><td class="muted" style="white-space:nowrap">' + esc(k) + '</td><td style="word-break:break-all"><code>' + esc(v) + '</code></td></tr>').join("") +
    '</tbody></table></div>').join(""),
  ip: (d) => '<div style="font-size:1.8rem;font-weight:700;word-break:break-all">' + esc(d.ip) + '</div>' +
    kv({ Version: "IPv" + d.version, "Reverse DNS": d.reverseDns && esc(d.reverseDns), "User agent": esc(d.userAgent) }),
};

function select(t, { run = false, q = "" } = {}) {
  tool = t;
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tool === t));
  const input = document.getElementById("q");
  input.placeholder = PLACEHOLDER[t];
  input.hidden = t === "ip";
  input.required = t !== "ip";
  if (q) input.value = q;
  document.getElementById("go").textContent = t === "ip" ? "Show my IP" : "Look up";
  document.getElementById("out").innerHTML = "";
  if (run || t === "ip") lookup();
}

async function lookup() {
  const q = document.getElementById("q").value.trim();
  const out = document.getElementById("out");
  const params = new URLSearchParams({ tool });
  if (tool !== "ip") params.set("q", q);
  history.replaceState(null, "", "?" + params);
  out.innerHTML = '<p class="muted" style="margin:0">Looking up…</p>';
  try {
    const r = await fetch("${BASE}/api/" + tool + (tool === "ip" ? "" : "?q=" + encodeURIComponent(q)));
    const d = await r.json();
    out.innerHTML = r.ok ? render[tool](d) : '<p class="err" style="margin:0">' + esc(d.error) + '</p>';
  } catch (e) {
    out.innerHTML = '<p class="err" style="margin:0">Request failed.</p>';
  }
}

document.getElementById("tabs").addEventListener("click", (e) => { if (e.target.dataset.tool) select(e.target.dataset.tool); });
document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); lookup(); });
const p = new URLSearchParams(location.search);
select(render[p.get("tool")] ? p.get("tool") : "whois", { run: !!p.get("q"), q: p.get("q") || "" });
</script>`,
});

Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = stripBase(url.pathname, BASE) ?? "/404";
    if (path === "/health") return new Response("ok");
    if (path === "/") return html(ui);
    if (!path.startsWith("/api/")) return html(page({ title: "Not found", active: "Tools", body: "<h1>Not found</h1>" }), { status: 404 });

    const ip = clientIp(req, server);
    if (!rateLimit(`tools:${ip}`, 30, 60_000)) return json({ error: "Too many lookups. Wait a minute and try again." }, 429);

    const q = url.searchParams.get("q");
    try {
      switch (path) {
        case "/api/whois": return json(await whois(parseTarget(q)));
        case "/api/dns": return json(await dns(parseTarget(q)));
        case "/api/ssl": {
          const bare = (q ?? "").trim();
          const port = net.isIP(bare) ? 443 : Number(bare.match(/:(\d{1,5})(?:\/|$)/)?.[1] ?? 443);
          if (port < 1 || port > 65535) throw new UserError("Invalid port.");
          return json(await ssl(parseTarget(q), port));
        }
        case "/api/headers": {
          if (!q?.trim()) throw new UserError("Enter a URL.");
          return json(await headers(q));
        }
        case "/api/ip": return json(await myIp(req, server));
        default: return json({ error: "Unknown tool" }, 404);
      }
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: "Lookup failed." }, 500);
    }
  },
});

console.log(`tools on :${PORT}`);
