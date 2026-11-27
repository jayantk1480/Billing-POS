# Deploying on one server

This guide puts the whole product on a single Linux server: the back office, the billing screen, the
kitchen display, the platform admin, the API, the database and Redis, all in Docker, with HTTPS set up
automatically. It is meant for the first restaurants. Section 11 says what it does not give you.

> **What has been tested.** The whole of section 12 was run on a laptop on 23 November 2026, with Docker
> given 4 GB of memory: the image built, every service started, a restaurant registered through the proxy,
> confirmed its email, billed an order and took payment; then a backup, a complete wipe, a restore, and a
> check that the bill and its photo came back; then an update, a change of the admin password, and the
> admin address limit. **Not tested**, because they need a real server: HTTPS certificates, real email
> delivery, and a build on an x86 server (the laptop is ARM). Expect to sort out small things on first use.

You do not need to know Docker. Every command is given in full. Run them in order.

## 1. What you need

| | |
|---|---|
| **A server** | Ubuntu 24.04, 2 CPUs, 4 GB RAM, 40 GB disk or more. Any provider (AWS Lightsail or EC2, DigitalOcean, Hetzner, E2E Networks). Choose a region in India if your restaurants are in India. |
| **A domain name** | For example `yourbrand.in`. You need to be able to add DNS records for it. |
| **An email-sending account** | SMTP details from Amazon SES, Brevo, Zoho Mail or similar. The product emails confirmation links and password links; without real email nobody can register. |
| **About two hours** | Most of it is waiting for the first build. |

## 2. The five addresses

The product uses five addresses. They **must all be under the same domain**, because signing in relies on
a cookie that the browser only sends within one site.

| Address (example) | What it is |
|---|---|
| `app.yourbrand.in` | Back office, and where restaurants register |
| `pos.yourbrand.in` | Billing screen |
| `kds.yourbrand.in` | Kitchen display |
| `admin.yourbrand.in` | Platform admin, for you only |
| `api.yourbrand.in` | The API. The four apps and each restaurant's print bridge talk to it |

In your domain's DNS settings add five **A records**, one for each name, all pointing at the server's
public IP address. Check one before going on (it should print the server's address):

```bash
dig +short app.yourbrand.in
```

Do this first. HTTPS certificates can only be issued once the names point at the server.

## 3. Prepare the server

Sign in to the server as root (your provider shows how), then:

```bash
# A user of your own, so that you do not work as root
adduser deploy
usermod -aG sudo deploy

# Firewall: only SSH and the web
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy

# 4 GB of swap. The first build needs more memory than a 4 GB server has spare.
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Security updates install themselves
apt-get update && apt-get install -y unattended-upgrades git
```

Sign out and sign back in as `deploy`. Everything from here on is done as `deploy`.

## 4. Get the code and fill in the settings

```bash
sudo mkdir -p /srv/pos && sudo chown deploy:deploy /srv/pos
git clone <the address of your repository> /srv/pos
cd /srv/pos/infra/prod
cp .env.example .env
nano .env
```

Fill in `.env`. Every line has a comment. The ones you must set:

| Setting | What to put |
|---|---|
| `APP_DOMAIN`, `POS_DOMAIN`, `KDS_DOMAIN`, `ADMIN_DOMAIN`, `API_DOMAIN` | The five names from section 2, without `https://` |
| `ACME_EMAIL` | Your email, for notices about HTTPS certificates |
| `POSTGRES_PASSWORD` | The output of `openssl rand -hex 24` |
| `JWT_ACCESS_SECRET` | The output of `openssl rand -hex 48` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | From your email provider |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` | Your own sign-in to the platform admin. Password of 12 characters or more: `openssl rand -base64 18` |

Keep this file private. It is not in git, and it must never be. Save a copy of it somewhere safe that is
not this server: without `POSTGRES_PASSWORD` and `JWT_ACCESS_SECRET` a restored backup cannot be used as it was.

```bash
chmod 600 .env
```

## 5. Build and start

```bash
cd /srv/pos/infra/prod
docker compose build        # 10 to 30 minutes the first time, depending on the server
docker compose up -d
docker compose ps
```

`docker compose ps` should show `api`, `web`, `pos`, `kds`, `admin`, `postgres`, `redis` and `caddy` as
running, with `api`, `postgres` and `redis` marked **healthy** after about a minute. `migrate` shows as
exited: it applies database changes and stops, which is correct.

The first time each address is opened, Caddy gets its HTTPS certificate. That takes a few seconds.

Now check it from the outside:

```bash
./smoke.sh
```

It checks that the API is healthy, that each of the four apps answers, that live updates can connect, and
(after the next section) that the platform admin can sign in. It changes nothing. Every line should say `ok`.

## 6. Create your sign-in and the first restaurant

```bash
docker compose run --rm platform-admin
```

This creates the platform admin from `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` in `.env`.

Do **not** run `pnpm db:seed` on a real server. It creates a demo restaurant with sample data.

Then:

1. Open `https://admin.yourbrand.in` and sign in.
2. Add a restaurant ("Add restaurant"), or let the owner register at `https://app.yourbrand.in/signup`.
3. The owner gets an email with a link. If no email arrives, see section 10.
4. The owner signs in at `https://app.yourbrand.in`, sets up the menu, and bills at `https://pos.yourbrand.in`.

**To change the platform admin's password later:** put the new password in `.env`, then run the same
command again. It also signs the admin out everywhere.

**Limit who can reach the admin app.** It has no two-step sign-in yet. Once you know the public IP address
you work from, put it in `.env` and restart Caddy; everyone else then gets "Not found":

```bash
# in .env
ADMIN_ALLOWED_IPS="203.0.113.7"

docker compose up -d caddy
```

## 7. Connecting a restaurant's printers

Thermal printing uses a small program, the print bridge, on a computer at the restaurant. It connects out
to your server, so the restaurant needs no open ports. On that computer set:

```
PRINT_BRIDGE_API_URL=https://api.yourbrand.in
PRINT_BRIDGE_TOKEN=<the token shown once under Settings, Printers in the restaurant's back office>
```

The README's "Thermal printing" section has the rest. The bridge is not yet packaged as an installer.

## 8. Backups

A backup is the database plus the uploaded photos. Without one, a failed disk loses every bill.

**Make one now, by hand:**

```bash
cd /srv/pos/infra/prod
./backup.sh
ls backups/
```

**Make one every night at 2:15:**

```bash
sudo touch /var/log/pos-backup.log && sudo chown deploy /var/log/pos-backup.log
( crontab -l 2>/dev/null; echo "15 2 * * * /srv/pos/infra/prod/backup.sh >> /var/log/pos-backup.log 2>&1" ) | crontab -
```

Backups older than 14 days are removed (`BACKUP_KEEP_DAYS`).

**Copy them off the server.** A backup that exists only on the server is lost with the server. Install
`rclone` (`sudo apt-get install -y rclone`), run `rclone config` once to set up a destination (Backblaze B2,
Amazon S3, Google Drive and many others are supported), then name it in `.env`:

```
BACKUP_REMOTE="b2:my-bucket/pos"
```

From then on every backup is also copied there. Check the log now and then: `tail /var/log/pos-backup.log`.

**Restoring.** This replaces everything on the server with what is in the backup. Bills made after that
backup are gone.

```bash
cd /srv/pos/infra/prod
./restore.sh backups/2026-11-23_021500
```

It asks you to type `RESTORE`, stops the apps, restores the database and the photos, and starts the apps again.

**Practise a restore before you need one.** Do it once on a second, throwaway server: copy a backup folder
and your `.env` there, follow sections 3 to 5, then run `restore.sh`. A backup you have never restored is
only a hope.

## 9. Updating to a new version

```bash
cd /srv/pos
./infra/prod/backup.sh          # always, before an update
git pull
cd infra/prod
docker compose build
docker compose up -d
./smoke.sh
```

Database changes are applied automatically when the stack starts. Restaurants see a pause of about a minute.
Do it outside meal times.

**If the new version misbehaves:** go back to the code you had, rebuild and start again.

```bash
cd /srv/pos
git log --oneline -5            # find the commit you were on before
git checkout <that commit>
cd infra/prod && docker compose build && docker compose up -d
```

If the update had already changed the database and the old version cannot work with it, restore the backup
you made before updating (section 8).

**If you change a domain name:** the names are built into the apps, so after editing `.env` you must run
`docker compose build` again, not only `up -d`.

## 10. When something is wrong

| What you see | What to do |
|---|---|
| A page does not load at all | `docker compose ps`. Anything not "running"? `docker compose logs --tail 100 <name>` shows why. |
| "Your connection is not private" | The DNS record for that name does not point at the server yet, or ports 80 and 443 are closed. `docker compose logs caddy` says which. |
| The apps load but nobody can sign in | Check that all five names are under the same domain, and that `.env` has no `https://` in front of them. |
| No emails arrive | `docker compose logs api | grep -i mail`. Wrong SMTP details show up there. Check `SMTP_FROM` is an address your provider allows. |
| `api` keeps restarting | `docker compose logs api`. A missing or too-short setting is named in the first lines. |
| The disk is full | `docker system prune -f` removes old build leftovers. Check `du -sh /srv/pos/infra/prod/backups`. |
| Everything was fine and now is slow | `docker stats` shows which service is using the memory. `free -h` shows whether the server is out of it. |

Useful commands, all run in `/srv/pos/infra/prod`:

```bash
docker compose ps                     # what is running
docker compose logs -f api            # follow the API's log (Ctrl+C to stop)
docker compose restart api            # restart one service
docker compose down                   # stop everything (data is kept)
docker compose up -d                  # start everything
curl https://api.yourbrand.in/api/v1/health
```

Set up a free uptime monitor (UptimeRobot, Better Stack) on `https://api.yourbrand.in/api/v1/health` so
that you hear about an outage before a restaurant calls.

**Never run `docker compose down -v`.** The `-v` deletes the database.

## 11. What this setup does not give you

Be clear with yourself about these before restaurants depend on it.

- **One server is one point of failure.** If it goes down, every restaurant stops billing until it is back.
  There is no second copy running. Offline billing (so a counter keeps working without the server) is not built yet.
- **Backups are nightly.** A disk failure at 9 pm loses that day's bills unless you run backups more often
  (add a second cron line) or move the database to a managed service with continuous backup.
- **Uploaded photos live on the server's disk**, in the `uploads` Docker volume. They are in the backup, but
  there is no S3 storage yet.
- **No CAPTCHA on registration.** One address can register five times an hour and nothing works until the
  email is confirmed, but it is not bot-proof. Set `SIGNUP_ENABLED=false` to add restaurants yourself only.
- **No two-step sign-in for the platform admin.** Use `ADMIN_ALLOWED_IPS` (section 6) and a long password.
- **Terms of service and a privacy policy are not in the product.** You need them before the public registers.
- **Subscription payment is recorded by hand** in the platform admin.
- **The image is large** (about 1.5 GB) because one image runs every service. It works; it is not optimised.
  Running, the whole stack used under 500 MB of memory when idle in the rehearsal.
- **Thermal printing has not been tried on a physical printer.**

When you outgrow one server, the next steps are a managed database (for example Amazon RDS) and a second
app server behind a load balancer. The product is already built for that: the API keeps no state of its own
outside Postgres, Redis and the uploads folder.

## 12. Rehearsing on a laptop first

You can run the same stack on your own computer, with no domain, no HTTPS and no real email. It needs
Docker Desktop with 4 GB of memory or more given to it and about 10 GB of free disk.

```bash
cd infra/prod
cp .env.example .env
# In .env set only POSTGRES_PASSWORD, JWT_ACCESS_SECRET, PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD.

export COMPOSE="docker compose -p pos-rehearsal -f docker-compose.yml -f docker-compose.local.yml"
$COMPOSE build
$COMPOSE up -d
$COMPOSE run --rm platform-admin
```

Then open:

| | |
|---|---|
| Back office | http://app.localhost:8080 |
| Billing screen | http://pos.localhost:8080 |
| Kitchen display | http://kds.localhost:8080 |
| Platform admin | http://admin.localhost:8080 |
| Captured email | http://localhost:8027 |

The full check, including registering a restaurant and billing an order:

```bash
API_URL=http://api.localhost:8080 APP_URL=http://app.localhost:8080 POS_URL=http://pos.localhost:8080 \
KDS_URL=http://kds.localhost:8080 ADMIN_URL=http://admin.localhost:8080 \
SMOKE_CONNECT=127.0.0.1:8080 MAILPIT_URL=http://localhost:8027 ./smoke.sh
```

It prints a line starting `SMOKE_CHECK=`. To rehearse a restore, keep that line, then:

```bash
./backup.sh
$COMPOSE down -v                     # throws the rehearsal's data away, on purpose
$COMPOSE up -d
./restore.sh backups/<the folder just made> --yes
SMOKE_CHECK='<the JSON after SMOKE_CHECK=>' API_URL=http://api.localhost:8080 APP_URL=http://app.localhost:8080 \
POS_URL=http://pos.localhost:8080 KDS_URL=http://kds.localhost:8080 ADMIN_URL=http://admin.localhost:8080 \
SMOKE_CONNECT=127.0.0.1:8080 ./smoke.sh
```

The last command signs in as the restaurant made earlier and confirms its bill and photo came back.
When you are done: `$COMPOSE down -v`.

## Files this guide uses

| File | What it is |
|---|---|
| `Dockerfile` | Builds the one image every service runs from |
| `infra/prod/docker-compose.yml` | The services, their settings and what starts before what |
| `infra/prod/Caddyfile` | HTTPS and which address goes to which service |
| `infra/prod/.env.example` | Every setting, with comments |
| `infra/prod/backup.sh`, `restore.sh` | Backup and restore |
| `infra/prod/smoke.sh`, `smoke.mjs` | The check from outside |
| `infra/prod/docker-compose.local.yml` | The laptop rehearsal |
| `packages/database/prisma/platform-admin.ts` | Creates the platform admin (`pnpm db:platform-admin`) |
