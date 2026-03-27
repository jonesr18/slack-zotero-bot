# slack-zotero-bot

A Slack bot that monitors a channel for shared links and automatically saves them to a Zotero group library. When a link is posted, the bot extracts metadata (title, authors, abstract, journal, DOI) via CrossRef or by scraping the page directly, then saves a fully populated item to Zotero. Supports preprints from bioRxiv and medRxiv, subfolder tagging, and thread reply confirmations.

---

## Features

- Monitors a Slack channel (e.g. `#papers`) for posted links
- Looks up full metadata via CrossRef for published papers
- Scrapes `citation_*` meta tags for preprints (bioRxiv, medRxiv, etc.)
- Falls back to saving a bare webpage item if no metadata is found
- Saves items to a Zotero group library collection
- Supports routing links to subfolders using `!tag` syntax
- Reacts with ✅ on success or ❌ on failure
- Posts a thread reply with error details if saving fails
- Ignores Slack-internal URLs (e.g. thread links, file links) 
- Ignores social media links (x.com, twitter.com, bsky.app, linkedin.com) that are commonly shared in reference to a paper. Users should be encouraged to post links to "tweetorials" in addition to the actual papers.

---

## Requirements

- [Node.js](https://nodejs.org) v18 or later
- A [Slack account](https://slack.com) with permission to create apps
- A [Zotero account](https://www.zotero.org) with a group library
- A [Railway account](https://railway.app) for hosting (free tier works)
- A [GitHub account](https://github.com) for deployment

---

## 1. Clone the repo

In GitHub Desktop:

1. **File → Clone Repository**
2. Search for `jonesr18/slack-zotero-bot`
3. Choose a local folder and click **Clone**

Or via the command line:

```bash
git clone https://github.com/jonesr18/slack-zotero-bot.git
cd slack-zotero-bot
```

---

## 2. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**
2. Give it a name (e.g. `Zotero Bot`) and select your workspace
3. Under **OAuth & Permissions → Bot Token Scopes**, add:
   - `channels:history` — read messages in public channels
   - `reactions:write` — add emoji reactions to messages
   - `chat:write` — post thread replies
4. Click **Install to Workspace** and copy the **Bot User OAuth Token** (starts with `xoxb-`)
5. Under **Basic Information**, copy the **Signing Secret**
6. Under **Event Subscriptions**:
   - Enable Events
   - Subscribe to the bot event `message.channels`
   - Set the Request URL to your Railway domain (see step 4 below) — you can come back to this after deploying
7. Invite the bot to your channel: in Slack, open the channel and type `/invite @YourBotName`

---

## 3. Get your Zotero credentials

**API key:**
1. Go to [zotero.org/settings/keys](https://www.zotero.org/settings/keys) → **Create new private key**
2. Under **Default Library Permissions** set Read/Write
3. Under **Specific Groups** find your group library and set Read/Write
4. Save and copy the key

**User ID:** shown on the same keys page, just above the key list

**Group ID:** visible in your group library URL — e.g. `https://www.zotero.org/groups/1234567/...` → Group ID is `1234567`

**Collection key:** open your target subfolder in the Zotero web library — the 8-character key is in the URL, e.g. `https://www.zotero.org/groups/1234567/group_name/collections/12ABCDEF/collection` → Collection key is `12ABCDEF`

---

## 4. Deploy to Railway

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo** and select `slack-zotero-bot`
3. Once deployed, go to your service → **Settings → Networking → Generate Domain**
4. Go to your service → **Variables** and add the following:

| Variable | Value |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` from step 2 |
| `SLACK_SIGNING_SECRET` | from your Slack app's Basic Information page |
| `ZOTERO_API_KEY` | from step 3 |
| `ZOTERO_USER_ID` | your numeric Zotero user ID |
| `ZOTERO_GROUP_ID` | numeric group library ID |
| `ZOTERO_COLLECTION` | 8-character default collection key |
| `ZOTERO_COLLECTION_MAP` | JSON map of tags to collection keys (see below) |

5. Go back to your Slack app → **Event Subscriptions** and set the Request URL to:
   ```
   https://your-domain.up.railway.app/slack/events
   ```
   Slack will verify the URL — the bot must be running for this to pass.

---

## 5. Configure subfolder tags

The `ZOTERO_COLLECTION_MAP` variable maps `!tags` in Slack messages to Zotero collection keys. Set it as a JSON string in Railway:

```json
{"methods":"AABBCCDD","reviews":"EEFFGGHH","rna-seq":"IIJJKKLL"}
```

Users can then tag links when posting:

```
Great preprint on cell sorting! https://www.biorxiv.org/content/... !methods !rna-seq
```

- Links with a recognized `!tag` are saved to the corresponding Zotero subfolder
- Links with multiple tags are saved to all matching subfolders simultaneously
- Links with no tag (or an unrecognized tag) fall back to the default `ZOTERO_COLLECTION`

---

## 6. Running locally (for development)

```bash
cp .env.example .env
# Fill in your values in .env

node --env-file=.env index.js
# → Bot listening on :3000
```

To expose the local server to Slack:

```bash
npx ngrok http 3000
# Paste the https URL into Slack's Event Subscriptions
```

---

## How it works

When a message is posted in the monitored channel, the bot:

1. Extracts all URLs from the message text
2. Filters out Slack-internal URLs (e.g. `slack.com` thread links)
3. Skips any URLs it has already seen in this session
4. Parses any `!tags` to determine which Zotero collection(s) to save to
5. For each new URL, attempts to fetch metadata in order:
   - **CrossRef** — used when a DOI is found in the URL or page
   - **HTML scraping** — parses `citation_*` meta tags (works for bioRxiv, medRxiv, and most publishers)
   - **Bare fallback** — saves the URL as a webpage item with no metadata
6. Saves the item to Zotero via the Web API
7. Reacts to the message with ✅ on success or ❌ on failure
8. Posts a thread reply with error details if any links failed to save

---

## Updating the bot

Make changes locally, then in GitHub Desktop:

1. Review changed files in the left panel
2. Write a commit message at the bottom left
3. Click **Commit to main**
4. Click **Push origin**

Railway will detect the push and redeploy automatically within ~30 seconds.

---

## Troubleshooting

**Bot isn't responding to messages**
- Make sure the bot is invited to the channel (`/invite @BotName`)
- Check that `message.channels` is listed under Event Subscriptions → Bot Events
- Check Railway logs for errors

**Slack challenge verification failing**
- Confirm the Request URL ends in `/slack/events`
- Make sure the bot is deployed and running (check Railway logs for `Bot listening on :PORT`)
- Check that the domain in Railway Networking is pointing to the correct port

**Items not appearing in Zotero**
- Confirm `ZOTERO_GROUP_ID` is set correctly in Railway variables
- Confirm the API key has Read/Write access to the group library at zotero.org/settings/keys
- Check Railway logs for the Zotero API response — a 200 with an empty `successful` object indicates a permission issue

**Metadata not populating**
- For published papers, check that the DOI is present in the URL or page source
- For preprints, bioRxiv and medRxiv are fully supported via HTML scraping
- Some publisher pages render content via JavaScript and may not expose meta tags in raw HTML — these will fall back to a bare webpage item
