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

// Simple concurrency limiter
function limitPool(concurrency) {
const queue = [];
let active = 0;
const next = () => {
if (active >= concurrency || queue.length === 0) return;
const job = queue.shift();
active++;
Promise.resolve()
.then(job.fn)
.then((res) => {
active--;
job.resolve(res);
next();
})
.catch((err) => {
active--;
job.reject(err);
next();
});
};
return (fn) =>
new Promise((resolve, reject) => {
queue.push({ fn, resolve, reject });
next();
});
}

async function fetchWithUA(url, ua, opts = {}) {
const controller = new AbortController();
const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
try {
const res = await fetch(url, {
method: opts.method ?? 'GET',
headers: {
'user-agent': ua,
accept: '/',
'accept-encoding': 'gzip, deflate, br'
},
redirect: 'follow',
signal: controller.signal
});
const finalUrl = res.url;
const headers = Object.fromEntries(res.headers.entries());
let body = null;
if (opts.readBody !== false) {
const buf = Buffer.from(await res.arrayBuffer());
const isGzip =
(headers['content-type'] || '').includes('gzip') ||
(headers['content-encoding'] || '').includes('gzip') ||
finalUrl.endsWith('.gz');
if (isGzip) {
try {
body = zlib.gunzipSync(buf).toString('utf8');
} catch {
body = buf.toString('utf8');
}
} else {
body = buf.toString('utf8');
}
}
return { ok: res.ok, status: res.status, url: finalUrl, headers, body };
} catch (e) {
return { ok: false, status: 0, url, headers: {}, body: null, error: e?.message || String(e) };
} finally {
clearTimeout(t);
}
}

function normalizeBase(url) {
try {
const u = new URL(url);
u.hash = '';
u.search = '';
return u.origin;
} catch {
throw new Error(Invalid URL: ${url});
}
}

// Robots.txt parsing
function parseRobots(robotsTxt) {
const lines = robotsTxt
.split(/\r?\n/)
.map((l) => l.trim())
.filter((l) => l.length > 0 && !l.startsWith('#'));

const groups = [];
let current = { agents: [], rules: [], sitemaps: [] };
const flush = () => {
if (current.agents.length > 0 || current.rules.length > 0 || current.sitemaps.length > 0) {
groups.push(current);
}
current = { agents: [], rules: [], sitemaps: [] };
};

for (const line of lines) {
const [rawKey, ...rest] = line.split(':');
if (!rawKey || rest.length === 0) continue;
const key = rawKey.trim().toLowerCase();
const value = rest.join(':').trim();
if (key === 'user-agent' || key === 'useragent') {
if (current.agents.length > 0 || current.rules.length > 0) flush();
current.agents.push(value.toLowerCase());
} else if (key === 'disallow' || key === 'allow') {
current.rules.push({ type: key, pattern: value });
} else if (key === 'sitemap') {
current.sitemaps.push(value);
}
}
flush();

for (const g of groups) {
for (const r of g.rules) {
r.regex = robotsPatternToRegex(r.pattern);
r.length = r.pattern.length;
}
}

return {
groups,
sitemaps: groups.flatMap((g) => g.sitemaps),
evaluate(userAgent, path = '/') {
const token = userAgent.toLowerCase();
let best = null;
let bestLen = -1;
for (const g of groups) {
for (const a of g.agents) {
if (!a) continue;
if (a === '' || token.includes(a)) {
const len = a === '' ? 1 : a.length;
if (len > bestLen) {
best = g;
bestLen = len;
}
}
}
}
const candidates = best ? best.rules : [];
if (candidates.length === 0) {
return { allowed: true, matchedRule: null, groupAgents: best?.agents || [''] };
}
let matched = null;
for (const r of candidates) {
if (!r.pattern) continue;
if (r.regex.test(path)) {
if (
!matched ||
r.length > matched.length ||
(r.length === matched.length && r.type === 'allow' && matched.type === 'disallow')
) {
matched = r;
}
}
}
const allowed = !matched || matched.type === 'allow';
return { allowed, matchedRule: matched, groupAgents: best ? best.agents : [''] };
},
getDisallowsForUA(userAgent) {
const token = userAgent.toLowerCase();
let best = null;
let bestLen = -1;
for (const g of groups) {
for (const a of g.agents) {
if (!a) continue;
if (a === '' || token.includes(a)) {
const len = a === '' ? 1 : a.length;
if (len > bestLen) {
best = g;
bestLen = len;
}
}
}
}
return best ? best.rules.filter((r) => r.type === 'disallow').map((r) => r.pattern) : [];
}
};
}

function robotsPatternToRegex(pattern) {
if (!pattern || pattern === '') return /^$/;
let escaped = pattern.replace(/[.+?^${}()|[]\]/g, '\$&');
escaped = escaped.replace(/\*/g, '.*');
if (escaped.endsWith('\$')) escaped = escaped.slice(0, -2) + '$';
return new RegExp('^' + escaped);
}

// Sitemap discovery and parsing
function extractSitemapLocs(xml) {
const locs = [];
const sitemapIndex = /<sitemap[^>]>[\s\S]?<loc>([\s\S]?)</loc>[\s\S]?</sitemap>/gi;
const urlset = /<url[^>]>[\s\S]?<loc>([\s\S]?)</loc>[\s\S]?</url>/gi;
let m;
while ((m = sitemapIndex.exec(xml)) !== null) locs.push(m[1].trim());
if (locs.length === 0) {
while ((m = urlset.exec(xml)) !== null) locs.push(m[1].trim());
}
return locs;
}

async function discoverSitemaps(base, robots) {
const candidates = new Set();
robots?.sitemaps?.forEach((s) => candidates.add(s));
['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap1.xml', '/sitemap.txt', '/sitemap.xml.gz'].forEach(
(p) => candidates.add(base + p)
);
const results = [];
for (const url of candidates) {
const res = await fetchWithUA(url, USER_AGENTS.Default, { timeoutMs: 8000 });
if (res.ok && res.body && res.body.includes('<loc>')) {
results.push({ url, status: res.status });
}
}
return results;
}

async function collectSitemapUrls(entryUrl, maxToCollect = MAX_SAMPLE) {
const toVisit = [entryUrl];
const visited = new Set();
const urls = new Set();

while (toVisit.length > 0 && visited.size < MAX_SITEMAPS && urls.size < maxToCollect) {
const url = toVisit.shift();
visited.add(url);
const res = await fetchWithUA(url, USER_AGENTS.Default, { timeoutMs: 15000 });
if (!res.ok || !res.body) continue;
const locs = extractSitemapLocs(res.body);
if (locs.length === 0) continue;

let indexLike = 0;
for (const loc of locs) if (/\.(xml(\.gz)?)$/i.test(loc)) indexLike++;
if (indexLike > 0 && indexLike === locs.length) {
  for (const loc of locs) if (!visited.has(loc)) toVisit.push(loc);
} else {
  for (const loc of locs) if (urls.size < maxToCollect) urls.add(loc);
}
}
return Array.from(urls);
}

// HTML/Schema helpers
function extractJsonLd(html) {
const out = [];
const scriptRegex = /<script[^>]+type=["']application/ld+json["'][^>]>([\s\S]?)</script>/gi;
let m;
while ((m = scriptRegex.exec(html)) !== null) {
const raw = m[1].trim();
try {
out.push(JSON.parse(raw));
} catch {
try {
const fixed = raw.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
out.push(JSON.parse(fixed));
} catch {
// ignore
}
}
}
return out;
}

function flattenJsonLdTypes(nodes) {
const types = [];
const items = [];
const walk = (obj) => {
if (!obj || typeof obj !== 'object') return;
if (Array.isArray(obj)) return obj.forEach(walk);
const t = obj['@type'];
if (t) {
if (Array.isArray(t)) t.forEach((x) => types.push(String(x)));
else types.push(String(t));
items.push(obj);
}
if (obj['@graph']) walk(obj['@graph']);
for (const k of Object.keys(obj)) {
if (k.startsWith('@')) continue;
walk(obj[k]);
}
};
nodes.forEach(walk);
return { types: Array.from(new Set(types)), items };
}

function extractMetaRobots(html) {
const metaRegex = /<meta[^>]+name=["']robots["'][^>]*>/gi;
const contentRegex = /content="'["']/i;
const tags = [];
let m;
while ((m = metaRegex.exec(html)) !== null) {
const tag = m[0];
const c = tag.match(contentRegex)?.[1]?.toLowerCase() || '';
tags.push(c);
}
return tags;
}

function hasMicrodataOrRdfa(html) {
return /itemscope|itemtype|itemprop|vocab=|typeof=/.test(html);
}

function evaluateStructuredData(itemsInfo) {
const { types, items } = itemsInfo;
const found = {
WebSite: false,
SearchAction: false,
FAQPage: false,
HowTo: false,
Article: false,
ArticleValid: false
};

for (const t of types) {
if (/^WebSite$/i.test(t)) found.WebSite = true;
if (/^FAQPage$/i.test(t)) found.FAQPage = true;
if (/^HowTo$/i.test(t)) found.HowTo = true;
if (/Article$/i.test(t)) found.Article = true;
}

const webSiteItems = items.filter((i) => {
const t = i['@type'];
return Array.isArray(t) ? t.includes('WebSite') : t === 'WebSite';
});
for (const ws of webSiteItems) {
const pa = ws.potentialAction || ws['potentialaction'];
if (pa) {
const arr = Array.isArray(pa) ? pa : [pa];
for (const act of arr) {
const t = act['@type'] || act['@Type'];
if (t === 'SearchAction' && act.target && act['query-input']) {
found.SearchAction = true;
}
}
}
}

const articles = items.filter((i) => {
const t = i['@type'];
return Array.isArray(t)
? t.includes('Article') || t.includes('NewsArticle') || t.includes('BlogPosting')
: t === 'Article' || t === 'NewsArticle' || t === 'BlogPosting';
});
for (const a of articles) {
const hasHeadline = !!a.headline;
const author = a.author || a.creator;
const hasAuthor = !!author && (Array.isArray(author) ? author.length > 0 : true);
const hasDates = !!(a.datePublished || a.dateCreated) && !!(a.dateModified || a.dateUpdated || a.datePublished);
if (hasHeadline && hasAuthor && hasDates) {
found.ArticleValid = true;
break;
}
}

const richResultsEligible = found.ArticleValid || found.FAQPage || found.HowTo;
return { found, richResultsEligible };
}

// Cloudflare detection
function detectCloudflare(headers) {
const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
const server = h['server'] || '';
const cfRay = h['cf-ray'];
const cfCache = h['cf-cache-status'];
const anyCf = server.toLowerCase().includes('cloudflare') || !!cfRay || !!cfCache;
return { usingCloudflare: anyCf, indicators: { server, cfRay, cfCache } };
}

// Main audit
async function runAiVisibilityAudit(baseUrl) {
const base = normalizeBase(baseUrl);
const report = {
target: base,
timestamp: new Date().toISOString(),
checks: {
robotsTxt: null,
cloudflare: null,
sitemap: null,
sitemapUrlStatuses: null,
errorsSummary: null,
metaNoindex: null,
metaNofollow: null,
llmTxt: null,
schema: null
},
summary: [],
recommendations: []
};

const robotsUrl = base + '/robots.txt';
const robotsRes = await fetchWithUA(robotsUrl, USER_AGENTS.Default);
const robotsTxt = robotsRes.ok ? robotsRes.body || '' : '';
const robotsParse = robotsTxt ? parseRobots(robotsTxt) : null;
const bots = ['GPTBot', 'PerplexityBot', 'Googlebot', 'Google-Extended'];

const robotsFindings = {
present: !!robotsTxt,
url: robotsUrl,
status: robotsRes.status,
sitemaps: robotsParse?.sitemaps || [],
bots: {}
};
for (const b of bots) {
if (!robotsParse) {
robotsFindings.bots[b] = {
allowedAtRoot: true,
disallows: [],
matchedRule: null,
note: 'No robots.txt found; default allow'
};
} else {
const evalRes = robotsParse.evaluate(b, '/');
const disallows = robotsParse.getDisallowsForUA(b);
robotsFindings.bots[b] = {
allowedAtRoot: evalRes.allowed,
disallows,
matchedRule: evalRes.matchedRule ? { type: evalRes.matchedRule.type, pattern: evalRes.matchedRule.pattern } : null,
groupAgents: evalRes.groupAgents
};
}
}
report.checks.robotsTxt = robotsFindings;

// Cloudflare + per-bot access test
const homeDefault = await fetchWithUA(base + '/', USER_AGENTS.Default, { readBody: false });
const cfDetect = detectCloudflare(homeDefault.headers);
const botAccess = {};
for (const b of bots) {
const r = await fetchWithUA(base + '/', USER_AGENTS[b], { readBody: false });
botAccess[b] = {
status: r.status,
ok: r.ok,
blockedLikely: [401, 403, 429, 503].includes(r.status)
};
await delay(100);
}
report.checks.cloudflare = { ...cfDetect, botAccess };

// Sitemap discovery
const discovered = await discoverSitemaps(base, robotsParse);
report.checks.sitemap = {
found: discovered.length > 0,
discovered
};

// Sample URLs from sitemap or homepage
const sampleTargets = [];
if (discovered.length > 0) {
const urls = await collectSitemapUrls(discovered[0].url, MAX_SAMPLE);
sampleTargets.push(...urls);
} else {
sampleTargets.push(base + '/');
}

const limiter = limitPool(CONCURRENCY);
const pageResults = [];
await Promise.all(
sampleTargets.map((u) =>
limiter(async () => {
const res = await fetchWithUA(u, USER_AGENTS.Default);
const headers = res.headers;
const html = res.body || '';
const metaTags = extractMetaRobots(html);
const xRobots = headers['x-robots-tag'] || headers['x-robots-tag'];
const hasNoindexHeader = typeof xRobots === 'string' && xRobots.toLowerCase().includes('noindex');
const hasNofollowHeader = typeof xRobots === 'string' && xRobots.toLowerCase().includes('nofollow');
const hasNoindexMeta = metaTags.some((c) => c.includes('noindex'));
const hasNofollowMeta = metaTags.some((c) => c.includes('nofollow'));
const jsonLd = extractJsonLd(html);
const itemsInfo = flattenJsonLdTypes(jsonLd);
const structured = evaluateStructuredData(itemsInfo);
const hasMicro = hasMicrodataOrRdfa(html);
pageResults.push({
url: u,
status: res.status,
ok: res.ok,
noindex: hasNoindexHeader || hasNoindexMeta,
nofollow: hasNofollowHeader || hasNofollowMeta,
xRobotsTag: xRobots || null,
metaRobots: metaTags,
schemaTypes: itemsInfo.types,
structured: structured.found,
richResultsEligible: structured.richResultsEligible,
hasMicrodataOrRdfa: hasMicro
});
})
)
);

// Status summary
const urlStatuses = pageResults.map((p) => ({ url: p.url, status: p.status, ok: p.ok }));
report.checks.sitemapUrlStatuses = {
testedCount: urlStatuses.length,
okCount: urlStatuses.filter((x) => x.ok).length,
errorsCount: urlStatuses.filter((x) => !x.ok).length,
items: urlStatuses.slice(0, 200)
};

// Error distribution
const errors = {};
for (const p of pageResults) if (!p.ok) errors[p.status] = (errors[p.status] || 0) + 1;
report.checks.errorsSummary = { byStatus: errors };

// Meta robots
const noindexed = pageResults.filter((p) => p.noindex);
const nofollowed = pageResults.filter((p) => p.nofollow);
report.checks.metaNoindex = {
foundOn: noindexed.map((x) => x.url).slice(0, 50),
count: noindexed.length
};
report.checks.metaNofollow = {
foundOn: nofollowed.map((x) => x.url).slice(0, 50),
count: nofollowed.length
};

// llm.txt
const llmUrl = base + '/llm.txt';
const llmRes = await fetchWithUA(llmUrl, USER_AGENTS.Default);
report.checks.llmTxt = {
present: llmRes.ok,
url: llmUrl,
status: llmRes.status,
sample: llmRes.body ? llmRes.body.split(/\r?\n/).slice(0, 10) : []
};

// Schema summary
const typesCount = {};
let articleValidCount = 0;
let faqCount = 0;
let howtoCount = 0;
let websiteCount = 0;
let searchActionCount = 0;

for (const p of pageResults) {
for (const t of p.schemaTypes) typesCount[t] = (typesCount[t] || 0) + 1;
if (p.structured.ArticleValid) articleValidCount++;
if (p.structured.FAQPage) faqCount++;
if (p.structured.HowTo) howtoCount++;
if (p.structured.WebSite) websiteCount++;
if (p.structured.WebSite && p.structured.SearchAction) searchActionCount++;
}

const allTypes = Array.from(new Set(pageResults.flatMap((p) => p.schemaTypes)));
const missing = EXPECTED_SCHEMA_TYPES.filter((t) => {
if (t === 'SearchAction') return searchActionCount === 0;
return !allTypes.includes(t);
});

const richEligibleAny = pageResults.some((p) => p.richResultsEligible);

report.checks.schema = {
anySchema: allTypes.length > 0 || pageResults.some((p) => p.hasMicrodataOrRdfa),
distinctTypes: allTypes,
expectedMissing: missing,
counts: {
ArticleValid: articleValidCount,
FAQPage: faqCount,
HowTo: howtoCount,
WebSite: websiteCount,
SearchAction: searchActionCount
},
richResultsEligibleAny: richEligibleAny
};

// Summary + recommendations
const blockedBots = ['GPTBot', 'PerplexityBot', 'Googlebot', 'Google-Extended'].filter(
(b) => report.checks.robotsTxt.bots[b] && !report.checks.robotsTxt.bots[b].allowedAtRoot
);
if (blockedBots.length === 0) report.summary.push('Robots.txt allows all checked AI bots at root.');
else report.summary.push(Robots.txt blocks: ${blockedBots.join(', ')} at root.);

if (report.checks.cloudflare.usingCloudflare) {
const blockedLikely = Object.entries(report.checks.cloudflare.botAccess)
.filter(([, v]) => v.blockedLikely)
.map(([k]) => k);
report.summary.push('Cloudflare detected.');
if (blockedLikely.length) report.summary.push(Potential bot blocking: ${blockedLikely.join(', ')});
} else {
report.summary.push('No Cloudflare signatures detected.');
}

report.summary.push(report.checks.sitemap.found ? 'Sitemap found.' : 'No sitemap discovered.');
report.summary.push(
Sitemap URL health: ${report.checks.sitemapUrlStatuses.okCount}/${report.checks.sitemapUrlStatuses.testedCount} OK
);
report.summary.push(
report.checks.metaNoindex.count > 0
? Noindex found on ${report.checks.metaNoindex.count} pages.
: 'Noindex not detected on sampled pages.'
);
report.summary.push(report.checks.llmTxt.present ? 'llm.txt present.' : 'llm.txt not found.');
if (report.checks.schema.anySchema) {
report.summary.push(Schema types detected: ${report.checks.schema.distinctTypes.slice(0, 10).join(', ')});
if (report.checks.schema.richResultsEligibleAny) report.summary.push('Rich results likely possible (heuristic).');
} else {
report.summary.push('No schema markup detected.');
}

const blockedLikely = Object.entries(report.checks.cloudflare.botAccess)
.filter(([, v]) => v.blockedLikely)
.map(([k]) => k);
if (blockedBots.length) report.recommendations.push(Update robots.txt to allow: ${blockedBots.join(', ')});
if (blockedLikely.length) {
report.recommendations.push(
Review Cloudflare/Sec rules for these UAs: ${blockedLikely.join(', ')} (403/401/429/503 observed).
);
}
if (!report.checks.sitemap.found) report.recommendations.push('Add a sitemap.xml and reference it in robots.txt.');
if (report.checks.schema.expectedMissing.length)
report.recommendations.push(Add/complete structured data: ${report.checks.schema.expectedMissing.join(', ')});
if (report.checks.metaNoindex.count > 0)
report.recommendations.push('Remove unintended noindex directives from indexable pages.');
if (!report.checks.llmTxt.present) report.recommendations.push('Optionally add /llm.txt to declare AI crawling preferences.');
if (report.checks.sitemapUrlStatuses.errorsCount > 0)
report.recommendations.push('Fix non-200 pages listed in sitemap to ensure indexability.');

return report;
}

// Backward-compatible response for your existing UI
function toLegacyResponse(report) {
const bots = ['GPTBot', 'PerplexityBot', 'Googlebot', 'Google-Extended'];
const robotsTxt = report.checks.robotsTxt;
const robotsStr = bots
.map((b) => ${b}: ${robotsTxt.bots[b]?.allowedAtRoot ? 'Allowed' : 'Blocked'})
.join(', ');

const noindexCount = report.checks.metaNoindex.count;
const nofollowCount = report.checks.metaNofollow.count;

const cf = report.checks.cloudflare;
const blockedLikely = Object.entries(cf.botAccess)
.filter(([, v]) => v.blockedLikely)
.map(([k]) => k);
const botProtectionStr = cf.usingCloudflare
? Cloudflare detected. Bot statuses: ${Object.entries(cf.botAccess) .map(([k, v]) => ${k} ${v.status}) .join(', ')}${blockedLikely.length ? ; Potentially blocked: ${blockedLikely.join(', ')} : ''}
: 'No Cloudflare signatures detected.';

const schemas = report.checks.schema.distinctTypes;
const missingSchemas = report.checks.schema.expectedMissing;

return {
robots_txt: robotsStr,
meta_noindex: noindexCount > 0 ? Found on ${noindexCount} page(s) : 'None found',
meta_nofollow: nofollowCount > 0 ? Found on ${nofollowCount} page(s) : 'None found',
bot_protection: botProtectionStr,
schemas,
missing_schemas: missingSchemas,
details: report
};
}

function sendJson(res, status, obj) {
const body = JSON.stringify(obj);
res.writeHead(status, {
'content-type': 'application/json; charset=utf-8',
'access-control-allow-origin': '*',
'access-control-allow-methods': 'GET, OPTIONS',
'access-control-allow-headers': 'Content-Type'
});
res.end(body);
}

http
.createServer(async (req, res) => {
if (req.method === 'OPTIONS') {
res.writeHead(204, {
'access-control-allow-origin': '*',
'access-control-allow-methods': 'GET, OPTIONS',
'access-control-allow-headers': 'Content-Type'
});
return res.end();
}

const url = new NodeURL(req.url, `http://localhost:${PORT}`);
if (url.pathname === '/scan' && req.method === 'GET') {
  const target = url.searchParams.get('url');
  if (!target) return sendJson(res, 400, { error: 'Missing url parameter' });
  try {
    const report = await runAiVisibilityAudit(target);
    const legacy = toLegacyResponse(report);
    return sendJson(res, 200, legacy);
  } catch (e) {
    return sendJson(res, 500, { error: 'Scan failed', message: e?.message || String(e) });
  }
}

res.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
res.end('Not found');
})
.listen(PORT, () => {
console.log(AI Visibility Scanner listening on :${PORT});
});
