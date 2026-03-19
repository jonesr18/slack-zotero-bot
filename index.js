import express from "express";
import crypto from "crypto";

const app = express();

// ─── Config ────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;       // xoxb-...
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const ZOTERO_API_KEY       = process.env.ZOTERO_API_KEY;
const ZOTERO_USER_ID       = process.env.ZOTERO_USER_ID;        // numeric ID
const ZOTERO_GROUP_ID      = process.env.ZOTERO_GROUP_ID;       // numeric ID
const ZOTERO_COLLECTION    = process.env.ZOTERO_COLLECTION;     // 8-char key, optional

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

// ─── Zotero: save a URL as a web page item ──────────────────────────────────
async function saveToZotero(url, postedBy) {
  // Try to extract DOI from URL first
  const urlDOI = url.match(/10\.\d{4,}\/[^\s]+/)?.[0];
  const doi = urlDOI || await extractDOI(url);

  const libraryPath = ZOTERO_GROUP_ID
    ? `groups/${ZOTERO_GROUP_ID}`
    : `users/${ZOTERO_USER_ID}`;

  let item;
  if (doi) {
    // Use Zotero's search endpoint to fetch full metadata from CrossRef
    console.log(`Looking up DOI: ${doi}`);
    const searchRes = await fetch(
      `https://api.zotero.org/${libraryPath}/items?q=${encodeURIComponent(doi)}&qmode=everything&key=${ZOTERO_API_KEY}`,
    );

    // Fetch item data from CrossRef directly
    const crossRefRes = await fetch(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}/transform/application/vnd.citationstyles.csl+json`
    );

    if (crossRefRes.ok) {
      const csl = await crossRefRes.json();
      console.log(`CrossRef metadata:`, JSON.stringify(csl));

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
        authors: (csl.author || []).map(a => ({
          firstName: a.given || "",
          lastName: a.family || "",
        })),
        extra: `Shared by @${postedBy} in #papers`,
        collections: ZOTERO_COLLECTION ? [ZOTERO_COLLECTION] : [],
      };

      // Zotero expects authors in the creators field
      item.creators = item.authors.map(a => ({
        creatorType: "author",
        firstName: a.firstName,
        lastName: a.lastName,
      }));
      delete item.authors;  
    }
  }

  // Fallback: save as webpage if no DOI or CrossRef lookup failed
  if (!item) {
    console.log(`No DOI found, saving as webpage`);
    item = {
      itemType: "journalArticle",
      url,
      title: url,                          // Zotero will auto-fetch the real title
      DOI: doi || "",
      extra: `Shared by @${postedBy} in #papers`,
      collections: ZOTERO_COLLECTION ? [ZOTERO_COLLECTION] : [],
    };
  }

  console.log(`Saving to: ${libraryPath}`);
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
  
  if (!res.ok) {
    throw new Error(`Zotero API error: ${res.status}: ${text}`);
  }

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

  for (const url of newUrls) {
    try {
      await saveToZotero(url, event.user);
      seenLinks.add(url);
      console.log(`✅ Saved: ${url}`);
    } catch (err) {
      console.error(`❌ Failed to save ${url}:`, err.message);
    }
  }

  // React once to confirm (even if multiple links were saved)
  await addReaction(event.channel, event.ts);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Bot listening on :${PORT}`));
