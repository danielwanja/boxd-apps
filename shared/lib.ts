// Shared helpers for all apps: HTML layout, escaping, client IP, rate limiting.

// ROUTING=path serves apps at d.boxd.sh/go, /tools, /widgets (proxied by landing).
// ROUTING=subdomain serves them at go.d.boxd.sh etc. once the edge has TLS for those names.
export const ROUTING = process.env.ROUTING === "subdomain" ? "subdomain" : "path";
const ROOT = "https://d.boxd.sh";
const APPS = ["go", "tools", "widgets"] as const;
type AppName = (typeof APPS)[number];

export const SITE: Record<"root" | AppName, string> = {
  root: ROOT,
  ...(Object.fromEntries(APPS.map((a) => [a, ROUTING === "path" ? `${ROOT}/${a}` : `https://${a}.d.boxd.sh`])) as Record<AppName, string>),
};

/** URL path prefix an app is mounted under ("" in subdomain mode). */
export const basePath = (app: AppName) => (ROUTING === "path" ? `/${app}` : "");

/** Strip an app's base path from a request path; null if the path is outside it. */
export function stripBase(pathname: string, base: string): string | null {
  if (!base) return pathname;
  if (pathname === base) return "/";
  return pathname.startsWith(base + "/") ? pathname.slice(base.length) : null;
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const CSS = `
:root{
  --bg:#f7f7f5;--surface:#fff;--text:#1b1b1f;--muted:#6b6b76;--border:#e3e3e0;
  --accent:#4f46e5;--accent-text:#fff;--code:#f0f0ee;--ok:#15803d;--err:#b91c1c;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#111114;--surface:#1a1a1f;--text:#ececf1;--muted:#9a9aa6;--border:#2c2c33;
  --accent:#818cf8;--accent-text:#111114;--code:#232329;--ok:#4ade80;--err:#f87171;
  color-scheme:dark;
}}
:root[data-theme="dark"]{
  --bg:#111114;--surface:#1a1a1f;--text:#ececf1;--muted:#9a9aa6;--border:#2c2c33;
  --accent:#818cf8;--accent-text:#111114;--code:#232329;--ok:#4ade80;--err:#f87171;
  color-scheme:dark;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.wrap{max-width:880px;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--border);background:var(--surface)}
header.top .wrap{display:flex;gap:18px;align-items:center;flex-wrap:wrap;padding-block:12px}
header.top .brand{font-weight:700;text-decoration:none;color:var(--text)}
header.top nav{display:flex;gap:14px;flex-wrap:wrap}
header.top nav a{color:var(--muted);text-decoration:none}
header.top nav a.on,header.top nav a:hover{color:var(--text)}
main{padding-block:32px 64px}
h1{font-size:1.7rem;margin:0 0 6px}
.lede{color:var(--muted);margin:0 0 24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
form.row{display:flex;gap:8px;flex-wrap:wrap}
input,select,button,textarea{font:inherit;color:inherit}
input,select,textarea{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 11px;min-width:0}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}
form.row input{flex:1 1 220px}
button,.btn{background:var(--accent);color:var(--accent-text);border:0;border-radius:8px;padding:9px 16px;
  cursor:pointer;font-weight:600;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--border)}
button:disabled{opacity:.6;cursor:default}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{background:var(--code);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;margin:0}
.muted{color:var(--muted)}
.ok{color:var(--ok)}.err{color:var(--err)}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:13px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}
.stack>*+*{margin-top:14px}
`;

const NAV: [string, string][] = [
  ["Home", SITE.root],
  ["Links", SITE.go],
  ["Tools", SITE.tools],
  ["Widgets", SITE.widgets],
];

export function page(opts: { title: string; body: string; active?: string; head?: string }): string {
  const nav = NAV.map(
    ([name, href]) => `<a href="${href}"${opts.active === name ? ' class="on"' : ""}>${name}</a>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title><style>${CSS}</style>${opts.head ?? ""}</head>
<body><header class="top"><div class="wrap"><a class="brand" href="${SITE.root}">d.boxd.sh</a><nav>${nav}</nav></div></header>
<main class="wrap">${opts.body}</main></body></html>`;
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** Real client IP: the boxd proxy sets X-Forwarded-For. */
export function clientIp(req: Request, server: { requestIP(r: Request): { address: string } | null }): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? server.requestIP(req)?.address ?? "unknown";
}

/** Fixed-window in-memory rate limiter. Returns true if the request is allowed. */
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  b.n++;
  return b.n <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref?.();
