# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/danielwanja/boxd-apps/security/advisories/new)
rather than opening a public issue. Include steps to reproduce and the affected app (`landing`, `go`, `tools` or `widgets`).

## How the apps protect themselves

- **Secrets** stay in `.env`, which is gitignored. The only secret is `ADMIN_PASSWORD`; the admin page is disabled when it's unset.
- **Admin page (`/go/admin`)**: HTTP Basic auth with a constant-time password check, a lockout after 10 failed attempts per IP in 15 minutes, and a same-origin check on deletes (browsers resend Basic credentials on cross-site form posts).
- **Web tools**: input is validated as a domain or IP, and `whois`/`dig` run through `Bun.spawn` with an argument array (no shell) and timeouts. The SSL and header tools refuse private, loopback, link-local, CGNAT, multicast, documentation, NAT64 and 6to4 addresses. The header tool pins each request to the IP it vetted, so DNS rebinding can't redirect it to an internal address, and it re-checks every redirect hop.
- **Output encoding**: HTML is escaped server-side (`esc`) and client-side, and values placed in inline scripts escape `<`.
- **Headers**: every page sends `X-Content-Type-Options: nosniff`, `Referrer-Policy` and `frame-ancestors 'none'`. Widget pages are the one exception: they allow framing so they can be embedded.
- **Rate limits** per client IP on link creation, lookups, counter bumps and weather lookups. The in-memory limiter and the weather cache are size-bounded.
- **Network**: in path mode the apps on ports 3001–3003 listen on `127.0.0.1` only, behind the landing proxy.

## Deployment assumptions

- The client IP comes from the first `X-Forwarded-For` entry. That's safe behind the boxd proxy, which overwrites the header. Behind a proxy that appends to it instead, clients could spoof their IP and evade rate limits, so change `clientIp()` in `shared/lib.ts`.
- The link shortener is an open redirector by design. Watch for abuse and remove links from `/go/admin`.
- The shortener stores the creator's IP with each link (`go/links.db`) for abuse handling.
