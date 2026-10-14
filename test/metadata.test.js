import test from 'node:test';
import assert from 'node:assert/strict';
import { doiFromURL, parsePage, resolveReference } from '../metadata.js';

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    assert.ok(Object.hasOwn(routes, url), `Unexpected request: ${url}`);
    const result = routes[url];
    if (result instanceof Error) throw result;
    return new Response(typeof result === 'string' ? result : JSON.stringify(result), { status: 200 });
  };
  return { fetchImpl, calls };
}
const crossrefURL = doi => `https://api.crossref.org/works/${encodeURIComponent(doi)}`;

test('normalizes encoded DOI URLs and bioRxiv/medRxiv versions and PDF suffixes', () => {
  for (const host of ['www.biorxiv.org', 'www.medrxiv.org']) {
    for (const suffix of ['v2', 'v2.full', 'v2.full.pdf', '.abstract', '']) {
      assert.equal(doiFromURL(`https://${host}/content/10.1101/2024.01.01.123456${suffix}?download=1#abstract`), '10.1101/2024.01.01.123456');
    }
  }
  assert.equal(doiFromURL('https://doi.org/10.1234%2Fabc?utm_source=slack'), '10.1234/abc');
  assert.equal(doiFromURL('https://doi.org/10.1234/ab(v2)'), '10.1234/ab(v2)');
});

test('parses reordered attributes, apostrophes, entities, and every author', () => {
  const { item, doi } = parsePage(`
    <META content="A scientist's study &amp; results" NAME = "citation_title">
    <meta content='Smith, Jane' name='citation_author'>
    <meta name="citation_author" content="John O'Neil">
    <meta property="citation_doi" content="https://doi.org/10.1234/test">
    <meta name="citation_journal_title" content="Test Journal">
  `, 'https://publisher.example/paper');
  assert.equal(item.title, "A scientist's study & results");
  assert.equal(doi, '10.1234/test');
  assert.deepEqual(item.creators, [
    { creatorType: 'author', lastName: 'Smith', firstName: 'Jane' },
    { creatorType: 'author', name: "John O'Neil" },
  ]);
});

test('versioned preprint DOI succeeds even when the publisher page is blocked', async () => {
  const url = 'https://www.biorxiv.org/content/10.1101/2024.01.01.123456v3.full.pdf';
  const doi = '10.1101/2024.01.01.123456';
  const mock = mockFetch({ [crossrefURL(doi)]: { message: {
    title: ['A preprint'], type: 'posted-content', DOI: doi, publisher: 'bioRxiv',
    author: [{ given: 'Jane', family: 'Smith' }], issued: { 'date-parts': [[2024, 1, 1]] },
  } } });
  const item = await resolveReference(url, mock);
  assert.equal(item.itemType, 'preprint');
  assert.equal(item.title, 'A preprint');
  assert.equal(item.repository, 'bioRxiv');
  assert.equal(item.date, '2024-1-1');
  assert.equal(item.url, url);
  assert.equal(mock.calls.length, 1);
});

test('Crossref network failure still falls back to citation metadata with one page fetch', async () => {
  const url = 'https://publisher.example/10.1234/test';
  const mock = mockFetch({
    [crossrefURL('10.1234/test')]: new Error('network unavailable'),
    [url]: '<meta name="citation_title" content="Fallback paper">',
  });
  const item = await resolveReference(url, mock);
  assert.equal(item.itemType, 'journalArticle');
  assert.equal(item.DOI, '10.1234/test');
  assert.equal(item.title, 'Fallback paper');
  assert.equal(mock.calls.filter(call => call === url).length, 1);
});

test('page DOI lookup falls back after an HTTP error', async () => {
  const url = 'https://www.medrxiv.org/article';
  const item = await resolveReference(url, { fetchImpl: async request => request === url
    ? new Response('<meta name="citation_title" content="Preprint"><meta name="citation_doi" content="10.1101/test">')
    : new Response('unavailable', { status: 503 }) });
  assert.equal(item.itemType, 'preprint');
  assert.equal(item.title, 'Preprint');
});

test('does not mistake a DOI in the references for the current paper', async () => {
  const url = 'https://publisher.example/paper';
  const mock = mockFetch({ [url]: '<meta name="citation_title" content="Current paper"><p>Reference: 10.1234/other-paper</p>' });
  const item = await resolveReference(url, mock);
  assert.equal(item.title, 'Current paper');
  assert.equal(item.DOI, '');
  assert.deepEqual(mock.calls, [url]);
});

test('uses explicit page DOI metadata for a journal reference', async () => {
  const url = 'https://publisher.example/paper';
  const mock = mockFetch({
    [url]: '<meta content="doi:10.1234/test" name="dc.identifier">',
    [crossrefURL('10.1234/test')]: { message: {
      title: ['Journal article'], type: 'journal-article', 'container-title': ['Journal'],
      volume: '2', issue: '3', page: '4-5',
    } },
  });
  const item = await resolveReference(url, mock);
  assert.equal(item.itemType, 'journalArticle');
  assert.equal(item.publicationTitle, 'Journal');
  assert.equal(item.pages, '4-5');
});

test('falls back to a webpage when no reference metadata is available', async () => {
  const url = 'https://example.org/news';
  const mock = mockFetch({ [url]: '<title>News</title><p>A mention of 10.1234/other-paper</p>' });
  assert.deepEqual(await resolveReference(url, mock), { itemType: 'webpage', title: url, url });
  assert.equal(mock.calls.length, 1);
});
