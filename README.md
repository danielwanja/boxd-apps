# boxd-apps

Three small web apps and a landing page, running together on a single [boxd.sh](https://boxd.sh) VM
and served at **https://d.boxd.sh**.

| App | What it does | Live URL | Folder | Port |
|---|---|---|---|---|
| Landing | Links to each app with a live up/down status, and routes `/go`, `/tools`, `/widgets` | https://d.boxd.sh | `landing/` | 8000 |
| Link shortener | Short links with click counts | https://d.boxd.sh/go | `go/` | 3001 |
| Web tools | WHOIS, DNS, SSL certificate, HTTP header and IP lookups, like who.is | https://d.boxd.sh/tools | `tools/` | 3002 |
| Web widgets | Embeddable clock, countdown, weather and visitor-counter widgets | https://d.boxd.sh/widgets | `widgets/` | 3003 |

Stack: [Bun](https://bun.sh) with TypeScript, `bun:sqlite` for storage, and no framework or build step.
Each app is a single `server.ts`, and they share `shared/lib.ts` (page layout, light/dark theme, HTML escaping, client IP and rate limiting).

---

## The apps

### Link shortener (`go/`)

- Paste a URL and get `d.boxd.sh/go/<slug>`, either random or a custom slug (3–32 characters).
- Add `+` to any short link (`/go/<slug>+`) to see its stats: clicks, when it was created and when it was last clicked.
- Your links page lists the links created in your browser (stored in localStorage).
- `/go/admin` lists every link and lets you delete them. It uses HTTP Basic auth with `ADMIN_PASSWORD` from `.env` (any username).
- Links are stored in SQLite (`go/links.db`). Only `http(s)` URLs are accepted, and a short link can't point back to the shortener.
- Each IP can create 20 links per hour.

API:

```bash
curl -X POST https://d.boxd.sh/go/api/links -H 'content-type: application/json' \
     -d '{"url":"https://example.com/long/path","slug":"optional"}'
curl https://d.boxd.sh/go/api/links/<slug>
```

### Web tools (`tools/`)

Inspired by who.is. Lookups run on the server, so you see what the public internet sees.

| Tool | How it works |
|---|---|
| WHOIS | Runs the system `whois` and shows a parsed summary plus the raw record |
| DNS | Queries A, AAAA, CNAME, MX, NS, TXT, SOA and CAA records via `dig @1.1.1.1` (or PTR for an IP) |
| SSL certificate | Opens a TLS connection with `node:tls` and reports trust, issuer, expiry, SANs, chain and fingerprint |
| HTTP headers | Fetches the URL and follows up to 10 redirects, showing the status, timing and headers for each hop |
| My IP | Shows the visitor's IP (from `X-Forwarded-For`), reverse DNS and user agent |

Lookups can be shared by URL, for example `https://d.boxd.sh/tools/?tool=dns&q=example.com`.
JSON API: `/tools/api/{whois,dns,ssl,headers,ip}?q=...`

Safeguards:

- Input is strictly validated as a domain or IP.
- Commands run through `Bun.spawn` with an argument array, never a shell, and with timeouts.
- The SSL and header tools refuse private, loopback and link-local addresses (SSRF guard).
- Each IP can make 30 lookups per minute.

### Web widgets (`widgets/`)

Inspired by webstage.app/widgets. The builder at https://d.boxd.sh/widgets lets you configure a widget, preview it live and copy two lines of HTML:

```html
<div data-dwidget="clock" data-tz="Europe/Paris" data-format="24"></div>
<script async src="https://d.boxd.sh/widgets/embed.js"></script>
```

| Widget | Options |
|---|---|
| `clock` | `tz`, `label`, `format` (12/24), `seconds` (1/0) |
| `countdown` | `to` (ISO date/time), `label`, `done` (message shown at zero) |
| `weather` | `city`, `units` (c/f), `label`. Data from [Open-Meteo](https://open-meteo.com), no API key needed, cached for 10 minutes |
| `counter` | `id` (unique per site), `label`. Stored in SQLite; each visitor counts at most once per 30 minutes |

All widgets accept `theme` (`light`/`dark`; the default follows the visitor's system setting).

`embed.js` replaces each `[data-dwidget]` element with an iframe (`/widgets/w/<name>?...`). The widget reports its height with `postMessage`, so the iframe resizes to fit.

---

## How we used boxd.sh

[boxd](https://boxd.sh) provides a Linux VM (KVM microVM) with a persistent disk, root access and a public HTTPS domain. This whole project runs on one of them, a VM named `d`.

### 1. Public HTTPS with no setup

Every boxd VM gets `https://<name>.boxd.sh`. The boxd proxy handles TLS and forwards plain HTTP to a port on the VM (8000 by default). There's no nginx, certbot or DNS to configure: anything listening on port 8000 is live on the internet.

```bash
boxd machine proxy set-port --port=8000     # pin the default proxy to the landing app
```

### 2. Several apps on one VM

boxd can publish extra subdomains that each point at a different port on the same VM, with no new VM needed:

```bash
boxd machine proxy new go      --port=3001   # go.d.boxd.sh      -> :3001
boxd machine proxy new tools   --port=3002   # tools.d.boxd.sh   -> :3002
boxd machine proxy new widgets --port=3003   # widgets.d.boxd.sh -> :3003
boxd machine proxy list
```

**What we ran into:** the boxd edge serves a `*.boxd.sh` wildcard certificate, which covers `d.boxd.sh` but not two-level names like `go.d.boxd.sh`. The TLS handshake for those fails with `alert access denied`. So the apps currently run in **path mode**: the landing server on port 8000 reverse-proxies `/go`, `/tools` and `/widgets` to ports 3001–3003, and each app knows its base path.

Both modes are built in. When subdomain TLS works (or with a custom domain; boxd supports `boxd machine domain add`), set `ROUTING=subdomain` in `.env` and restart. Every app then serves from the root of its own subdomain, and all links, API calls and the widget embed script follow automatically (see `shared/lib.ts`).

### 3. A real Linux machine

Because it's a full Ubuntu VM rather than serverless functions, the web tools can shell out to real system tools (`sudo apt install whois`, plus the preinstalled `dig` and `openssl`) and open raw TLS sockets. SQLite files sit on the VM's persistent disk, so no separate database service is needed.

### 4. Services with systemd

All four apps run as instances of a single systemd template unit ([`deploy/app@.service`](deploy/app@.service)), so they start on boot and restart if they crash:

```bash
sudo systemctl enable --now app@landing app@go app@tools app@widgets
sudo systemctl restart app@go
journalctl -u app@tools -f
```

### 5. Auto-suspend

After 15 minutes with no inbound traffic, boxd puts the VM into standby, which uses no CPU or billable memory. The first request wakes it in under a millisecond, so the apps stay available while costing almost nothing when idle. This VM uses the default:

```bash
boxd info                                          # shows the auto-suspend setting
boxd machine config set auto-suspend.timeout 900   # standby after 15 minutes idle (0 disables)
```

The trap is CPU-only or timer-driven work (cron, long batch jobs), which looks idle and gets paused. Scheduled work belongs in boxd's `run` automations, which wake the VM when a job is due.

### 6. Built with an agent on the VM

The apps were built and deployed by Claude Code running directly on the boxd VM. It wrote the code, created the proxies and systemd services, tested every endpoint through the public URL, and checked the pages in the VM's own browser, which the boxd console streams live.

---

## Running it yourself

On a boxd VM (or any Linux box with Bun):

```bash
git clone https://github.com/danielwanja/boxd-apps.git ~/apps && cd ~/apps
bun install                                  # dev types only; the apps have no runtime dependencies
sudo apt install -y whois dnsutils
cp .env.example .env && chmod 600 .env       # set ADMIN_PASSWORD
sudo cp deploy/app@.service /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now app@landing app@go app@tools app@widgets
```

The systemd unit assumes the repo lives at `/home/boxd/apps` and runs as user `boxd`. Adjust it for other machines.

Type-check with `bunx tsc -p .`

### Adding an app

1. Create `newapp/server.ts` listening on the next port (3004). Use `basePath("newapp")` and `stripBase()` from `shared/lib.ts`.
2. Add it to `APPS` in `shared/lib.ts`, and to `UPSTREAMS` and `APPS` in `landing/server.ts`.
3. Run `sudo systemctl enable --now app@newapp` and `boxd machine proxy new newapp --port=3004`.

## Layout

```
landing/server.ts    landing page + path-mode reverse proxy (:8000)
go/server.ts         link shortener (:3001)
tools/server.ts      web tools (:3002)
widgets/server.ts    widget builder, widget pages, embed.js (:3003)
shared/lib.ts        layout, CSS, routing mode, escaping, rate limiting
deploy/app@.service  systemd template unit
.env.example         ADMIN_PASSWORD, ROUTING
```
