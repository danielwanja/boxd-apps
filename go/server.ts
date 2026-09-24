import { Database } from "bun:sqlite";
import { page, html, json, esc, clientIp, rateLimit, SITE, basePath, stripBase } from "../shared/lib";

const PORT = Number(process.env.PORT ?? 3001);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const BASE = basePath("go");

const db = new Database(`${import.meta.dir}/links.db`, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS links (
  slug TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_click_at TEXT,
  creator_ip TEXT
)`);

type Link = { slug: string; url: string; clicks: number; created_at: string; last_click_at: string | null };

const q = {
  get: db.query<Link, [string]>("SELECT slug,url,clicks,created_at,last_click_at FROM links WHERE slug = ?"),
  insert: db.query("INSERT INTO links (slug,url,creator_ip) VALUES (?,?,?)"),
  click: db.query("UPDATE links SET clicks = clicks + 1, last_click_at = datetime('now') WHERE slug = ?"),
  all: db.query<Link, []>("SELECT slug,url,clicks,created_at,last_click_at FROM links ORDER BY created_at DESC LIMIT 500"),
  del: db.query("DELETE FROM links WHERE slug = ?"),
};

const RESERVED = new Set(["admin", "api", "health", "favicon.ico", "robots.txt"]);
const SLUG_RE = /^[A-Za-z0-9_-]{3,32}$/;
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomSlug(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function validUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.toString().startsWith(SITE.go + "/")) return null; // no redirect loops
    return u.toString();
  } catch {
    return null;
  }
}

function authorized(req: Request): boolean {
  if (!ADMIN_PASSWORD) return false;
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Basic ")) return false;
  const [, pass] = atob(h.slice(6)).split(/:(.*)/s);
  return pass === ADMIN_PASSWORD;
}

const home = page({
  title: "Link shortener",
  active: "Links",
  body: `
<h1>Link shortener</h1>
<p class="lede">Paste a long URL and get a short one. Add <code>+</code> to any short link to see its stats.</p>
<div class="card stack">
  <form id="f" class="row">
    <input name="url" type="url" required placeholder="https://example.com/some/very/long/path" aria-label="Long URL">
    <input name="slug" placeholder="custom slug (optional)" aria-label="Custom slug" style="flex:0 1 200px" pattern="[A-Za-z0-9_\\-]{3,32}">
    <button>Shorten</button>
  </form>
  <div id="out" hidden></div>
</div>
<h2 style="font-size:1.1rem;margin-top:32px">Your links</h2>
<p class="muted" id="none">Links you create in this browser show up here.</p>
<div class="tablewrap"><table id="mine" hidden><thead><tr><th>Short</th><th>Destination</th><th>Clicks</th></tr></thead><tbody></tbody></table></div>
<script>
const KEY = "go.links";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
const save = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v.slice(0, 50))); } catch {} };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function renderMine() {
  const mine = load();
  const body = document.querySelector("#mine tbody");
  document.getElementById("none").hidden = mine.length > 0;
  document.getElementById("mine").hidden = mine.length === 0;
  body.innerHTML = "";
  for (const slug of mine) {
    const r = await fetch("${BASE}/api/links/" + encodeURIComponent(slug));
    if (!r.ok) continue;
    const l = await r.json();
    body.insertAdjacentHTML("beforeend",
      '<tr><td><a href="${BASE}/' + esc(l.slug) + '+">${SITE.go.replace("https://", "")}/' + esc(l.slug) + '</a></td>' +
      '<td style="word-break:break-all">' + esc(l.url) + '</td><td>' + l.clicks + '</td></tr>');
  }
}

document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const out = document.getElementById("out");
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const r = await fetch("${BASE}/api/links", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: fd.get("url"), slug: fd.get("slug") || undefined }) });
    const d = await r.json();
    out.hidden = false;
    if (!r.ok) { out.innerHTML = '<p class="err" style="margin:0">' + esc(d.error) + '</p>'; return; }
    out.innerHTML = '<div class="row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<a href="' + esc(d.short) + '" style="font-size:1.1rem;font-weight:600">' + esc(d.short.replace("https://", "")) + '</a>' +
      '<button class="ghost" type="button" id="copy">Copy</button></div>';
    document.getElementById("copy").onclick = async (ev) => {
      try { await navigator.clipboard.writeText(d.short); ev.target.textContent = "Copied"; } catch {}
    };
    save([d.slug, ...load().filter((s) => s !== d.slug)]);
    e.target.reset();
    renderMine();
  } finally { btn.disabled = false; }
});
renderMine();
</script>`,
});

function statsPage(l: Link): string {
  return page({
    title: `Stats: ${l.slug}`,
    active: "Links",
    body: `
<h1>${SITE.go.replace("https://", "")}/${esc(l.slug)}</h1>
<p class="lede" style="word-break:break-all">→ <a href="${esc(l.url)}" rel="noopener nofollow">${esc(l.url)}</a></p>
<div class="grid">
  <div class="card"><div class="muted">Clicks</div><div style="font-size:2rem;font-weight:700">${l.clicks}</div></div>
  <div class="card"><div class="muted">Created</div><div>${esc(l.created_at)} UTC</div></div>
  <div class="card"><div class="muted">Last click</div><div>${l.last_click_at ? esc(l.last_click_at) + " UTC" : "never"}</div></div>
</div>`,
  });
}

function adminPage(): string {
  const rows = q.all.all().map((l) => `<tr>
    <td><a href="${BASE}/${esc(l.slug)}+">${esc(l.slug)}</a></td>
    <td style="word-break:break-all">${esc(l.url)}</td><td>${l.clicks}</td><td>${esc(l.created_at)}</td>
    <td><form method="post" action="${BASE}/admin/delete"><input type="hidden" name="slug" value="${esc(l.slug)}"><button class="ghost">Delete</button></form></td>
  </tr>`).join("");
  return page({
    title: "Links admin",
    active: "Links",
    body: `<h1>All links</h1><p class="lede">Most recent 500.</p>
<div class="tablewrap"><table><thead><tr><th>Slug</th><th>URL</th><th>Clicks</th><th>Created (UTC)</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" class="muted">No links yet.</td></tr>'}</tbody></table></div>`,
  });
}

const notFound = () =>
  html(page({ title: "Not found", active: "Links", body: `<h1>Link not found</h1><p class="lede"><a href="${SITE.go}/">Create a short link</a></p>` }), { status: 404 });

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = stripBase(decodeURIComponent(url.pathname), BASE);
    if (path === null) return notFound();

    if (path === "/health") return new Response("ok");
    if (path === "/") return html(home);

    if (path === "/api/links" && req.method === "POST") {
      const ip = clientIp(req, server);
      if (!rateLimit(`create:${ip}`, 20, 60 * 60_000)) return json({ error: "Too many links created. Try again later." }, 429);
      let body: { url?: string; slug?: string };
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const target = validUrl(body.url ?? "");
      if (!target) return json({ error: "Enter a valid http(s) URL." }, 400);

      let slug = body.slug?.trim();
      if (slug) {
        if (!SLUG_RE.test(slug)) return json({ error: "Slug must be 3–32 letters, numbers, - or _." }, 400);
        if (RESERVED.has(slug.toLowerCase()) || q.get.get(slug)) return json({ error: "That slug is taken." }, 409);
      } else {
        do slug = randomSlug(); while (q.get.get(slug));
      }
      q.insert.run(slug, target, ip);
      return json({ slug, url: target, short: `${SITE.go}/${slug}` }, 201);
    }

    const apiMatch = path.match(/^\/api\/links\/([A-Za-z0-9_-]+)$/);
    if (apiMatch && req.method === "GET") {
      const l = q.get.get(apiMatch[1]);
      return l ? json(l) : json({ error: "Not found" }, 404);
    }

    if (path === "/admin" || path === "/admin/delete") {
      if (!authorized(req)) {
        return new Response("Authentication required", {
          status: 401, headers: { "www-authenticate": 'Basic realm="go admin"' },
        });
      }
      if (path === "/admin/delete" && req.method === "POST") {
        const fd = await req.formData();
        q.del.run(String(fd.get("slug") ?? ""));
        return Response.redirect(`${SITE.go}/admin`, 303);
      }
      return html(adminPage());
    }

    const m = path.match(/^\/([A-Za-z0-9_-]{3,32})(\+)?$/);
    if (!m) return notFound();
    const link = q.get.get(m[1]);
    if (!link) return notFound();
    if (m[2]) return html(statsPage(link));

    q.click.run(link.slug);
    return new Response(null, { status: 302, headers: { location: link.url, "cache-control": "no-store" } });
  },
});

console.log(`go on :${PORT}`);
