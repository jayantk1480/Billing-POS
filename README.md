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

## Run it in production

Everything runs on one server with Docker, and HTTPS is set up automatically. Follow the steps in order. Each
step says what it does, where you do it, what to type, and what you should see. Allow about two hours the first
time; most of it is waiting. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) has more background on each step.

The examples use the values below. **Replace them with your own** everywhere they appear:

| In the examples | Means |
|---|---|
| `yourbrand.in` | Your domain |
| `203.0.113.10` | Your server's public IP address |
| `you@yourbrand.in` | Your email address |
| `198.51.100.7` | Your office's public IP address |

### Before you start: get three things ready

**1. A server.** This is a computer in a data centre that you rent by the month. The whole product runs on it.

- Create one at Hostinger, AWS Lightsail, DigitalOcean, Hetzner or E2E Networks. It must be a **VPS** (a
  server you get root access to), not website hosting. Choose **Ubuntu 24.04**, at least **2 CPUs, 4 GB RAM and
  40 GB disk**, and a location in India if your restaurants are in India. On Hostinger, follow
  "If you use Hostinger" below.
- When it is ready, the provider's dashboard shows its **public IPv4 address**, for example `203.0.113.10`.
  You need it in Step 1 and Step 2.
- **On AWS, give the server a fixed address**, or the address changes when the server restarts and every
  restaurant loses the site. Lightsail: Networking, Create static IP, attach it to the server. EC2: Elastic IPs,
  Allocate, then Associate it with the server. Use the fixed address from then on.
- **On AWS, open the web ports in AWS's own firewall.** Lightsail: the server's Networking tab, IPv4 Firewall,
  add a rule for HTTPS (SSH and HTTP are usually there already). EC2: the server's security group, Edit inbound
  rules, allow SSH (22), HTTP (80) and HTTPS (443) from anywhere. DigitalOcean and Hetzner have no such firewall
  unless you added one; if you did, allow the same three ports.

**2. A domain name**, for example `yourbrand.in`, bought from GoDaddy, Hostinger, Namecheap, Cloudflare or any
other seller. You need to be able to sign in to the account where it was bought.

**3. An email service.** The product sends emails: the link that confirms a new restaurant, and links to reset a
password. It sends them through an email service, using SMTP. Pick one:

| Service | What to do there | What you get |
|---|---|---|
| **Brevo** (simplest) | Sign up. In the settings, under senders and domains, add your domain and add the DNS records it shows you (on the same DNS page as Step 1). Then open SMTP & API, the SMTP tab, and generate an SMTP key | Host `smtp-relay.brevo.com`, port `587`, the login shown on that page, and the key as the password |
| **Amazon SES** | Choose the Mumbai region. Under Identities, add your domain and add the DNS records it shows you. Under SMTP settings, create SMTP credentials. Then **request production access**: until AWS grants it, SES sends only to addresses you have verified, so restaurant owners get no email | Host `email-smtp.ap-south-1.amazonaws.com`, port `587`, an SMTP username (starts with `AKIA`) and a password |
| **Zoho Mail** | Use a mailbox on your domain, for example `no-reply@yourbrand.in`. If the account has two-step sign-in, create an app password for it | Host `smtp.zoho.in`, port `587`, the mailbox address as the username, and its password or app password |

Write down the host, port, username and password. You need them in Step 4.

### If you use Hostinger

These are the Hostinger screens for "Before you start" and Steps 1 and 2. Hostinger renames its menus from time
to time; if a name here differs, look for the nearest match.

**Buy the server**

1. On hostinger.com, open **VPS hosting**. Do not use the plans under "Websites": Single, Premium, Unlimited
   and Cloud Startup are website hosting. They give no root access and cannot run Docker, so the product cannot
   run on them, however much memory they list.
2. Choose **KVM 2** (2 vCPU, 8 GB RAM, 100 GB disk). KVM 1 (1 vCPU, 4 GB RAM) also works, but builds are slow.
3. In the cart:
   - **Period:** the longest term (24 months at the time of writing) has the lowest monthly price. The cart shows
     the higher price the plan renews at afterwards. 18% GST is added to the total.
   - **Daily auto-backup:** leave it unticked. The product makes its own nightly backups (Step 7), and the plan
     already includes a free weekly backup.
   - **Server location:** India.
   - **Free domain:** if the cart says "choose after purchase", you claim it in hPanel after paying (below).
4. Pay. There is a 30-day money-back guarantee.

**Set up the VPS.** hPanel (hpanel.hostinger.com) asks for these straight after payment:

1. **Operating system:** choose plain **Ubuntu 24.04**. Do not choose a template with a control panel or an
   app already installed.
2. **Root password:** set a strong one and save it in your password manager. You sign in with it in Step 2.
3. **Extras offered** (malware scanner and the like): optional; you can skip them.
4. Wait a few minutes until the VPS shows as running.

**Find the server's IP address:** hPanel, **VPS**, your server, **Overview**. Use the IPv4 address shown there
everywhere this guide says `203.0.113.10`.

**Firewall:** Hostinger has its own firewall for the VPS, under **Security**, **Firewall** on the VPS page.
Step 2 already sets up the server's own firewall, so you do not need Hostinger's. If you do turn it on, add
rules that accept TCP 22, TCP 80, TCP 443 and UDP 443, or nobody can reach the site.

**Signing in (Step 2):** from your computer, `ssh root@203.0.113.10` with the root password. Or press
**Browser terminal** on the VPS Overview page, which opens a terminal in the browser with no setup.

**The free domain:** after paying, hPanel shows **Claim domain**, on the home page or under **Domains**. Search
for the name you want (for example `yourbrand.in`), claim it, and fill in the contact details. It is ready
within a few minutes. If Hostinger emails you to confirm the domain's contact details, do it: domains whose
details are not confirmed get suspended.

**DNS records (Step 1):** hPanel, **Domains**, your domain, **DNS / Nameservers**. Under DNS records, add each
of the five records from Step 1: Type `A`, Name `app` (then `pos`, `kds`, `admin`, `api`), Points to your
server's IP, TTL left as it is, then **Add record**. Leave the records already there (`@`, `www`, `MX` and the
rest) alone. If you bought the domain somewhere else, add the records there instead.

**Hostinger's weekly backup:** the plan makes one automatically; you can see and restore them on the VPS page,
under **Backups**. Keep it as an extra copy. It does not replace Step 7: it is only weekly, and it stays at
Hostinger.

Then carry on with Step 1.

### Step 1. Add DNS records

**What this does:** DNS is the internet's address book. These records tell every browser that
`app.yourbrand.in`, `pos.yourbrand.in` and the other three names are on your server. Do this first: HTTPS
certificates (Step 5) can only be issued once the names point at the server, and new records can take a while
to reach everyone.

**Where:** at the company that manages your domain's DNS. That is almost always the company you bought the domain
from. Sign in there, find your domain, and open its DNS page:

| Where you bought the domain | Where the DNS page is | The name field is called | The address field is called |
|---|---|---|---|
| GoDaddy | My Products, then DNS next to the domain | Name | Value |
| Hostinger | Domains, Manage, then DNS / Nameservers | Name | Points to |
| Namecheap | Domain List, Manage, then Advanced DNS | Host | Value |
| Cloudflare | Your domain, then DNS, Records | Name | IPv4 address |
| AWS Route 53 | Hosted zones, your domain, then Create record | Record name | Value |

Menus change from time to time. If you cannot find the page, look for "DNS", "Manage DNS" or "DNS zone".

**Not sure which company manages your DNS?** Run this on your own computer (Windows:
`nslookup -type=NS yourbrand.in`). The answer names the company:

```bash
dig +short NS yourbrand.in
# ns1.dns-parking.com           means Hostinger
# ns41.domaincontrol.com        means GoDaddy
# dns1.registrar-servers.com    means Namecheap
# lara.ns.cloudflare.com        means Cloudflare
# ns-123.awsdns-45.com          means AWS Route 53
```

**What to add:** five records. For each one, press "Add record" (or "Add new record" or "Create record"), fill in
the form as in one row of this table, and save:

| Type | Name | Value (IP address) | TTL |
|---|---|---|---|
| A | `app` | `203.0.113.10` | Leave the default |
| A | `pos` | `203.0.113.10` | Leave the default |
| A | `kds` | `203.0.113.10` | Leave the default |
| A | `admin` | `203.0.113.10` | Leave the default |
| A | `api` | `203.0.113.10` | Leave the default |

That gives you these five addresses:

| Address | What it is | Who uses it |
|---|---|---|
| `https://app.yourbrand.in` | Back office, and sign-up for new restaurants | Restaurant owners and managers |
| `https://pos.yourbrand.in` | POS (billing screen) | Cashiers and waiters |
| `https://kds.yourbrand.in` | Kitchen display | The kitchen |
| `https://admin.yourbrand.in` | Platform admin | Only you |
| `https://api.yourbrand.in` | API: the apps, print bridges and the mobile app talk to it | No one opens it directly |

**Watch out:**

- In the name field, type only the first part (`app`), not `app.yourbrand.in`. Most providers add the domain
  themselves, so typing it in full can give `app.yourbrand.in.yourbrand.in`.
- If one of these names already has a record (type A or CNAME), change it to the server's IP or delete it.
  Each name must have only one record.
- On **Cloudflare**, set Proxy status to **DNS only** (grey cloud), not Proxied (orange cloud). This setup
  expects browsers to reach the server directly. Through Cloudflare's proxy, certificates can fail, and the
  admin limit in Step 8 sees Cloudflare's addresses instead of yours.
- Leave the other records alone, such as `@` and `www` (your website) and `MX` (your email).

**Check:** new records usually work within 5 to 30 minutes, sometimes a few hours. On your own computer, run
this for each of the five names (Windows: `nslookup app.yourbrand.in`), or use a website such as dnschecker.org:

```bash
dig +short app.yourbrand.in
# 203.0.113.10
```

You can do Steps 2 to 4 while you wait. Start Step 5 only when all five names show your server's IP.

### Step 2. Prepare the server

**What this does:** sets up the new server, once. It adds a user of your own (so you do not work as root), a
firewall, Docker (which runs the product), extra memory for the build, and automatic security updates.

**Where:** on the server. Connect from your own computer's terminal (Terminal on a Mac; PowerShell on Windows):

```bash
ssh root@203.0.113.10
```

The first time, it asks `Are you sure you want to continue connecting?`: type `yes`. Then give the root
password from your provider, unless it signs you in with an SSH key.

- **AWS:** the user is `ubuntu`, not `root`, and you sign in with the key file you downloaded, for example
  `ssh -i LightsailDefaultKey-ap-south-1.pem ubuntu@203.0.113.10`. Then run `sudo -i` to become root. If ssh
  says the key's permissions are too open, run `chmod 400` on the key file first. Lightsail also has a
  **Connect using SSH** button that opens a terminal in the browser.
- **Hostinger:** sign in as `root` with the root password you set in hPanel, or press **Browser terminal** on
  the VPS Overview page.
- **DigitalOcean and Hetzner** also have a **Console** button in the dashboard that opens a terminal in the browser.

Then paste these lines, as root:

```bash
# A user called "deploy" for everyday work. It asks for a password: choose one and note it down.
# It also asks for a full name, phone numbers and so on: press Enter to skip each one.
adduser deploy
usermod -aG sudo deploy

# Firewall: allow only SSH (to sign in) and the web (ports 80 and 443).
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# Docker, which runs every part of the product, and permission for "deploy" to use it.
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy

# 4 GB of swap (extra memory on disk). Without it, the first build can run out of memory.
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Git, to download the code, and automatic security updates.
apt-get update && apt-get install -y git unattended-upgrades

# Switch to the "deploy" user. Every step after this runs as "deploy".
su - deploy
```

**You should see:** the prompt changes to something like `deploy@yourserver:~$`, and `docker --version` prints
a version number.

### Step 3. Get the code

**What this does:** downloads the code to `/srv/pos` on the server, and makes the settings file from its template.

**Where:** on the server, as `deploy`.

```bash
sudo mkdir -p /srv/pos && sudo chown deploy:deploy /srv/pos    # asks for deploy's password
git clone https://gitlab.com/your-group/billing-software.git /srv/pos
cd /srv/pos/infra/prod
cp .env.example .env && chmod 600 .env                          # chmod 600: only "deploy" can read it
```

Use your repository's real address in place of the example. In GitLab, open the project, press **Code**, and
copy "Clone with HTTPS".

**If the repository is private,** the clone asks for a username and password. Give the server a read-only key
instead of your own password:

1. In GitLab, open the project, then Settings, Repository, **Deploy tokens**, and Add token.
2. Name it `pos-server`, tick `read_repository`, and create it. Copy the username and the token: the token is
   shown only once.
3. Clone with them in the address, for example:

```bash
git clone https://gitlab+deploy-token-123456:gldt-xxxxxxxxxxxxxxxx@gitlab.com/your-group/billing-software.git /srv/pos
```

**You should see:** `ls -a` lists `.env`, `docker-compose.yml`, `backup.sh`, `smoke.sh` and a few more files.

### Step 4. Fill in the settings

**What this does:** `.env` holds every production setting and secret. The product reads it when it starts.
It stays on the server and is never put in git.

**Where:** on the server, in `/srv/pos/infra/prod`.

First, these commands create strong random passwords and write them into `.env` for you:

```bash
# The database password
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
# The secret key that signs every sign-in
sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$(openssl rand -hex 48)|" .env
# Your password for the platform admin
sed -i "s|^PLATFORM_ADMIN_PASSWORD=.*|PLATFORM_ADMIN_PASSWORD=$(openssl rand -base64 18)|" .env
# Shows your admin password: save it in your password manager
grep PLATFORM_ADMIN_PASSWORD .env
```

Then open the file:

```bash
nano .env
```

Move around with the arrow keys and change these lines as in the example. To save, press **Ctrl+O** and then
**Enter**; to leave, press **Ctrl+X**.

```bash
APP_DOMAIN=app.yourbrand.in
POS_DOMAIN=pos.yourbrand.in
KDS_DOMAIN=kds.yourbrand.in
ADMIN_DOMAIN=admin.yourbrand.in
API_DOMAIN=api.yourbrand.in

ACME_EMAIL=you@yourbrand.in

SMTP_HOST=email-smtp.ap-south-1.amazonaws.com
SMTP_PORT=587
SMTP_USER=AKIAXXXXXXXXXXXXXXXX
SMTP_PASSWORD=your-smtp-password
SMTP_FROM="Rasoi POS <no-reply@yourbrand.in>"

PLATFORM_ADMIN_EMAIL=you@yourbrand.in
```

What each setting is:

| Setting | What it is | Example |
|---|---|---|
| `APP_DOMAIN`, `POS_DOMAIN`, `KDS_DOMAIN`, `ADMIN_DOMAIN`, `API_DOMAIN` | The five addresses from Step 1, written without `https://` | `app.yourbrand.in` |
| `ACME_EMAIL` | Your email. The free certificate service (Let's Encrypt) writes to it if an HTTPS certificate cannot be renewed | `you@yourbrand.in` |
| `SMTP_HOST`, `SMTP_PORT` | Your email service's server and port, from "Before you start" | `smtp-relay.brevo.com`, `587` |
| `SMTP_USER`, `SMTP_PASSWORD` | The SMTP username and password (or key) from your email service, not your own email password | |
| `SMTP_FROM` | The sender people see on emails. It must be an address on the domain you set up with the email service | `"Rasoi POS <no-reply@yourbrand.in>"` |
| `PLATFORM_ADMIN_EMAIL` | Your sign-in to the platform admin | `you@yourbrand.in` |
| `APP_NAME` (optional) | The product name people see | `"Rasoi POS"` |
| `SUPPORT_EMAIL` (optional) | Shown to restaurants on their trial and renewal notices | `support@yourbrand.in` |
| `SIGNUP_ENABLED` | `true` lets restaurants register themselves; `false` means only you add them | `true` |
| `TRIAL_DAYS` | Length of the free trial, in days | `14` |

Leave the other lines as they are. Put a value in quotes if it contains a space.

Do not change `POSTGRES_PASSWORD` after Step 5. The database keeps the first one, and the API would no longer
be able to connect.

**Keep a copy of `.env` somewhere other than the server**, for example as a secure note in your password manager.
If the server is lost, a backup can only be restored with the same `POSTGRES_PASSWORD` and `JWT_ACCESS_SECRET`.
Run `cat .env`, then select and copy the text. Never put this file in git.

### Step 5. Build and start

**What this does:**

- `docker compose build` makes the product from the code. Only the first build is slow: 10 to 30 minutes.
- `docker compose up -d` starts everything in the background: the database, Redis, the API, the four apps, and
  Caddy, which handles HTTPS. New database changes are applied first, automatically.
- `docker compose run --rm platform-admin` creates your platform admin sign-in from `PLATFORM_ADMIN_EMAIL` and
  `PLATFORM_ADMIN_PASSWORD`.
- `docker compose ps` lists what is running.

**Where:** on the server, in `/srv/pos/infra/prod`. Only start when all five DNS names point at the server (Step 1).

```bash
docker compose build
docker compose up -d
docker compose run --rm platform-admin
docker compose ps
```

**You should see:** `api`, `web`, `pos`, `kds`, `admin`, `postgres`, `redis` and `caddy`, each with a status
starting `Up`. After about a minute, `api`, `postgres` and `redis` also show `(healthy)`. Caddy gets each
address's HTTPS certificate automatically the first time that address is opened, which takes a few seconds.

### Step 6. Check it works

**What this does:** checks the installation from outside, the way a browser would. It checks that the API is
healthy, each app answers over HTTPS, live updates connect, and your admin sign-in works. It changes nothing.

```bash
./smoke.sh
```

**You should see:** lines starting with `ok`, and `All checks passed.` at the end. A line starting with `FAIL`
says what is wrong; see "If something is wrong" below.

Then open `https://admin.yourbrand.in` in your browser and sign in with `you@yourbrand.in` and the password
from Step 4.

### Step 7. Turn on backups

**What this does:** a backup is a copy of the database (every restaurant, menu and bill) and the uploaded photos.
Without one, a failed disk loses everything.

**Where:** on the server, in `/srv/pos/infra/prod`. First make one backup by hand:

```bash
./backup.sh
ls backups/            # shows a folder such as 2026-11-28_141500
```

Then make one every night automatically. Servers usually run on UTC time, so the first two lines set Indian time;
otherwise 2:15 on the server would be 7:45 in the morning in India.

```bash
sudo timedatectl set-timezone Asia/Kolkata
sudo systemctl restart cron
sudo touch /var/log/pos-backup.log && sudo chown deploy /var/log/pos-backup.log
( crontab -l 2>/dev/null; echo "15 2 * * * /srv/pos/infra/prod/backup.sh >> /var/log/pos-backup.log 2>&1" ) | crontab -
crontab -l             # shows the line just added
```

`15 2 * * *` means 2:15 every night. Backups older than 14 days are deleted. Check now and then that they work
with `tail /var/log/pos-backup.log`.

**Copy the backups off the server (strongly recommended).** A backup kept only on the server is lost with the server.

1. Install the copying tool: `sudo apt-get install -y rclone`.
2. Run `rclone config` and answer its questions to connect a storage account: Backblaze B2, Amazon S3, Google
   Drive and many others work. Give the connection a short name, for example `b2`.
3. In `.env`, set where to copy to, for example `BACKUP_REMOTE="b2:my-bucket/pos"`.

From then on, every backup is also copied there.

### Step 8. Limit the platform admin to your office

**What this does:** the platform admin can see and change every restaurant, and it has no two-step sign-in yet.
This step lets it open only from your office's internet connection. Everyone else gets "Not found".

**Where:** first find your office's public IP address. On an office computer, open `https://ifconfig.me` in a
browser. Then, on the server, run `nano .env` and set:

```bash
ADMIN_ALLOWED_IPS="198.51.100.7"
```

To allow more than one address, put them all inside the quotes, separated by spaces. Then restart Caddy so it
reads the change:

```bash
docker compose up -d caddy
```

Office and home internet connections often get a new address from time to time. If the admin suddenly says
"Not found", check `https://ifconfig.me` again and update `.env`.

### Step 9. Open the first restaurant

**What this does:** tries the whole product with one real restaurant before customers depend on it.

1. Open `https://admin.yourbrand.in` and press **Add restaurant**. Alternatively, the owner can register at
   `https://app.yourbrand.in/signup`.
2. The owner gets an email with a link. They open it, sign in at `https://app.yourbrand.in`, and set up the menu,
   tables and printers. If no email arrives, see "If something is wrong" below.
3. On each billing device (computer or tablet), open `https://pos.yourbrand.in` once while online, and sign in.
   This registers the device and keeps a copy of the POS on it, so it can bill when the internet is down. The
   device's clock must be correct, to within 5 minutes.
4. Bill one order and print it.
5. Test billing without the internet: turn the device's Wi-Fi off, bill a takeaway order, then turn the Wi-Fi
   back on. The "N to upload" badge in the POS header goes away once the bill has reached the server.

**Thermal printers:** on the counter computer, put these lines in `.env`, then start the bridge as described in
"Thermal printing" below:

```bash
PRINT_BRIDGE_API_URL=https://api.yourbrand.in
PRINT_BRIDGE_TOKEN=<the token shown in the back office under Settings, Printers>
```

**Mobile app:** build it with `EXPO_PUBLIC_API_URL=https://api.yourbrand.in` (see the mobile project's README).

**Before the public signs up:** put your terms of service and privacy policy in place. They are not in the
product.

**Never run these on the server:** `pnpm db:seed` adds a demo restaurant, and `docker compose down -v`
deletes the database.

### Releasing an update

**What this does:** takes a backup, downloads the new code, rebuilds, and restarts. Database changes are
applied automatically.

**When:** outside meal times. The apps pause for about a minute. POS screens that are already open keep billing
takeaway and delivery orders offline during the pause.

**Where:** on the server, as `deploy`.

```bash
cd /srv/pos
git log --oneline -1                       # note this commit, e.g. a55736a, in case you need to go back
./infra/prod/backup.sh
git pull
cd infra/prod
docker compose build
docker compose up -d                       # applies database changes, then restarts
./smoke.sh                                 # should end with "All checks passed."
```

**To go back** to the commit you noted:

```bash
cd /srv/pos
git checkout a55736a
cd infra/prod && docker compose build && docker compose up -d
```

If the update had already changed the database, also restore the backup taken just before the update:
`./restore.sh backups/2026-11-28_141500`.

### If something is wrong

Run these in `/srv/pos/infra/prod`.

| What you see | What to do |
|---|---|
| A page does not load | `docker compose ps` shows which service is not running; `docker compose logs --tail 100 api` shows why |
| "Your connection is not private" | The DNS record does not point at the server yet (check with `dig +short pos.yourbrand.in`), or ports 80 and 443 are closed in the provider's firewall. `docker compose logs caddy` says which |
| The page times out and never loads | Ports 80 and 443 are closed. On AWS, open them in AWS's firewall too ("Before you start") |
| `permission denied` on `docker.sock` | The `deploy` user is not in the docker group yet: run `exit`, then `su - deploy`, and try again |
| Nobody can sign in | All five addresses must be under the same domain, written in `.env` without `https://` |
| No emails arrive | `docker compose logs api \| grep -i mail` shows the error from your email service |
| `api` keeps restarting | `docker compose logs api`: the first lines name the setting that is missing or wrong |

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
- In production these pages are `https://app.yourbrand.in/signup` and `https://admin.yourbrand.in`. Email
  goes out through your SMTP provider, and the platform admin's sign-in is created by
  `docker compose run --rm platform-admin`, not by the seed.

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
packages/printing   Thermal layouts for bills and kitchen tickets, shared by API and POS
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
