// Source list for Le Point du Matin.
// "official" = the outlet's own public feed. Where an outlet publishes no usable
// public feed (Reuters, AFP, AP, Bloomberg, WSJ), we read the last 24h of its
// items through Google News' per-site feed instead — headlines and standfirsts
// only, which is all the briefing needs. Paywalled outlets are kept (headline +
// standfirst are public) and marked so the edition can label them.
// A feed that fails or times out is skipped; the run continues.

const gnews = (site, lang = "en-US", ceid = "US:en") =>
  `https://news.google.com/rss/search?q=when:24h+site:${site}&hl=${lang}&gl=${ceid.split(":")[0]}&ceid=${ceid}`;

export const FEEDS = [
  // ---- wires (via Google News: no public RSS of their own) ----
  { source: "Reuters", lang: "EN", desk: "wire", url: gnews("reuters.com") },
  { source: "Reuters", lang: "FR", desk: "wire", url: gnews("reuters.com", "fr", "FR:fr") },
  { source: "AFP", lang: "FR", desk: "wire", url: gnews("afp.com", "fr", "FR:fr") },
  { source: "AP", lang: "EN", desk: "wire", url: gnews("apnews.com") },

  // ---- Europe / official feeds ----
  { source: "BBC", lang: "EN", desk: "eu", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { source: "DW", lang: "EN", desk: "eu", url: "https://rss.dw.com/rdf/rss-en-world" },
  { source: "DW", lang: "DE", desk: "eu", url: "https://rss.dw.com/rdf/rss-de-all" },
  { source: "Euronews", lang: "EN", desk: "eu", url: "https://www.euronews.com/rss?level=theme&name=news" },
  { source: "Euronews", lang: "FR", desk: "eu", url: "https://fr.euronews.com/rss?level=theme&name=news" },
  { source: "Le Monde", lang: "FR", desk: "eu", paywalled: true, url: "https://www.lemonde.fr/international/rss_full.xml" },
  { source: "France 24", lang: "FR", desk: "eu", url: "https://www.france24.com/fr/rss" },
  { source: "SZ", lang: "DE", desk: "eu", paywalled: true, url: "https://rss.sueddeutsche.de/rss/Topthemen" },
  { source: "FAZ", lang: "DE", desk: "eu", paywalled: true, url: "https://www.faz.net/rss/aktuell/" },
  { source: "FT", lang: "EN", desk: "eu", paywalled: true, url: "https://www.ft.com/world?format=rss" },
  { source: "Corriere", lang: "IT", desk: "eu", paywalled: true, url: "https://xml2.corriereobjects.it/rss/homepage.xml" },
  { source: "Repubblica", lang: "IT", desk: "eu", url: "https://www.repubblica.it/rss/homepage/rss2.0.xml" },

  // ---- Luxembourg ----
  { source: "RTL.lu", lang: "LB", desk: "lu", url: "https://www.rtl.lu/rss/news.xml" },
  { source: "RTL.lu", lang: "FR", desk: "lu", url: gnews("rtl.lu", "fr", "LU:fr") },
  { source: "Wort", lang: "DE", desk: "lu", paywalled: true, url: gnews("wort.lu", "de", "LU:de") },

  // ---- international (non-European) ----
  { source: "Al Jazeera", lang: "EN", desk: "intl", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { source: "NYT", lang: "EN", desk: "intl", paywalled: true, url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { source: "Washington Post", lang: "EN", desk: "intl", paywalled: true, url: "https://feeds.washingtonpost.com/rss/world" },
  { source: "WSJ", lang: "EN", desk: "intl", paywalled: true, url: gnews("wsj.com") },
  { source: "NPR", lang: "EN", desk: "intl", url: "https://feeds.npr.org/1004/rss.xml" },
  { source: "PBS News", lang: "EN", desk: "intl", url: "https://www.pbs.org/newshour/feeds/rss/world" },
  { source: "Bloomberg", lang: "EN", desk: "intl", paywalled: true, url: gnews("bloomberg.com") },
  { source: "The Economist", lang: "EN", desk: "intl", paywalled: true, url: "https://www.economist.com/the-world-this-week/rss.xml" },
  { source: "Foreign Affairs", lang: "EN", desk: "intl", paywalled: true, url: gnews("foreignaffairs.com") },
  { source: "CFR", lang: "EN", desk: "intl", url: "https://www.cfr.org/rss/daily-news-brief" }
];

const strip = (s = "") =>
  s.replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, m =>
      ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ", "&#39;": "'" }[m] || " "))
    .replace(/\s+/g, " ")
    .trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? strip(m[1]) : "";
};

function parseFeed(xml) {
  const chunks = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1);
  return chunks.map(c => {
    const body = c.split(/<\/item>|<\/entry>/i)[0];
    const link = tag(body, "link") || (body.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    return {
      title: tag(body, "title"),
      summary: (tag(body, "description") || tag(body, "summary") || tag(body, "content")).slice(0, 400),
      link,
      date: tag(body, "pubDate") || tag(body, "updated") || tag(body, "published")
    };
  }).filter(i => i.title);
}

async function fetchFeed(feed, perFeed, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; PointDuMatin/1.0; personal press review)" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const items = parseFeed(await res.text()).slice(0, perFeed);
    return { ...feed, items, ok: true };
  } catch (e) {
    return { ...feed, items: [], ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/** Pull every feed in parallel. Returns { groups, stats }. */
export async function collect({ perFeed = 10, timeoutMs = 15000 } = {}) {
  const results = await Promise.all(FEEDS.map(f => fetchFeed(f, perFeed, timeoutMs)));
  const ok = results.filter(r => r.ok && r.items.length);
  const failed = results.filter(r => !r.ok || !r.items.length);
  return {
    groups: ok,
    stats: {
      feeds: FEEDS.length,
      ok: ok.length,
      items: ok.reduce((a, r) => a + r.items.length, 0),
      failed: failed.map(r => `${r.source} (${r.lang})${r.error ? ": " + r.error : ""}`)
    }
  };
}

/** Compact, model-readable digest of one desk's feeds. */
export function digest(groups, desks) {
  return groups
    .filter(g => desks.includes(g.desk))
    .map(g => {
      const head = `## ${g.source} [${g.lang}]${g.paywalled ? " (paywalled)" : ""}`;
      const lines = g.items.map(i => `- ${i.title}${i.summary ? " — " + i.summary : ""}\n  ${i.link}`);
      return [head, ...lines].join("\n");
    })
    .join("\n\n");
}
