import { TARGET_URLS } from './target-links.ts';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// Optional: scope the scan to just your CTA/button components instead of
// every <a>/<button> on the page. Leave as-is to scan everything.
const SELECTORS = [
  'a',
  'button',
  '[role="button"]',
  'input[type="submit"]',
  'input[type="button"]',
  // 'a.cta',
  // 'button.cta-btn',
];

// Set true to also send a live HTTP request to every "real" link and flag
// non-2xx/3xx responses as broken.
const CHECK_LIVE_STATUS = false;

/* ============================================================================
 * Detection rules — tweak these if your site has its own placeholder
 * conventions (e.g. an internal "#TODO" tag).
 * ==========================================================================*/
const PLACEHOLDER_HREF_PATTERNS = [
  /^$/,
  /^#!?$/,
  /^javascript:\s*void\(0\)/i,
  /^javascript:;?\s*$/i,
  /^tbd$/i,
  /^todo$/i,
  /example\.(com|org|net)/i,
  /lorem\s?ipsum/i,
  /placeholder/i,
  /your[-_]?link[-_]?here/i,
  /link[-_]?goes[-_]?here/i,
  /^test\.com/i,
  /^null$/i,
  /^undefined$/i,
];

const PLACEHOLDER_TEXT_PATTERNS = [
  /coming soon/i,
  /lorem ipsum/i,
  /placeholder/i,
];

/* ============================================================================
 * Helpers
 * ==========================================================================*/

function classifyHref(href) {
  if (href == null) return { isPlaceholder: true, reason: 'missing href attribute' };
  const trimmed = href.trim();
  for (const pattern of PLACEHOLDER_HREF_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { isPlaceholder: true, reason: `href matches placeholder pattern ${pattern}` };
    }
  }
  return { isPlaceholder: false, reason: null };
}

function classifyText(text) {
  if (!text) return null;
  for (const pattern of PLACEHOLDER_TEXT_PATTERNS) {
    if (pattern.test(text)) return `button text suggests placeholder (matches ${pattern})`;
  }
  return null;
}

function toAbsoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

async function getElementDescriptor(locator) {
  return locator.evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    const testId = el.getAttribute('data-testid');
    return testId ? `${tag}[data-testid="${testId}"]` : `${tag}${id}${cls}`;
  });
}

function writeReports(url, results) {
  const safeName = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 60);
  const dir = path.resolve('placeholder-link-reports');
  fs.mkdirSync(dir, { recursive: true });

  const jsonPath = path.join(dir, `${safeName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  const headers = ['tag', 'text', 'href', 'selectorPath', 'status', 'reason', 'httpStatus'];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csvLines = [headers.join(','), ...results.map((r) => headers.map((h) => escape(r[h])).join(','))];
  const csvPath = path.join(dir, `${safeName}.csv`);
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  return { jsonPath, csvPath };
}

/* ============================================================================
 * Test
 * ==========================================================================*/

for (const url of TARGET_URLS) {
  test(`CTA/button links should not be placeholders — ${url}`, async ({ page, request }) => {
    await page.goto(url, { waitUntil: 'networkidle' });

    const combinedSelector = SELECTORS.join(', ');
    const locators = await page.locator(combinedSelector).all();

    const results = [];

    for (const locator of locators) {
      let tag, text, href, selectorPath;
      try {
        tag = await locator.evaluate((el) => el.tagName.toLowerCase());
        text = (await locator.innerText().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 80);
        href = await locator.getAttribute('href').catch(() => null);
        selectorPath = await getElementDescriptor(locator);
      } catch {
        continue;
      }

      let status = 'ok';
      let reason = null;

      if (tag === 'a') {
        const hrefCheck = classifyHref(href);
        if (hrefCheck.isPlaceholder) {
          status = 'placeholder';
          reason = hrefCheck.reason;
        }
      } else {
        const hasOnclickAttr = await locator.getAttribute('onclick').catch(() => null);
        const typeAttr = await locator.getAttribute('type').catch(() => null);
        const isFormSubmit =
          tag === 'button' && typeAttr !== 'button'
            ? await locator.evaluate((el) => !!el.closest('form'))
            : typeAttr === 'submit';

        if (!hasOnclickAttr && !isFormSubmit) {
          status = 'review';
          reason = 'no href/onclick/form-submit detected (may use a JS event listener not visible in the DOM)';
        }
      }

      const textIssue = classifyText(text);
      if (textIssue) {
        if (status === 'ok') status = 'review';
        reason = reason ? `${reason}; ${textIssue}` : textIssue;
      }

      let httpStatus = null;
      if (CHECK_LIVE_STATUS && tag === 'a' && href && status === 'ok') {
        const absolute = toAbsoluteUrl(href, url);
        if (absolute && /^https?:/i.test(absolute)) {
          try {
            const response = await request.get(absolute, { timeout: 10000 });
            httpStatus = response.status();
            if (!response.ok()) {
              status = 'placeholder';
              reason = `broken link (status ${httpStatus})`;
            }
          } catch (err) {
            httpStatus = `ERROR: ${err.message}`;
            status = 'placeholder';
            reason = 'request failed';
          }
        }
      }

      results.push({ tag, text, href, selectorPath, status, reason, httpStatus });
    }

    const placeholders = results.filter((r) => r.status === 'placeholder');
    const review = results.filter((r) => r.status === 'review');
    const good = results.filter((r) => r.status === 'ok');

    const { jsonPath, csvPath } = writeReports(url, results);

    console.log(`\n${'='.repeat(72)}\n${url}\n${'='.repeat(72)}`);
    console.log(`PLACEHOLDER / BROKEN LINKS (${placeholders.length})`);
    placeholders.forEach((r, i) => {
      console.log(`  ${i + 1}. [${r.tag}] "${r.text}" — ${r.selectorPath}`);
      console.log(`     href: ${r.href ?? '(none)'}  reason: ${r.reason}`);
    });
    console.log(`\nNEEDS MANUAL REVIEW (${review.length})`);
    review.forEach((r, i) => console.log(`  ${i + 1}. [${r.tag}] "${r.text}" — ${r.reason}`));
    console.log(`\nOK (${good.length})`);
    console.log(`\nFull report: ${jsonPath}\n              ${csvPath}\n`);

    // Fails the test if any hard placeholders were found. Comment this out
    // if you just want a report without failing the build.
    expect(placeholders, `Found ${placeholders.length} placeholder/broken link(s) — see console output above`).toEqual([]);
  });
}
