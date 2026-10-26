'use strict';

/**
 * website.js
 * ──────────
 * BotForge – same-host breadth-first crawl of a business website.
 *
 * Every request and every redirect hop goes through the URL guard, so the
 * crawler can never be pointed at localhost, private networks or cloud
 * metadata endpoints.
 */

const cheerio = require('cheerio');
const { assertPublicUrl, guardedFetch } = require('../url-guard');

const USER_AGENT = 'BotForgeCatalogBot/1.0';

function stripHash(url) {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

/** Read a response body, giving up (null) once it exceeds maxBytes. */
async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared && declared > maxBytes) {
    await res.body?.cancel();
    return null;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const BLOCK_ELEMENTS = 'p, div, li, h1, h2, h3, h4, h5, h6, tr, section, article, header, main, aside, ul, ol, table, blockquote, dd, dt, pre';

/**
 * Visible page text with paragraph breaks kept, so extraction windows split
 * between products instead of mid-sentence.
 */
function pageText($) {
  $('script, style, noscript, nav, footer').remove();
  $('br').replaceWith('\n');
  $(BLOCK_ELEMENTS).each((_, el) => { $(el).prepend('\n\n').append('\n\n'); });
  return $('body').text()
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch one URL, following redirects manually and guarding every hop.
 * When lockedHost is set, a redirect to any other hostname skips the page.
 * @returns {Promise<{ url: string, html: string } | null>} null when the page is skipped
 */
async function fetchPage(url, { guard, fetchImpl, timeoutMs, maxBytes, maxRedirects }, lockedHost = null) {
  let current = url;
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (lockedHost && new URL(current).hostname !== lockedHost) return null;
    await guard(current);

    const res = await fetchImpl(current, {
      redirect: 'manual',
      signal,
      headers : { 'user-agent': USER_AGENT, accept: 'text/html' },
    });

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current).href;
      continue;
    }

    if (res.status >= 400 || !(res.headers.get('content-type') ?? '').includes('text/html')) {
      await res.body?.cancel();
      return null;
    }

    const html = await readLimited(res, maxBytes);
    return html === null ? null : { url: current, html };
  }

  return null; // too many redirects
}

/**
 * @param {string} startUrl
 * @param {{ guard?: Function, fetchImpl?: Function, maxPages?: number, maxDepth?: number,
 *           timeoutMs?: number, maxBytes?: number, maxRedirects?: number,
 *           maxDurationMs?: number }} opts
 * @returns {Promise<Array<{ url: string, text: string }>>}
 */
async function crawlSite(startUrl, opts = {}) {
  const options = {
    guard        : assertPublicUrl,
    fetchImpl    : guardedFetch,   // re-checks DNS at connect time (rebinding)
    maxPages     : 50,
    maxDepth     : 2,
    timeoutMs    : 10000,
    maxBytes     : 2 * 1024 * 1024,
    maxRedirects : 5,
    maxDurationMs: 5 * 60 * 1000,   // whole crawl; the bot's import lock is held meanwhile
    ...opts,
  };
  const startedAt = Date.now();

  // A blocked or invalid start URL is an error the owner should see.
  await options.guard(startUrl);

  let host    = new URL(startUrl).hostname;
  const start = stripHash(startUrl);
  const seen  = new Set([start]);
  const queue = [{ url: start, depth: 0 }];
  const pages = [];
  let attempts = 0;

  while (queue.length && pages.length < options.maxPages && attempts < options.maxPages * 3
         && Date.now() - startedAt < options.maxDurationMs) {
    const { url, depth } = queue.shift();
    attempts += 1;

    let fetched;
    try {
      // only the start URL may redirect to another hostname (shop.com → www.shop.com)
      fetched = await fetchPage(url, options, attempts === 1 ? null : host);
    } catch {
      fetched = null; // guard rejection, timeout or network error: skip this page
    }
    if (!fetched) continue;

    // shop.com → www.shop.com is the same site: crawl the host the start URL landed on
    if (attempts === 1) host = new URL(fetched.url).hostname;

    seen.add(stripHash(fetched.url));
    const $ = cheerio.load(fetched.html);
    const text = pageText($);
    if (text) pages.push({ url: fetched.url, text });

    if (depth >= options.maxDepth) continue;
    $('a[href]').each((_, el) => {
      let next;
      try {
        next = new URL($(el).attr('href'), fetched.url);
      } catch {
        return;
      }
      if ((next.protocol !== 'http:' && next.protocol !== 'https:') || next.hostname !== host) return;
      const key = stripHash(next.href);
      if (seen.has(key)) return;
      seen.add(key);
      queue.push({ url: key, depth: depth + 1 });
    });
  }

  return pages;
}

module.exports = { crawlSite };
