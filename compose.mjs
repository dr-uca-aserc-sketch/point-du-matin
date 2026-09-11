// Composes one edition of Le Point du Matin from this morning's feeds and
// writes editions/<date>.json + editions/index.json.
// Sunday runs a review of the week instead of a normal edition.
// Idempotent: if today's edition already exists, it exits 0 without spending tokens.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { collect, digest } from "./feeds.mjs";

const API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.BRIEFING_MODEL || (API_KEY ? "claude-sonnet-4-5" : "gemini-3.6-flash");
const TZ = "Europe/Luxembourg";
const OUT = "editions";

if (!API_KEY && !GEMINI_KEY) {
  console.error("Set either ANTHROPIC_API_KEY or GEMINI_API_KEY as a repository secret.");
  process.exit(1);
}
console.log(`Writing with ${API_KEY ? "Anthropic" : "Gemini"} (${MODEL}).`);

const now = new Date();
const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now);
const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long" }).format(now);
const isSunday = weekday === "Sunday";

const EU_SOURCES =
  "Reuters (EN/DE/FR/IT), AFP, AP, Euronews, DW, Le Monde, France 24, Süddeutsche Zeitung, FAZ, BBC News, Financial Times, Corriere della Sera, la Repubblica, RTL.lu, Luxemburger Wort";
const INTL_SOURCES =
  "Al Jazeera English (world and Middle East), AP world hub, Reuters, AFP, BBC World, DW English, The New York Times, The Washington Post, The Wall Street Journal, NPR, PBS News, Bloomberg, The Economist, Foreign Affairs, Council on Foreign Relations";

const SYSTEM =
  "You are the desk editor of a personal multilingual morning press review for a reader in Luxembourg who reads English, French, German, Italian and Luxembourgish. " +
  "You work ONLY from the feed items given to you: never add an event, figure, name or date that is not in them. " +
  "You answer with raw JSON and nothing else.";

const RULES = `Rules:
- Work only from the feed items supplied below. If the feeds do not support a story, leave it out.
- Each summary is written in the language of its source. Every headline also gets an English translation in "headlineEn" (if the source is English, put the French translation there instead).
- Where sources notably disagree on the same event, merge them into one entry and describe the disagreement in French in "contested". Otherwise "contested" is "".
- One "why it matters" line per story, in French, in "why".
- "paywalled": true for items marked (paywalled) in the digest. Prefer freely accessible sources when both cover the same story.
- "url" is the item's own link, copied verbatim from the digest.
- "chart" is a data graphic, ONLY when the feed items actually carry the figures: {"kind":"bars"|"line","title":"French title with the unit","note":"1-2 French sentences on what the series covers and what it excludes","points":[{"label":"","value":0}]} with 5-8 points. Never invent or extrapolate a series — use null when in doubt.
Return ONLY valid JSON, no markdown fence.`;

const DESK_SHAPE =
  'Shape: {"desks":[{"name":"","stories":[{"source":"","lang":"","url":"","headline":"","headlineEn":"","summary":"","why":"","paywalled":false,"contested":"","chart":null}]}]}';

const LUX_BRIEF =
  '"Luxembourg" (3 stories from RTL.lu and Luxemburger Wort — government and Chamber politics and housing come first; cross-border work, tax and commuting, the finance centre and fund industry, transport and roadworks, the communes and the EU institutions based here only if there is room)';

async function alreadyDone() {
  try {
    await readFile(`${OUT}/${today}.json`, "utf8");
    return true;
  } catch {
    return false;
  }
}

// Closes a JSON object that was cut off mid-write (the model hit its token
// ceiling): drop the trailing partial value, then shut the open brackets.
function repairJson(src) {
  let s = src.replace(/,\s*$/, "");
  const stack = [];
  let inStr = false, esc = false, lastSafe = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
    if ((c === "}" || c === "]") && stack.length) lastSafe = i;
  }
  if (inStr || lastSafe < 0) return null;
  s = s.slice(0, lastSafe + 1);
  const open = [];
  inStr = false; esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") open.push(c);
    else if (c === "}" || c === "]") open.pop();
  }
  while (open.length) s += open.pop() === "{" ? "}" : "]";
  try { return JSON.parse(s); } catch { return null; }
}

// Every model call retries: transient 5xx, an empty reply, or JSON that came
// back malformed. A truncated-but-usable reply is repaired rather than retried.
async function ask(prompt, maxTokens = 16000, label = "call") {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      const wait = attempt * 20000;
      console.log(`Retrying ${label} in ${wait / 1000}s (${last}).`);
      await new Promise(r => setTimeout(r, wait));
    }
    try {
      const text = API_KEY
        ? await askAnthropic(prompt, maxTokens)
        : await askGemini(prompt, maxTokens);
      const a = text.indexOf("{"), b = text.lastIndexOf("}");
      if (a < 0) throw new Error("model returned no JSON at all");
      const slice = b > a ? text.slice(a, b + 1) : text.slice(a);
      try {
        return JSON.parse(slice);
      } catch (parseErr) {
        const repaired = repairJson(slice);
        if (repaired) {
          console.log(`${label}: reply was truncated — recovered the complete part.`);
          return repaired;
        }
        throw new Error("malformed JSON in reply");
      }
    } catch (e) {
      last = String(e && e.message ? e.message : e).slice(0, 160);
      // A bad key or a wrong model name will never succeed — fail immediately.
      if (/\b40[0134]\b/.test(last) && !/429/.test(last)) throw e;
    }
  }
  throw new Error(`${label} failed after 3 attempts — ${last}`);
}

async function askAnthropic(prompt, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  return (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
}

// Gemini's free tier is rate-limited per minute, so retry on 429 with backoff.
async function askGemini(prompt, maxTokens, attempt = 0) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7, responseMimeType: "application/json" }
    })
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const wait = Math.pow(2, attempt) * 15000;
    console.log(`Gemini ${res.status} — waiting ${wait / 1000}s.`);
    await new Promise(r => setTimeout(r, wait));
    return askGemini(prompt, maxTokens, attempt + 1);
  }
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const cand = (data.candidates || [])[0];
  if (!cand) throw new Error("Gemini returned no candidate (prompt may have been blocked)");
  if (cand.finishReason && cand.finishReason !== "STOP") console.log(`Gemini finishReason: ${cand.finishReason}`);
  return ((cand.content && cand.content.parts) || []).map(p => p.text || "").join("");
}

// Last six editions, trimmed to headlines + why lines: the raw material for
// the Sunday review of the week.
async function weekContext() {
  let files = [];
  try {
    files = (await readdir(OUT)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 6);
  } catch {
    return "";
  }
  const days = [];
  for (const file of files.reverse()) {
    try {
      const e = JSON.parse(await readFile(`${OUT}/${file}`, "utf8"));
      const lines = [
        ...(e.mustReads || []).map(m => `- [à la une] ${m.headline} (${m.source}) — ${m.why}`),
        ...(e.desks || []).flatMap(d => (d.stories || []).map(s => `- [${d.name}] ${s.headline} (${s.source}) — ${s.why}`))
      ];
      days.push(`## ${e.date}\n${lines.join("\n")}`);
    } catch {}
  }
  return days.join("\n\n");
}

// A desk batch that fails should cost you those desks, not the whole edition.
async function askDesks(prompt, label, maxTokens = 16000) {
  try {
    const out = await ask(prompt, maxTokens, label);
    return out.desks || [];
  } catch (e) {
    console.log(`Desk batch "${label}" failed — publishing without it. ${e.message}`);
    return [];
  }
}

async function composeDaily(euDigest, intlDigest) {
  const head = await ask(
    `Compose the front of the morning press review for ${today}.\n${RULES}\n` +
      `Shape: {"heat":0-1,"followUps":[{"n":"01","thread":"","change":""}],"mustReads":[{"desk":"","source":"","lang":"EN|FR|DE|IT|LB","paywalled":false,"url":"","headline":"","headlineEn":"","contested":"","why":"","stat":"","statLabel":"","chart":null,"paras":["","","","","",""]}],"oneThing":""}\n` +
      `"heat" is how heavy the news day is, 0-1. 3 followUps in French on what moved since yesterday. Exactly 3 mustReads — the three stories that most deserve a deep read — of 6 paragraphs each, every paragraph 80-100 words. "stat" is one short figure from the feeds (max 6 characters) and "statLabel" the French phrase it belongs to; leave both "" rather than inventing one.\n` +
      `"oneThing" is ONE sentence in ENGLISH, max 25 words: the one thing worth knowing if the reader reads nothing else today. Plain and concrete, no preamble.\n\n` +
      `# FEEDS — Europe, wires, Luxembourg\n${euDigest}\n\n# FEEDS — international\n${intlDigest}`,
    16000,
    "front page"
  );

  const used = (head.mustReads || []).map(m => "- " + m.headline).join("\n");

  const partA = await askDesks(
    `Continue the morning press review for ${today}.\n${RULES}\n${DESK_SHAPE}\n` +
      `Write exactly these desks, in order: ${LUX_BRIEF}, "Monde / géopolitique" (3 stories), "International — hors Europe" (5 stories on events outside Europe, leading with Al Jazeera where it is strongest and closing with an analytical piece from Foreign Affairs, The Economist or CFR if the feeds carry one).\n` +
      `Each summary 90-120 words, three to four sentences — never one. Give the first story of each desk a chart when the feeds carry a real series.\n` +
      `Do NOT repeat these stories, already covered as must-reads:\n${used}\n\n` +
      `# FEEDS — Europe, wires, Luxembourg\n${euDigest}\n\n# FEEDS — international\n${intlDigest}`,
    "desks A"
  );

  const partB = await askDesks(
    `Continue the morning press review for ${today}.\n${RULES}\n${DESK_SHAPE}\n` +
      `Write exactly these desks, in order: "Europe & politiques de l'UE" (3 stories), "Économie & marchés" (3 stories), "Technologie & sciences" (3 stories covering technology, science and climate together), "Sport" (2 short stories of 60-80 words each).\n` +
      `Every other summary 90-120 words, three to four sentences. Give the first story of each desk a chart when the feeds carry a real series. If a desk has nothing in the feeds today, return it with an empty stories array rather than inventing content.\n` +
      `Do NOT repeat the must-reads:\n${used}\n\n` +
      `# FEEDS — Europe, wires, Luxembourg\n${euDigest}\n\n# FEEDS — international\n${intlDigest}`,
    "desks B"
  );

  return {
    head,
    desks: partA.concat(partB)
  };
}

async function composeSunday(euDigest, intlDigest) {
  const week = await weekContext();
  const preamble = week
    ? `# THIS WEEK'S OWN EDITIONS (the threads to pick up)\n${week}\n\n`
    : "";

  const head = await ask(
    `Compose the Sunday review of the week for ${today}. It replaces the normal edition and runs longer — about 30 minutes of reading.\n${RULES}\n` +
      `Shape: {"heat":0-1,"followUps":[{"n":"01","thread":"","change":""}],"mustReads":[{"desk":"","source":"","lang":"EN|FR|DE|IT|LB","paywalled":false,"url":"","headline":"","headlineEn":"","contested":"","why":"","stat":"","statLabel":"","chart":null,"paras":["","","","","","","",""]}],"oneThing":""}\n` +
      `This is a RECAP of the week's threads and where each stands now — not a fresh news digest. Take the running threads from the week's own editions below, and use this weekend's feeds for where each thread has actually got to.\n` +
      `4 mustReads of 8 paragraphs each, every paragraph 80-100 words. Each one is a thread followed across the week: how it opened, what moved, where it now stands, and what would move it next. 3 followUps in French on threads that went quiet or resolved.\n` +
      `"oneThing" is ONE sentence in ENGLISH, max 25 words: the single thing from this week worth carrying into next week.\n\n` +
      preamble +
      `# FEEDS — Europe, wires, Luxembourg\n${euDigest}\n\n# FEEDS — international\n${intlDigest}`,
    20000,
    "weekly front"
  );

  const used = (head.mustReads || []).map(m => "- " + m.headline).join("\n");

  const rest = await askDesks(
    `Continue the Sunday review of the week for ${today}.\n${RULES}\n${DESK_SHAPE}\n` +
      `Write exactly these desks, in order: ${LUX_BRIEF}, "Monde / géopolitique" (3 stories), "International — hors Europe" (4 stories), "Europe & politiques de l'UE" (3 stories), "Économie & marchés" (3 stories), "Technologie & sciences" (3 stories), "Sport" (2 short stories of 60-80 words).\n` +
      `Each entry recaps where that desk's week landed rather than a single dispatch: 100-130 words, three to four sentences.\n` +
      `Do NOT repeat the threads already covered at the front:\n${used}\n\n` +
      preamble +
      `# FEEDS — Europe, wires, Luxembourg\n${euDigest}\n\n# FEEDS — international\n${intlDigest}`,
    "weekly desks",
    20000
  );

  return { head, desks: rest };
}

async function main() {
  if (await alreadyDone()) {
    console.log(`Edition ${today} already exists — nothing to do.`);
    return;
  }

  const { groups, stats } = await collect();
  console.log(`Feeds: ${stats.ok}/${stats.feeds} ok, ${stats.items} items.`);
  if (stats.failed.length) console.log("Skipped:", stats.failed.join("; "));
  if (stats.items < 40) throw new Error(`only ${stats.items} items collected from ${stats.ok}/${stats.feeds} feeds — aborting rather than composing a thin edition`);

  const euDigest = digest(groups, ["wire", "eu", "lu"]);
  const intlDigest = digest(groups, ["wire", "intl"]);

  const { head, desks: rawDesks } = isSunday
    ? await composeSunday(euDigest, intlDigest)
    : await composeDaily(euDigest, intlDigest);

  const desks = rawDesks.filter(d => (d.stories || []).length);
  const edition = {
    date: today,
    kind: isSunday ? "weekly" : "daily",
    heat: typeof head.heat === "number" ? head.heat : 0.5,
    oneThing: head.oneThing || "",
    followUps: head.followUps || [],
    mustReads: head.mustReads || [],
    desks,
    sourced: true,
    feeds: { ok: stats.ok, of: stats.feeds, items: stats.items, skipped: stats.failed }
  };
  if (!edition.mustReads.length) throw new Error("the model returned no must-reads — nothing worth publishing");
  if (!desks.length) console.log("Warning: every desk batch failed — publishing the front page only.");

  const words = [
    ...edition.mustReads.flatMap(m => [m.headline, m.why, ...(m.paras || [])]),
    ...desks.flatMap(d => (d.stories || []).flatMap(s => [s.headline, s.summary, s.why]))
  ].join(" ").trim().split(/\s+/).length;
  edition.words = words;
  edition.readMin = Math.max(1, Math.round(words / 200));
  edition.storyCount = edition.mustReads.length + desks.reduce((a, d) => a + d.stories.length, 0);

  await mkdir(OUT, { recursive: true });
  await writeFile(`${OUT}/${today}.json`, JSON.stringify(edition, null, 1));

  const files = (await readdir(OUT)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  const index = [];
  for (const file of files) {
    try {
      const e = JSON.parse(await readFile(`${OUT}/${file}`, "utf8"));
      index.push({ date: e.date, kind: e.kind || "daily", heat: e.heat, readMin: e.readMin, storyCount: e.storyCount });
    } catch {}
  }
  await writeFile(`${OUT}/index.json`, JSON.stringify(index, null, 1));

  const label = isSunday ? "Revue de la semaine" : "Édition du jour";
  await writeFile(
    "notify.txt",
    `${label} · ${edition.readMin} min · ${edition.storyCount} sujets\n\n${edition.oneThing}`.trim()
  );
  console.log(`${label} ${today}: ${edition.storyCount} stories, ${words} words, ${edition.readMin} min.`);
}

main().catch(async e => {
  console.error(e);
  try {
    await writeFile("failure.txt", String(e && e.message ? e.message : e).slice(0, 300));
  } catch {}
  process.exit(1);
});
