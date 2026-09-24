import { page, html, SITE, ROUTING, basePath } from "../shared/lib";

const PORT = Number(process.env.PORT ?? 8000);

const APPS = [
  { name: "Link shortener", url: SITE.go, health: `http://127.0.0.1:3001${basePath("go")}/health`,
    desc: "Turn long URLs into short links, with click counts." },
  { name: "Web tools", url: SITE.tools, health: `http://127.0.0.1:3002${basePath("tools")}/health`,
    desc: "WHOIS, DNS records, SSL certificates, HTTP headers and your IP." },
  { name: "Web widgets", url: SITE.widgets, health: `http://127.0.0.1:3003${basePath("widgets")}/health`,
    desc: "Embeddable clocks, countdowns, weather and counters for any site." },
];

async function up(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// In path mode, /go, /tools and /widgets are reverse-proxied to their app servers.
const UPSTREAMS: Record<string, number> = { go: 3001, tools: 3002, widgets: 3003 };
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "content-encoding", "content-length"];

async function proxy(req: Request, port: number, url: URL): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("host");
  try {
    const r = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: req.method, headers, body: req.body, redirect: "manual", signal: AbortSignal.timeout(30_000),
    });
    const out = new Headers(r.headers);
    for (const h of HOP_BY_HOP) out.delete(h);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: out });
  } catch {
    return new Response("Upstream unavailable", { status: 502 });
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    const app = pathname.split("/")[1];
    if (ROUTING === "path" && UPSTREAMS[app]) {
      if (pathname === `/${app}`) return Response.redirect(`${SITE.root}/${app}/${url.search}`, 301);
      return proxy(req, UPSTREAMS[app], url);
    }
    if (pathname === "/health") return new Response("ok");
    if (pathname !== "/") return html(page({ title: "Not found", body: "<h1>Not found</h1>" }), { status: 404 });

    const status = await Promise.all(APPS.map((a) => up(a.health)));
    const cards = APPS.map(
      (a, i) => `<a class="card" href="${a.url}" style="text-decoration:none;color:inherit;display:block">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <strong>${a.name}</strong>
          <span class="${status[i] ? "ok" : "err"}" style="font-size:13px">● ${status[i] ? "up" : "down"}</span>
        </div>
        <p class="muted" style="margin:8px 0 10px">${a.desc}</p>
        <code class="muted">${a.url.replace("https://", "")}</code>
      </a>`,
    ).join("");

    return html(page({
      title: "d.boxd.sh",
      active: "Home",
      body: `<h1>d.boxd.sh</h1><p class="lede">A few small apps running on one boxd VM.</p><div class="grid">${cards}</div>`,
    }));
  },
});

console.log(`landing on :${PORT}`);
