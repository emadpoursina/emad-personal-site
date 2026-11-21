# Deployment runbook

Publishes the site on a single Ubuntu VPS with Docker Compose. Caddy terminates TLS
(Let's Encrypt), the Astro server runs behind it on a private network, and SQLite lives on
the named Docker volume `app-data`.

- **Estimated time:** 20–30 minutes, most of it DNS propagation.
- **Server cost:** any 1 GB RAM / 1 vCPU box is enough (Hetzner CX22, DigitalOcean Basic,
  Vultr Regular, or similar).
- **Prerequisites:** a domain, SSH access to the VPS, and — for live contact email — a
  Gmail app password (see [Contact email](#contact-email)).

## 1. DNS

Point both names at the VPS IPv4 address. Use `A` records, and `AAAA` only if the server
has working IPv6 (a wrong `AAAA` record breaks certificate issuance).

| Type | Name | Value |
| ---- | ---- | ----- |
| A | `@` (apex) | your VPS IPv4 |
| A | `www` | your VPS IPv4 |

Keep TTL low (300s) until the first successful deploy. Verify before continuing:

```sh
dig +short example.com
dig +short www.example.com
```

Both must print the VPS IP. Certificate issuance fails while they do not.

## 2. Server baseline

Log in as root once and create a non-root deploy user:

```sh
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# paste your public key (~/.ssh/id_ed25519.pub on your laptop):
echo 'ssh-ed25519 AAAA... you@laptop' > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

Confirm `ssh deploy@<vps-ip>` works in a second terminal **before** hardening SSH.

```sh
# key-only SSH
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
# Ubuntu 24.04 also ships a drop-in that can re-enable passwords:
sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config.d/*.conf 2>/dev/null || true
systemctl reload ssh

# firewall: SSH, HTTP, HTTPS only
apt-get update && apt-get install -y ufw fail2ban unattended-upgrades
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# automatic security updates
dpkg-reconfigure -plow unattended-upgrades
```

Port 8080 is deliberately never opened: the app has no published port in
`compose.prod.yaml` and is reachable only through Caddy.

## 3. Docker

```sh
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
```

Log out and back in so the `docker` group applies, then check `docker run --rm hello-world`.

## 4. Application

```sh
sudo mkdir -p /srv && sudo chown deploy:deploy /srv
git clone https://github.com/emadpoursina/emad-personal-site.git /srv/emad-personal-site
cd /srv/emad-personal-site

cp .env.example .env
chmod 600 .env
```

Edit `.env` and set at minimum:

```ini
SITE_DOMAIN=example.com
SITE_URL=https://example.com
```

`SITE_DOMAIN` is the apex hostname Caddy serves and gets a certificate for. Compose also
derives the build-time `SITE_URL` from it, which fixes the absolute URLs in the prerendered
`sitemap.xml` and `llms.txt` and marks the production host as trusted for forwarded headers.
Keep the explicit `SITE_URL` line anyway: it documents the public origin the app is built for.

Add SMTP settings for live contact email (see below). Leave `ADMIN_PASSWORD_HASH`,
`ENCRYPTION_KEY`, `AI_*` and `GENERATOR_*` empty for a first publish: those features
self-disable with a warning instead of exposing unauthenticated endpoints.

Build and start:

```sh
docker compose -f compose.prod.yaml up -d --build
docker compose -f compose.prod.yaml ps
```

The image build runs the same gates as `npm run build` (content validation, CV
generation, contrast, static-output checks), so a content error fails the deploy rather
than publishing a broken page.

## 5. Verify

```sh
curl -fsS https://example.com/healthz        # {"status":"ok",...}
curl -fsSI https://example.com/ | head -n1   # HTTP/2 200
curl -fsS https://example.com/sitemap.xml | grep '<loc>'   # your domain, not localhost
curl -fsSI http://example.com/ | head -n1    # 308 → https
```

Then in a browser:

- every page loads over HTTPS with a valid certificate;
- `http://www.example.com` redirects to `https://example.com`;
- the contact form submits and the success message appears (with SMTP configured);
- `/admin` stays inert and `/ask` reports the assistant as unavailable.

## Contact email

The form uses nodemailer over SMTP. For Gmail you need an **app password** (Google
Account → Security → 2-Step Verification → App passwords), not the account password:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your.address@gmail.com
SMTP_PASS=the-16-character-app-password
SMTP_FROM=Emad Poursina <your.address@gmail.com>
CONTACT_TO=your.address@gmail.com
```

Send one real message after deploying and confirm it arrives; Gmail silently drops
messages when the app password is revoked. With SMTP unset the endpoint returns its
documented 503 and the page shows the direct email address instead.

## Operations

**Update after a push:**

```sh
cd /srv/emad-personal-site
git pull --ff-only
docker compose -f compose.prod.yaml up -d --build
```

**Logs:** `docker compose -f compose.prod.yaml logs -f --tail=100`

**Back up the database** (messages are the only irreplaceable data). Run from cron daily:

```sh
docker run --rm -v emad-personal-site-prod_app-data:/data:ro -v /srv/backups:/backup \
  alpine tar czf /backup/site-$(date +%F).tar.gz -C /data .
```

Keep copies off the server. A volume backup restores with the same command run in reverse.

**Rollback:** `git checkout <previous-commit> && docker compose -f compose.prod.yaml up -d --build`
(the database volume is untouched). Then return to `master`.

**Renewals:** certificates renew automatically; `caddy-data` must persist, so never
`docker compose down -v` on production — `-v` deletes the SQLite volume too.
