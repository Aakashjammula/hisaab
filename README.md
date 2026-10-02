# Hisaab

Hisaab (हिसाब, "keeping count") is a personal spending tracker. Log every payment, record only **your share** of split bills, and see where the money goes.

- **Cloudflare Workers** serves the static UI and a small JSON API (free plan)
- **D1** (SQLite) stores the data. Tables are `STRICT` and money is integer paise
- **Cloudflare Access** protects everything with an email one-time PIN, and the Worker verifies the Access JWT again
- **UI**: plain HTML + vanilla JS + [Oat](https://oat.ink) + [Charts.css](https://chartscss.org) + Lucide icons, all self-hosted. It's an installable PWA

## Local development

```sh
npm install
npm run db:migrate:local
npm run dev            # http://localhost:8787 (auth is skipped for localhost via .dev.vars)
npm test
```

If `.dev.vars` is missing, create it with `DEV_BYPASS_AUTH=true`. It is git-ignored and never deployed.

## One-time Cloudflare setup

1. **Log in**: `npx wrangler login`
2. **Create the database**: `npx wrangler d1 create hisaab`, then copy the `database_id` into `wrangler.jsonc`.
3. **Pick a subdomain** on your Cloudflare domain and set it in `wrangler.jsonc` → `routes[0].pattern` (e.g. `hisaab.example.com`).
4. **Create the tables**: `npm run db:migrate:remote`
5. **Protect it with Access** (Cloudflare dashboard → Zero Trust):
   - Settings → Authentication → make sure **One-time PIN** is enabled.
   - Access → Applications → **Add application → Self-hosted**. Domain = your subdomain.
     Session duration = **1 month**. Policy: **Allow**, include **Emails** = your email.
   - Copy the **Application Audience (AUD) Tag** into `POLICY_AUD` in `wrangler.jsonc`.
   - Set `TEAM_DOMAIN` to `https://<your-team>.cloudflareaccess.com` (shown under Settings → Custom pages / team domain).
6. **Set who may use the API** (kept as a secret, not in git): `npx wrangler secret put ALLOWED_EMAIL` and enter your email.
   For more than one person, separate emails with commas.
7. **Deploy**: `npm run deploy`
8. Open your subdomain, enter the PIN from your email, then use **Add to Home Screen** to install it.

`workers_dev` and `preview_urls` are off on purpose: those URLs are **not** covered by Access.
If Access isn't configured, the API refuses every request (it fails closed).

## Project layout

```
src/            Worker: routing, Access JWT check, validation, SQL
migrations/     D1 schema
public/         Static app (served as-is, no build step)
  js/money.js   Rupee ↔ paise parsing, shared by browser and Worker
  js/icon-list.js  Curated category icons + colours (Worker only accepts these)
scripts/vendor.mjs  Copies Oat / Charts.css / font and builds icons.svg. Run `npm run vendor` after changing the icon list.
test/           Vitest in the Workers runtime against a real local D1
```
