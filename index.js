import express from "express";
import crypto from "crypto";

const app = express();

// ─── Config ────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN       = process.env.SLACK_BOT_TOKEN;       // xoxb-...
const SLACK_SIGNING_SECRET  = process.env.SLACK_SIGNING_SECRET;
const ZOTERO_API_KEY        = process.env.ZOTERO_API_KEY;
const ZOTERO_USER_ID        = process.env.ZOTERO_USER_ID;        // numeric ID
const ZOTERO_GROUP_ID       = process.env.ZOTERO_GROUP_ID;       // numeric ID
const ZOTERO_COLLECTION     = process.env.ZOTERO_COLLECTION;     // 8-char key, optional
const ZOTERO_COLLECTION_MAP = process.env.ZOTERO_COLLECTION_MAP; // dictionary, optional

// ─── Simple in-memory dedup (swap for Redis/SQLite in production) ───────────
const seenLinks = new Set();

// ─── URL regex ──────────────────────────────────────────────────────────────
const URL_REGEX = /https?:\/\/[^\s>|]+/g;

// ─── Slack request verification ─────────────────────────────────────────────
function verifySlackRequest(req) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  if (Math.abs(Date.now() / 1000 - timestamp) > 60 * 5) return false;

  const sig = req.headers["x-slack-signature"];
  const base = `v0:${timestamp}:${req.rawBody}`;
  const expected = "v0=" + crypto
    .createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(base)
    .digest("hex");

  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Extract tags from Slack message for Collection routing
function extractTags(text) {
  const tags = text.match(/!([a-zA-Z0-9_-]+)/g) || [];
  return tags.map(t => t.slice(1).toLowerCase()); // strip the # and lowercase
}

function resolveCollections(tags) {
  let collectionMap = {};
  try {
    collectionMap = JSON.parse(ZOTERO_COLLECTION_MAP || "{}");
  } catch {
    console.log("Could not parse ZOTERO_COLLECTION_MAP");
  }

  const matched = tags
    .filter(t => collectionMap[t])
    .map(t => collectionMap[t]);

  // Fall back to default collection if no tags matched
  return matched.length > 0 ? matched : (ZOTERO_COLLECTION ? [ZOTERO_COLLECTION] : []);
}


// Try to find DOI of paper
async function extractDOI(url) {
  try {
    const res = await fetch(url, {
      headers: {
        // Spoof a browser user agent — some publishers block bots
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    const html = await res.text();
    // console.log(html)

    // Try meta tag first (most reliable)
    const metaDOI = html.match(/<meta[^>]+name=["']dc\.identifier["'][^>]+content=["'](10\.\d{4,}\/[^\s"']+)["']/i)
                 || html.match(/<meta[^>]+content=["'](10\.\d{4,}\/[^\s"']+)["'][^>]+name=["']dc\.identifier["']/i)
                 || html.match(/<meta[^>]+name=["']citation_doi["'][^>]+content=["'](10\.\d{4,}\/[^\s"']+)["']/i)
                 || html.match(/<meta[^>]+content=["'](10\.\d{4,}\/[^\s"']+)["'][^>]+name=["']citation_doi["']/i);

    if (metaDOI) return metaDOI[1];

    // Fall back to DOI pattern anywhere in the page
    const inlineDOI = html.match(/10\.\d{4,}\/[^\s"'<>]+/);
    if (inlineDOI) return inlineDOI[0];

    return null;
  } catch (err) {
    console.log(`Could not scrape DOI from ${url}:`, err.message);
    return null;
  }
}

// Scrape webpage for citation information
async function scrapeMetadata(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    const html = await res.text();

    function getMeta(name) {
      const match = html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))
                 || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, "i"));
      return match ? match[1].trim() : null;
    }

    function getAllMeta(name) {
      const regex = new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "gi");
      const results = [];
      let match;
      while ((match = regex.exec(html)) !== null) results.push(match[1].trim());
      return results;
    }

    const title = getMeta("citation_title");
    if (!title) return null; // not a paper page

    // Parse authors — each author is a separate meta tag
    const authorStrings = getAllMeta("citation_author");
    const creators = authorStrings.map(a => {
      const parts = a.split(",").map(p => p.trim());
      return {
        creatorType: "author",
        lastName: parts[0] || "",
        firstName: parts[1] || "",
      };
    });

    const doi = getMeta("citation_doi");
    const date = getMeta("citation_publication_date") || getMeta("citation_online_date");
    const journal = getMeta("citation_journal_title") || getMeta("citation_publisher");
    const abstract = getMeta("dc.description") || getMeta("citation_abstract");
    const volume = getMeta("citation_volume");
    const issue = getMeta("citation_issue");
    const pages = getMeta("citation_firstpage") && getMeta("citation_lastpage")
      ? `${getMeta("citation_firstpage")}–${getMeta("citation_lastpage")}`
      : getMeta("citation_firstpage") || null;

    return { title, creators, doi, date, journal, abstract, volume, issue, pages };
  } catch (err) {
    console.log(`Could not scrape metadata from ${url}:`, err.message);
    return null;
  }
}

// ─── Zotero: save a URL as a journalArticle item ──────────────────────────────────
async function saveToZotero(url, postedBy, collections) {
  // Try to extract DOI from URL first
  const urlDOI = url.match(/10\.\d{4,}\/[^\s]+/)?.[0];
  const doi = urlDOI || await extractDOI(url);

  const libraryPath = ZOTERO_GROUP_ID
    ? `groups/${ZOTERO_GROUP_ID}`
    : `users/${ZOTERO_USER_ID}`;

  let item;
  
  // ── Strategy 1: CrossRef via DOI ─────────────────────────────────────────
  if (doi) {
    console.log(`Looking up DOI: ${doi}`);
    const crossRefRes = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}/transform/application/vnd.citationstyles.csl+json`
    );

    if (crossRefRes.ok) {
      const csl = await crossRefRes.json();
      console.log(`CrossRef metadata found`);
      item = {
        itemType: "journalArticle",
        title: csl.title || url,
        DOI: doi,
        url,
        publicationTitle: csl["container-title"] || "",
        volume: csl.volume || "",
        issue: csl.issue || "",
        pages: csl.page || "",
        date: csl.issued?.["date-parts"]?.[0]?.[0]?.toString() || "",
        abstractNote: csl.abstract || "",
        creators: (csl.author || []).map(a => ({
          creatorType: "author",
          firstName: a.given || "",
          lastName: a.family || "",
        })),
        extra: `Shared by @${postedBy} in #papers`,
        collections,
      };
    }
  }

  // ── Strategy 2: Scrape citation meta tags from the page ──────────────────
  if (!item) {
    console.log(`CrossRef failed or no DOI, scraping page metadata`);
    const meta = await scrapeMetadata(url);

    if (meta) {
      console.log(`Scraped metadata: ${meta.title}`);
      item = {
        itemType: "journalArticle",
        title: meta.title,
        DOI: meta.doi || doi || "",
        url,
        publicationTitle: meta.journal || "",
        volume: meta.volume || "",
        issue: meta.issue || "",
        pages: meta.pages || "",
        date: meta.date || "",
        abstractNote: meta.abstract || "",
        creators: meta.creators,
        extra: `Shared by @${postedBy} in #papers`,
        collections,
      };
    }
  }

  // ── Strategy 3: Bare fallback ─────────────────────────────────────────────
  if (!item) {
    console.log(`No metadata found, saving bare URL`);
    item = {
      itemType: "webpage",
      url,
      title: url,
      extra: `Shared by @${postedBy} in #papers`,
      collections,
    };
  }

  console.log(`Saving to: ${libraryPath}, collection: ${collections}`);
  console.log(`Collection: ${ZOTERO_COLLECTION}`);
  console.log(`Item:`, JSON.stringify(item));

  const res = await fetch(
    `https://api.zotero.org/${libraryPath}/items`,
    {
      method: "POST",
      headers: {
        "Zotero-API-Key": ZOTERO_API_KEY,
        "Zotero-API-Version": "3",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([item]),
    }
  );

  // Check item key Zotero assigned (https://api.zotero.org/groups/{GROUP_ID}/items/{ITEM_KEY}?key={YOUR_API_KEY})
  const text = await res.text();
  console.log(`Zotero response ${res.status}:`, text);
  if (!res.ok) {throw new Error(`Zotero API error: ${res.status}: ${text}`)};
  return JSON.parse(text);
}

// ─── Slack: add a reaction to a message ─────────────────────────────────────
async function addReaction(channel, timestamp, emoji = "white_check_mark") {
  await fetch("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, timestamp, name: emoji }),
  });
}

// ─── Slack: add a comment to a message ─────────────────────────────────────
async function postThreadReply(channel, timestamp, text) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      thread_ts: timestamp,
      text,
    }),
  });
}

// ─── Parse raw body for signature verification ──────────────────────────────
// Parse raw body for signature verification
app.use((req, res, next) => {
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data || "{}");
    } catch {
      req.body = {};
    }
    next();
  });
});

// ─── Main webhook endpoint ──────────────────────────────────────────────────
app.post("/slack/events", async (req, res) => {
  // Slack URL verification challenge
  if (req.body.type === "url_verification") {
    return res.json({ challenge: req.body.challenge });
  }

  // Verify signature
  if (!verifySlackRequest(req)) {
    return res.status(401).send("Unauthorized");
  }

  // Acknowledge immediately (Slack needs < 3s)
  res.sendStatus(200);

  const event = req.body.event;
  if (!event || event.type !== "message" || event.subtype) return; // ignore edits/deletes

  const urls = [...new Set((event.text || "").match(URL_REGEX) || [])];
  if (!urls.length) return;

  const newUrls = urls.filter((u) => !seenLinks.has(u));
  if (!newUrls.length) return;

  // Extract tags from the message
  const tags = extractTags(event.text || "");
  const collections = resolveCollections(tags);
  console.log(`Tags found: ${tags.join(", ") || "none"}`);
  console.log(`Resolved collections: ${collections.join(", ")}`);

  let anySuccess = false;
  const failures = [];

  for (const url of newUrls) {
    try {
      await saveToZotero(url, event.user, collections);
      seenLinks.add(url);
      console.log(`✅ Saved: ${url}`);
      anySuccess = true;
    } catch (err) {
      console.error(`❌ Failed to save ${url}:`, err.message);
      failures.push({ url, message: err.message });
    }
  }

  // React based on outcome
  if (failures.length === 0) {
    await addReaction(event.channel, event.ts, "white_check_mark");
  } else if (!anySuccess) {
    await addReaction(event.channel, event.ts, "x");
    await postThreadReply(event.channel, event.ts,
      `❌ Failed to save the following links:\n${failures.map(f => `• ${f.url}: ${f.message}`).join("\n")}`
    );
  } else {
    // Mixed
    await addReaction(event.channel, event.ts, "white_check_mark");
    await addReaction(event.channel, event.ts, "x");
    await postThreadReply(event.channel, event.ts,
      `❌ Failed to save the following links:\n${failures.map(f => `• ${f.url}: ${f.message}`).join("\n")}`
    );
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Bot listening on :${PORT}`));
