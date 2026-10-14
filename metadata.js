// Keep metadata resolution separate from Slack/Zotero writes so failures can be
// tested without contacting either service.
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; SlackZoteroBot/0.2)" };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
    const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    if (!code.startsWith("#")) return named[code.toLowerCase()];
    const number = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

function metaTags(html) {
  const tags = new Map();
  for (const tag of html.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || []) {
    const attributes = {};
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]).trim();
    }
    const key = (attributes.name || attributes.property || "").toLowerCase();
    if (key && attributes.content) tags.set(key, [...(tags.get(key) || []), attributes.content]);
  }
  return tags;
}

export function normalizeDOI(value) {
  if (!value) return null;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* retain malformed escapes */ }
  const match = decoded.match(/10\.\d{4,9}\/[^\s"'<>?#]+/i);
  return match ? match[0] : null;
}

export function doiFromURL(url) {
  const parsed = new URL(url);
  let doi = normalizeDOI(parsed.pathname);
  // bioRxiv/medRxiv version and representation suffixes aren't part of the DOI.
  if (doi && /(^|\.)(biorxiv|medrxiv)\.org$/i.test(parsed.hostname)) {
    doi = doi.replace(/(?:\.full|\.abstract|\.short)?(?:\.pdf)?$/i, "").replace(/v\d+$/i, "");
  }
  return doi;
}

function author(name) {
  const parts = name.split(",").map(part => part.trim());
  if (parts.length > 1) return { creatorType: "author", lastName: parts[0], firstName: parts.slice(1).join(", ") };
  // Preserve unstructured names rather than guessing which part is the surname.
  return { creatorType: "author", name };
}

export function parsePage(html, url) {
  const tags = metaTags(html);
  const get = (...names) => names.map(name => tags.get(name)?.[0]).find(Boolean) || "";
  const doi = ["citation_doi", "dc.identifier.doi", "prism.doi", "dc.identifier"]
    .flatMap(name => tags.get(name) || []).map(normalizeDOI).find(Boolean) || null;
  const title = get("citation_title");
  if (!title) return { doi, item: null };
  const preprint = /(^|\.)(biorxiv|medrxiv|arxiv)\.org$/i.test(new URL(url).hostname);
  const journal = get("citation_journal_title");
  return {
    doi,
    item: {
      itemType: preprint ? "preprint" : "journalArticle",
      title,
      DOI: doi || "",
      creators: (tags.get("citation_author") || []).map(author),
      date: get("citation_publication_date", "citation_online_date", "dc.date"),
      abstractNote: get("citation_abstract", "dc.description", "dcterms.abstract"),
      ...(preprint ? { repository: journal || new URL(url).hostname.replace(/^www\./, "") } : {
        publicationTitle: journal,
        volume: get("citation_volume"),
        issue: get("citation_issue"),
        pages: [get("citation_firstpage"), get("citation_lastpage")].filter(Boolean).join("–"),
      }),
    },
  };
}

async function attempt(label, callback) {
  try { return await callback(); }
  catch (error) { console.log(`${label}: ${error.message}`); return null; }
}

async function request(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

function crossrefItem(data, doi) {
  const title = Array.isArray(data.title) ? data.title[0] : data.title;
  if (!title) return null;
  const preprint = data.type === "posted-content";
  return {
    itemType: preprint ? "preprint" : "journalArticle",
    title,
    DOI: data.DOI || doi,
    creators: (data.author || []).map(a => a.family ? {
      creatorType: "author", firstName: a.given || "", lastName: a.family,
    } : { creatorType: "author", name: a.name || a.given || "Unknown" }),
    date: (data.issued?.["date-parts"]?.[0] || []).join("-"),
    abstractNote: data.abstract || "",
    ...(preprint ? { repository: data.institution?.[0]?.name || data.publisher || "" } : {
      publicationTitle: data["container-title"]?.[0] || "",
      volume: String(data.volume || ""), issue: String(data.issue || ""), pages: String(data.page || ""),
    }),
  };
}

export async function resolveReference(url, { fetchImpl = fetch } = {}) {
  const lookup = doi => attempt(`Crossref lookup failed for ${doi}`, async () => {
    const response = await request(fetchImpl, `https://api.crossref.org/works/${encodeURIComponent(doi)}`);
    return crossrefItem((await response.json()).message, doi);
  });
  const urlDOI = doiFromURL(url);
  if (urlDOI) {
    const item = await lookup(urlDOI);
    if (item) return { ...item, url };
  }
  // Fetch the page only once, and use only explicit DOI metadata. A DOI in a
  // bibliography or related-articles widget may refer to a different paper.
  const page = await attempt(`Page metadata failed for ${url}`, async () => {
    const response = await request(fetchImpl, url);
    return parsePage(await response.text(), response.url || url);
  });
  if (page?.doi && page.doi !== urlDOI) {
    const item = await lookup(page.doi);
    if (item) return { ...item, url };
  }
  if (page?.item) return { ...page.item, DOI: page.item.DOI || urlDOI || "", url };
  console.log(`No reference metadata found for ${url}; saving as webpage`);
  return { itemType: "webpage", title: url, url };
}
