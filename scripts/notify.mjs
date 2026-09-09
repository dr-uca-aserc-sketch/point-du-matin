// Sends the morning notification: the link plus the one thing worth knowing.
// On a failed run it sends the reason instead, so silence never means "fine".
//
// Two channels, both optional — whichever secrets are set gets used, so you can
// run Telegram today and add WhatsApp later without touching this file:
//
//   Telegram  TELEGRAM_TOKEN + TELEGRAM_CHAT_ID   (free, no queue — see README)
//   WhatsApp  WHATSAPP_PHONE + WHATSAPP_APIKEY    (CallMeBot; often at capacity)
//
// No secrets at all → exits quietly; the edition is still published.

import { readFile } from "node:fs/promises";

const site = (process.env.SITE_URL || "").replace(/\/$/, "");
const TZ = "Europe/Luxembourg";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

const read = async f => {
  try {
    return (await readFile(f, "utf8")).trim();
  } catch {
    return "";
  }
};

const ok = await read("notify.txt");
const failure = await read("failure.txt");

let text;
if (ok) {
  const link = site ? `${site}/#${today}` : "";
  text = [`Le Point du Matin — ${today}`, ok, link].filter(Boolean).join("\n\n");
} else if (failure) {
  text = [
    `Le Point du Matin — ${today}`,
    "Pas d'édition ce matin.",
    failure,
    site ? `Dernière édition : ${site}` : ""
  ].filter(Boolean).join("\n\n");
} else {
  console.log("Neither notify.txt nor failure.txt — nothing to send.");
  process.exit(0);
}

async function telegramChatId(token) {
  const explicit = process.env.TELEGRAM_CHAT_ID;
  if (explicit) return explicit;
  // Not set: discover it from the most recent message sent TO the bot.
  // Works because a bot cannot message you until you have written to it once.
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const data = await res.json();
    const updates = (data && data.result) || [];
    for (let i = updates.length - 1; i >= 0; i--) {
      const chat = updates[i].message && updates[i].message.chat;
      if (chat && chat.id) {
        console.log(`Discovered TELEGRAM_CHAT_ID=${chat.id} — add it as a secret to make this permanent.`);
        return String(chat.id);
      }
    }
    console.log("Telegram: no chat id found. Send your bot a message ('hi'), then re-run.");
  } catch (e) {
    console.log("Telegram: could not reach getUpdates —", String(e.message || e));
  }
  return null;
}

async function sendTelegram() {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return null;
  const chat = await telegramChatId(token);
  if (!chat) return "Telegram skipped: no chat id.";
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      disable_web_page_preview: false
    })
  });
  const body = (await res.text()).slice(0, 300);
  return res.ok ? "Telegram sent." : `Telegram failed (${res.status}): ${body}`;
}

async function sendWhatsApp() {
  const phone = process.env.WHATSAPP_PHONE;
  const apikey = process.env.WHATSAPP_APIKEY;
  if (!phone || !apikey) return null;
  const url =
    "https://api.callmebot.com/whatsapp.php?phone=" +
    encodeURIComponent(phone) +
    "&apikey=" +
    encodeURIComponent(apikey) +
    "&text=" +
    encodeURIComponent(text);
  const res = await fetch(url);
  const body = (await res.text()).slice(0, 300);
  return res.ok ? "WhatsApp sent." : `WhatsApp failed (${res.status}): ${body}`;
}

const results = (await Promise.all([sendTelegram(), sendWhatsApp()])).filter(Boolean);

if (!results.length) {
  console.log("No notification secrets set — skipping. Add TELEGRAM_TOKEN + TELEGRAM_CHAT_ID, or WHATSAPP_PHONE + WHATSAPP_APIKEY.");
} else {
  results.forEach(r => console.log(r));
}
