# Restaurant POS and billing

Restaurant point-of-sale and GST billing software for India. See
[docs/PRD_AND_ARCHITECTURE.md](docs/PRD_AND_ARCHITECTURE.md) for requirements and design, and
[DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) for what works today.

## Run it locally

Needs Node 22+, pnpm 11 and Docker.

```bash
cp .env.example .env        # then replace every "change-me" and the JWT secret
pnpm install
pnpm infra:up               # Postgres, Redis, Mailpit
pnpm db:deploy              # apply migrations
pnpm build                  # builds shared packages (needed once before seeding)
pnpm db:seed                # demo restaurant; skipped if one exists
pnpm dev                    # all apps
```

| App | URL |
|---|---|
| API | http://localhost:4000/api/v1 (Swagger at `/api/docs`) |
| Back office | http://localhost:3100 |
| POS | http://localhost:3101 |
| Kitchen display | http://localhost:3102 |
| Platform admin (for the vendor) | http://localhost:3103 |
| Print bridge | http://127.0.0.1:9110/health |
| Mailpit (captured email) | http://localhost:8026 |

## Deploying

[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) is a step-by-step guide for putting everything on one Linux
server with Docker and automatic HTTPS, with backups, updates and a laptop rehearsal. The files it uses
are the `Dockerfile` and `infra/prod/`.

## Tests

```bash
pnpm test                          # unit tests
pnpm --filter @pos/api test:int    # API tests against real Postgres, Redis and Mailpit
pnpm test:e2e                      # browser tests in Chrome
PERF=1 pnpm --filter @pos/api test:int test/perf.int-spec.ts   # load benchmark, on request (a few minutes)
```

All three need `pnpm infra:up`. The API and browser tests create their own databases
(`pos_test`, `pos_e2e`) and never touch development data. The browser tests start their own API
and back office on ports 4100 and 3200, so they can run while `pnpm dev` is up. They compile
their own copy of the API each time.

## Thermal printing

Bills and kitchen tickets print through the browser's print dialog until a print bridge is connected.
To print straight to thermal printers:

1. In the back office open Settings, Printers. Add a print bridge and copy the token it shows (it is shown once).
2. On the computer at the counter, put the token in `PRINT_BRIDGE_TOKEN` and the API address in
   `PRINT_BRIDGE_API_URL` (in `.env`, or in the environment), then start the bridge:
   `pnpm --filter @pos/print-bridge build && pnpm --filter @pos/print-bridge start`.
   `pnpm dev` also starts it. Within half a minute the bridge shows as Connected on the Printers page.
3. Add the printers on the same page and press the test print button on each.

A network printer needs its IP address; the port is almost always 9100. A USB or Bluetooth printer needs
either its device (`/dev/usb/lp0`, `COM5`) or the name it is installed under on the bridge computer.
The bridge prints only to ports 9100 to 9109 and to the usual printer devices. For anything else, list
it in `PRINT_BRIDGE_ALLOW_PORTS` or `PRINT_BRIDGE_ALLOW_DEVICES` on the bridge computer.

## Restaurants and the platform admin

More than one restaurant can use the same installation, each seeing only its own data.

- A restaurant registers itself at http://localhost:3100/signup. The confirmation email is captured by
  Mailpit (http://localhost:8026): open it and follow the link, then sign in.
- The vendor's own staff use the platform admin app, http://localhost:3103, to see every restaurant, add
  one, change its trial, record a payment, and suspend or restore it. Its first account comes from
  `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` in `.env`, created by `pnpm db:seed`.
- `SIGNUP_ENABLED=false` closes registration; `TRIAL_DAYS` sets the length of the free trial.

## Mobile app

The billing screen as an Android and iOS app is a separate project, `billing-software-mobile`, kept beside
this one so this repository stays small. It uses this API and signs in as the `mobile` client: with no
browser to hold a cookie, it is given its refresh token in the sign-in answer and sends it back in the
`X-Refresh-Token` header. It keeps a copy of `packages/types`, `validation`, `billing-core`, `api-client` and
`printing`; after changing any of them, run `npm run sync-shared` in that project.

## Signing in locally

The seed creates an owner and a cashier. Their email addresses, passwords and PINs are the
`SEED_*` values in your `.env`. The owner can sign in everywhere. The cashier is a billing-only
account: it signs in on the POS (port 3101), not the back office.

## Layout

```
apps/api            NestJS REST API
apps/web            Back office (Next.js)
apps/pos            POS terminal (Next.js)
apps/kds            Kitchen display (Next.js)
apps/admin          Platform admin for the vendor (Next.js)
apps/print-bridge   Print bridge: sends bills and kitchen tickets to thermal printers
e2e                 Playwright browser tests
packages/database   Prisma schema, migrations, seed
packages/billing-core  Money, tax and numbering logic shared by API and POS
packages/validation Zod schemas shared by API and front ends
packages/types      Permissions, event names, shared types
packages/api-client Typed REST client
packages/ui         Component library and design tokens
infra/docker        Docker Compose for local infrastructure
infra/prod          Production: compose stack, HTTPS proxy, backup, restore and smoke test
```

To change the database: edit `packages/database/prisma/schema.prisma`, then `pnpm db:migrate`.
Rules Prisma cannot express (check constraints, triggers, partial indexes) go in a hand-written
SQL migration.
