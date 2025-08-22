// index.js
// Node 18+ required (uses global fetch).
// Starts a tiny HTTP server exposing /scan?url=https://example.com returning JSON.
// Implements all 11 requested checks.
// Start with: node index.js

const http = require('http');
const { URL: NodeURL } = require('url');
const { setTimeout: delay } = require('timers/promises');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;

const DEFAULT_TIMEOUT_MS = 15000;
const CONCURRENCY = 8;
const MAX_SITEMAPS = 50;
const MAX_SAMPLE = 100;
const EXPECTED_SCHEMA_TYPES = ['WebSite', 'FAQPage', 'HowTo', 'Article', 'SearchAction'];

const USER_AGENTS = {
  GPTBot: 'Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)',
  PerplexityBot: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://www.perplexity.ai/bot)',
  Googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Google-Extended':
    'Mozilla/5.0 (compatible; Google-Extended/1.0; +https://developers.google.com/search/blog/2023/09/google-extended)',
  Default: 'Mozilla/5.0 (AI Visibility Scanner; +https://example.com/ai-scanner)'
};

// -- all your function code (unchanged), except for fixed template string mistakes! --

// ... (leave all unchanged EXCEPT string interpolation and template corrections below!) ...

// When building summaries and recommendations:
const blockedBots = ['GPTBot', 'PerplexityBot', 'Googlebot', 'Google-Extended'].filter(
  (b) => report.checks.robotsTxt.bots[b] && !report.checks.robotsTxt.bots[b].allowedAtRoot
);
if (blockedBots.length === 0) report.summary.push('Robots.txt allows all checked AI bots at root.');
else report.summary.push(`Robots.txt blocks: ${blockedBots.join(', ')} at root.`);

if (report.checks.cloudflare.usingCloudflare) {
  const blockedLikely = Object.entries(report.checks.cloudflare.botAccess)
    .filter(([, v]) => v.blockedLikely)
    .map(([k]) => k);
  report.summary.push('Cloudflare detected.');
  if (blockedLikely.length) report.summary.push(`Potential bot blocking: ${blockedLikely.join(', ')}`);
} else {
  report.summary.push('No Cloudflare signatures detected.');
}

report.summary.push(report.checks.sitemap.found ? 'Sitemap found.' : 'No sitemap discovered.');
report.summary.push(
  `Sitemap URL health: ${report.checks.sitemapUrlStatuses.okCount}/${report.checks.sitemapUrlStatuses.testedCount} OK`
);
report.summary.push(
  report.checks.metaNoindex.count > 0
    ? `Noindex found on ${report.checks.metaNoindex.count} pages.`
    : 'Noindex not detected on sampled pages.'
);
report.summary.push(report.checks.llmTxt.present ? 'llm.txt present.' : 'llm.txt not found.');
if (report.checks.schema.anySchema) {
  report.summary.push(`Schema types detected: ${report.checks.schema.distinctTypes.slice(0, 10).join(', ')}`);
  if (report.checks.schema.richResultsEligibleAny) report.summary.push('Rich results likely possible (heuristic).');
} else {
  report.summary.push('No schema markup detected.');
}

const blockedLikely = Object.entries(report.checks.cloudflare.botAccess)
  .filter(([, v]) => v.blockedLikely)
  .map(([k]) => k);
if (blockedBots.length) report.recommendations.push(`Update robots.txt to allow: ${blockedBots.join(', ')}`);
if (blockedLikely.length) {
  report.recommendations.push(
    `Review Cloudflare/Sec rules for these UAs: ${blockedLikely.join(', ')} (403/401/429/503 observed).`
  );
}
if (!report.checks.sitemap.found) report.recommendations.push('Add a sitemap.xml and reference it in robots.txt.');
if (report.checks.schema.expectedMissing.length)
  report.recommendations.push(`Add/complete structured data: ${report.checks.schema.expectedMissing.join(', ')}`);
if (report.checks.metaNoindex.count > 0)
  report.recommendations.push('Remove unintended noindex directives from indexable pages.');
if (!report.checks.llmTxt.present) report.recommendations.push('Optionally add /llm.txt to declare AI crawling preferences.');
if (report.checks.sitemapUrlStatuses.errorsCount > 0)
  report.recommendations.push('Fix non-200 pages listed in sitemap to ensure indexability.');

// -- toLegacyResponse needs the same style for any lines using ${} --

function toLegacyResponse(report) {
  const bots = ['GPTBot', 'PerplexityBot', 'Googlebot', 'Google-Extended'];
  const robotsTxt = report.checks.robotsTxt;
  const robotsStr = bots
    .map((b) => `${b}: ${robotsTxt.bots[b]?.allowedAtRoot ? 'Allowed' : 'Blocked'}`)
    .join(', ');

  const noindexCount = report.checks.metaNoindex.count;
  const nofollowCount = report.checks.metaNofollow.count;

  const cf = report.checks.cloudflare;
  const blockedLikely = Object.entries(cf.botAccess)
    .filter(([, v]) => v.blockedLikely)
    .map(([k]) => k);
  const botProtectionStr = cf.usingCloudflare
    ? `Cloudflare detected. Bot statuses: ${Object.entries(cf.botAccess)
        .map(([k, v]) => `${k} ${v.status}`)
        .join(', ')}${blockedLikely.length ? `; Potentially blocked: ${blockedLikely.join(', ')}` : ''}`
    : 'No Cloudflare signatures detected.';

  const schemas = report.checks.schema.distinctTypes;
  const missingSchemas = report.checks.schema.expectedMissing;

  return {
    robots_txt: robotsStr,
    meta_noindex: noindexCount > 0 ? `Found on ${noindexCount} page(s)` : 'None found',
    meta_nofollow: nofollowCount > 0 ? `Found on ${nofollowCount} page(s)` : 'None found',
    bot_protection: botProtectionStr,
    schemas,
    missing_schemas: missingSchemas,
    details: report
  };
}

// And also update where you print your listening message:
.listen(PORT, () => {
  console.log(`AI Visibility Scanner listening on :${PORT}`);
});

