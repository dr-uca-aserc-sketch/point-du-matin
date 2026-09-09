# Le Point du Matin — setup

A daily multilingual press review. Every morning at **06:30 Luxembourg time** a
scheduled job reads ~29 feeds from your sources, has Claude write the edition,
publishes it as a web page, and sends you a Telegram or WhatsApp message with
the link and the one thing worth knowing.

Sundays it writes a longer **review of the week** instead: the week's running
threads and where each now stands, about 30 minutes.

Everything below is free except the Anthropic API usage — roughly €0.15–0.40 per
edition, so about €5–12 a month.

---

## What goes in the repo

Copy these into a **new GitHub repository**, keeping the structure:

```
index.html                      ← the briefing page
scripts/feeds.mjs
scripts/compose.mjs
scripts/notify.mjs
.github/workflows/briefing.yml
```

`index.html` is the name GitHub Pages serves by default. The page looks for
`editions/index.json` beside itself; the job creates that on its first run.

---

## Step 1 - Model key (pick one)

**Free: Google Gemini.** No credit card.
1. [aistudio.google.com](https://aistudio.google.com) -> sign in with a Google
   account -> **Get API key** -> **Create API key**. Copy it.
2. That is your `GEMINI_API_KEY`.

The free tier covers the Flash models at 10-15 requests per minute; this job
makes three calls a day, so you will not come near the ceiling. Two caveats:
Google may use free-tier inputs and outputs to improve their models (harmless
here - it is all public news feeds), and Google revises free-tier limits without
notice.

**Paid: Anthropic.** Better writing, roughly EUR 0.15-0.40 an edition.
1. [console.anthropic.com](https://console.anthropic.com) -> sign in -> add
   credit (EUR 10 lasts a couple of months).
2. **API keys -> Create key**. Copy it - shown once.
3. That is your `ANTHROPIC_API_KEY`.

Set whichever one you have; the job detects it and says which it used in the run
log. Set both and Anthropic wins.

## Step 2 — Where the message goes

Pick either. The notifier uses whichever secrets exist, so you can start with
Telegram and add WhatsApp later without changing any code.

### Telegram (recommended - free, instant, no queue)

1. In Telegram, message **@BotFather** -> `/newbot` -> give it any name and a
   username ending in `bot`. It replies with a **token** like
   `8123456789:AAH...`. Keep it.
2. Send your new bot any message (`hi`). A bot cannot write to you first, so
   this step is required.

That's it - `TELEGRAM_TOKEN` alone is enough. The script finds your chat id from
that first message and prints it in the run log; add it as `TELEGRAM_CHAT_ID`
later if you want to pin it (recommended once it works, since Telegram drops
old updates after 24h).

**If you would rather set it by hand:** message **@userinfobot** on Telegram -
it replies with your ID straight away, and for a private chat your user ID is
the chat id.

### WhatsApp (CallMeBot)

Often at capacity — their page masks the number when the bot is full and says
to check back in a few days. When a slot is open:

1. Save the number shown on
   [callmebot.com/blog/free-api-whatsapp-messages](https://www.callmebot.com/blog/free-api-whatsapp-messages/)
   as a contact.
2. Send it exactly: `I allow callmebot to send me messages`
3. It replies with your personal **API key**.

## Step 3 — Repository secrets

**Settings → Secrets and variables → Actions → New repository secret.**

The model key, plus the pair for whichever channel you set up:

| Name | Value |
|---|---|
| `GEMINI_API_KEY` | *(free route)* the key from step 1 |
| `ANTHROPIC_API_KEY` | *(paid route)* the key from step 1 |
| `TELEGRAM_TOKEN` | the BotFather token |
| `TELEGRAM_CHAT_ID` | optional - discovered automatically on the first run |
| `WHATSAPP_PHONE` | *(WhatsApp route)* full international, e.g. `+352691123456` |
| `WHATSAPP_APIKEY` | *(WhatsApp route)* the key CallMeBot sent you |

Set both channels and you get both messages.

## Step 4 — Turn on Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**
Don't pick a branch — the workflow deploys itself.

**If Pages is behind a paywall:** that is because the repo is private — Pages on
private repos needs a paid plan. Make the repo public instead:
**Settings → General → Danger Zone → Change visibility → Change to public.**

Your keys are unaffected: repository secrets are never readable, on public repos
too. What does become public is the repo's contents (the page and the editions
archive, all written from public news sources) and the Actions run logs.

## Step 5 — First run

**Actions → Le Point du Matin → Run workflow.** Two to four minutes.

When it finishes you get a message with your URL, something like
`https://<username>.github.io/<repo>/`. Open it on your phone and **Add to Home
Screen** — it then behaves like an app and works offline on editions you've
already opened.

After that it runs itself at 06:30 every morning.

---

## How it behaves

- **Idempotent.** If today's edition already exists it exits without spending
  tokens, so a manual re-run is always safe.
- **Two cron lines** (04:30 and 05:30 UTC) so 06:30 local holds across the
  summer/winter change; the second run does nothing.
- **Failures tell you.** If the composition fails you still get a message
  saying so and why — silence never means "all fine".
- **Thin mornings abort.** Under 40 feed items it refuses to publish rather than
  send you a hollow edition; the message says so.
- **Feeds that fail are skipped**, and the edition footnotes how many were read.
- **Every story links to its own dépêche.**
- **The archive** is one JSON per day in the repo, and the calendar in the page
  reads it. Nothing is ever overwritten.

## Reading it

- **Ring, bottom right** — reading progress; tap for the sommaire and time left.
- **Papier / sombre** in the header — switches ground, and remembers.
- **Resume** — reopening an edition returns you to where you stopped.
- **Archives** — heat-tinted calendar plus search across every edition.

## Cost and knobs

- **Model**: set `BRIEFING_MODEL` in the workflow to override the default
  (`claude-sonnet-4-5` on Anthropic, `gemini-2.5-flash` on Gemini).
- **Length**: word budgets in `scripts/compose.mjs` — search `80-100 words` and
  `90-120 words`.
- **Desks**: also `compose.mjs`. Current order is Luxembourg, Monde,
  International hors Europe, Europe & UE, Économie, Technologie & sciences,
  Sport last and short.
- **Sources**: `scripts/feeds.mjs`, the `FEEDS` array. Reuters, AFP, AP, WSJ,
  Bloomberg and Foreign Affairs publish no usable public feed, so those are read
  through Google News' per-site feed — headlines and standfirsts, which is what
  a briefing needs. Paywalled outlets are kept and labelled `payant`.

## If something breaks

**Actions** → the failed run → open the log:

- `Anthropic 401` / `Gemini 400` - key wrong, or out of credit on Anthropic.
- `Gemini 429` repeatedly - free-tier rate limit; the script already backs off
  four times, so this usually means the daily quota is spent. Re-run tomorrow.
- `only N items collected` — bad network morning; re-run the workflow.
- Page updated but no message — the log line for the Notification step names the
  channel and the reason. Telegram `400 chat not found` means step 2.2 was
  skipped: send your bot a message first.
