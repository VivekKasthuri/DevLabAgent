// src/tools/web.js — web search (DuckDuckGo, no API key) + URL fetch
import { printTool } from '../ui.js';

const DDG_INSTANT = 'https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=';
const DDG_HTML    = 'https://html.duckduckgo.com/html/?q=';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

async function fetchJSON(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  return resp.json();
}

async function fetchText(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000) });
  return resp.text();
}

function stripHTML(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function parseDDGHTML(html) {
  const results = [];
  // Match result blocks
  const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < 8) {
    const url = m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '');
    const decodedUrl = decodeURIComponent(url.split('&')[0]);
    results.push({
      title: stripHTML(m[2]),
      url: decodedUrl,
      snippet: stripHTML(m[3]),
    });
  }
  return results;
}

export async function webSearch(query, { maxResults = 5 } = {}) {
  printTool(`Searching: "${query}"`);
  const results = [];

  // 1. Try DuckDuckGo Instant Answer API
  try {
    const data = await fetchJSON(`${DDG_INSTANT}${encodeURIComponent(query)}`);

    if (data.AbstractText) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
        source: 'instant-answer',
      });
    }

    for (const r of (data.RelatedTopics || []).slice(0, 3)) {
      if (r.Text && r.FirstURL) {
        results.push({ title: r.Text.slice(0, 80), url: r.FirstURL, snippet: r.Text, source: 'related' });
      }
    }
  } catch {}

  // 2. Scrape DuckDuckGo HTML for real web results
  try {
    const html = await fetchText(`${DDG_HTML}${encodeURIComponent(query)}`);
    const webResults = parseDDGHTML(html);
    results.push(...webResults.slice(0, maxResults - results.length).map(r => ({ ...r, source: 'web' })));
  } catch {}

  return {
    query,
    results: results.slice(0, maxResults),
    count: results.length,
  };
}

export async function fetchURL(url, { maxLength = 15000 } = {}) {
  printTool(`Fetching: ${url}`);
  try {
    const html = await fetchText(url);
    let text = stripHTML(html);
    // Try to extract main content
    const mainMatch = html.match(/<main[\s\S]*?<\/main>/i) ||
                      html.match(/<article[\s\S]*?<\/article>/i) ||
                      html.match(/<div[^>]*(?:class|id)=["'][^"']*content[^"']*["'][\s\S]*?<\/div>/i);
    if (mainMatch) text = stripHTML(mainMatch[0]);

    return {
      url,
      content: text.slice(0, maxLength),
      length: text.length,
      truncated: text.length > maxLength,
    };
  } catch (e) {
    return { error: e.message, url };
  }
}

// ── StackOverflow quick-answer ────────────────────────────────────────────────
export async function searchStackOverflow(query, { maxResults = 3 } = {}) {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&q=${encodeURIComponent(query)}&site=stackoverflow&filter=withbody&pagesize=${maxResults}`;
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    const data = await resp.json();
    return {
      results: (data.items || []).map(item => ({
        title: item.title,
        url: item.link,
        score: item.score,
        answers: item.answer_count,
        accepted: item.is_answered,
        body: stripHTML(item.body || '').slice(0, 1000),
      })),
    };
  } catch (e) {
    return { error: e.message };
  }
}
