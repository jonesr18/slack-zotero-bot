import express from "express";
import crypto from "crypto";

const app = express();

// ─── Config ────────────────────────────────────────────────────────────────
const SLACK_BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;       // xoxb-...
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const ZOTERO_API_KEY       = process.env.ZOTERO_API_KEY;
const ZOTERO_USER_ID       = process.env.ZOTERO_USER_ID;        // numeric ID
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

// ─── Zotero: save a URL as a web page item ──────────────────────────────────
async function saveToZotero(url, postedBy) {
  const item = {
    itemType: "webpage",
    url,
    title: url,                          // Zotero will auto-fetch the real title
    note: `Shared by @${postedBy} in #papers`,
    collections: ZOTERO_COLLECTION ? [ZOTERO_COLLECTION] : [],
  };

  const res = await fetch(
    `https://api.zotero.org/users/${ZOTERO_USER_ID}/items`,
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zotero API error ${res.status}: ${text}`);
  }

  return res.json();
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Bot listening on :${PORT}`));
