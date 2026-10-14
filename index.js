import express from "express";
import crypto from "crypto";
import { resolveReference } from "./metadata.js";

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

// ─── URL blocklist ───────────────────────────────────────────────────────────
const BLOCKED_DOMAINS = new Set([
  "slack.com",
  "app.slack.com",
  "twitter.com",
  "x.com",
  "bsky.app",
  "linkedin.com"
]);

function isBlockedUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return [...BLOCKED_DOMAINS].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return true; // block malformed URLs too
  }
}

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


// ─── Zotero: resolve reference metadata and save ─────────────────────────────
async function saveToZotero(url, postedBy, collections) {
  const libraryPath = ZOTERO_GROUP_ID
    ? `groups/${ZOTERO_GROUP_ID}`
    : `users/${ZOTERO_USER_ID}`;
  const item = {
    ...await resolveReference(url),
    extra: `Shared by @${postedBy} in #papers`,
    collections,
  };

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
  const filteredUrls = urls.filter(u => !isBlockedUrl(u));
  if (!filteredUrls.length) return;

  const newUrls = filteredUrls.filter((u) => !seenLinks.has(u));
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
