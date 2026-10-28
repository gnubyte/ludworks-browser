// Content blocker: filter parsing, request matching, cosmetic selection, scriptlet arguments, lists,
// and matcher performance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, Engine, requestContext, matchRequest, cosmeticFor, genericSelectors, docFlags, stripParams, cspFor, hostInfo, urlHost } from '../build/app/main/blocker/engine.js';
import { parseNetworkFilter, parseCosmeticFilter, parseScriptletArgs, parseScriptletCall, listLines, genericKey, filterKey, normalizeNetworkLine, TYPE, DOC, RESOURCE_TYPES } from '../build/app/main/blocker/filters.js';
import { parseExpires, CATALOG } from '../build/app/main/blocker/lists.js';
import { parseProcedural } from '../src/preload/features/blocker-procedural.js';

const engines = (text) => [new Engine(compile([{ id: 't', text }]))];
const verdict = (e, url, type = 'script', doc = 'https://page.example/', method = 'GET') => matchRequest(e, requestContext(url, RESOURCE_TYPES[type], doc, method));
const blocked = (e, ...a) => {
  const v = verdict(e, ...a);
  return !!(v && v.block);
};

test('network: hostname anchors and the ^ separator', () => {
  const e = engines('||ads.example.com^\n||example.org/ad^\n/banner^\n||cdn.example.net/path/');
  assert.ok(blocked(e, 'https://ads.example.com/x.js'));
  assert.ok(blocked(e, 'https://ads.example.com:8080/x.js'));
  assert.ok(blocked(e, 'https://sub.ads.example.com/'));
  assert.ok(blocked(e, 'wss://ads.example.com/socket', 'webSocket'));
  assert.ok(!blocked(e, 'https://ads.example.com.evil.net/'));
  assert.ok(!blocked(e, 'https://notads.example.com/'));
  assert.ok(!blocked(e, 'https://example.com/?u=ads.example.com'), 'hostname anchor must not match in the query');
  assert.ok(blocked(e, 'https://example.org/ad?x=1'));
  assert.ok(blocked(e, 'https://example.org/ad'));
  assert.ok(!blocked(e, 'https://example.org/ad.js'), '. is not a separator');
  assert.ok(!blocked(e, 'https://example.org/adverts'));
  assert.ok(blocked(e, 'https://x.com/banner/1.png', 'image'));
  assert.ok(blocked(e, 'https://x.com/banner', 'image'), '^ matches the end of the URL');
  assert.ok(!blocked(e, 'https://x.com/banners', 'image'));
  assert.ok(blocked(e, 'https://cdn.example.net/path/a.js'));
  assert.ok(blocked(e, 'https://a.cdn.example.net/path/a.js'));
  assert.ok(!blocked(e, 'https://cdn.example.net/other/path/a.js'));
  assert.ok(!blocked(e, 'https://xcdn.example.net/path/a.js'));
});

test('network: start/end anchors, wildcards, plain substrings, case', () => {
  const e = engines('|https://track.\nswf|\n/ads/*/banner\n-ad-banner-\n/AdServe/$match-case');
  assert.ok(blocked(e, 'https://track.foo.com/p.gif', 'image'));
  assert.ok(!blocked(e, 'https://x.com/?u=https://track.foo.com', 'image'));
  assert.ok(blocked(e, 'https://x.com/a.swf', 'object'));
  assert.ok(!blocked(e, 'https://x.com/a.swf?x', 'object'));
  assert.ok(blocked(e, 'https://x.com/ads/1/2/banner.png', 'image'));
  assert.ok(!blocked(e, 'https://x.com/ads/banner.png', 'image'), '* needs the second slash');
  assert.ok(blocked(e, 'https://x.com/img/top-ad-banner-1.png', 'image'));
  assert.ok(blocked(e, 'https://X.COM/IMG/TOP-AD-BANNER-1.PNG', 'image'), 'patterns are case-insensitive');
  assert.ok(blocked(e, 'https://x.com/AdServe/x.js'));
  assert.ok(!blocked(e, 'https://x.com/adserve/x.js'), '$match-case');
});

test('network: exceptions, $important and $badfilter', () => {
  const e = engines(['||ads.com^', '@@||ads.com/ok.js', '||strong.com^$important', '@@||strong.com^', '||bad.com^', '||bad.com^$badfilter', '||x.com/a$script,third-party', '||x.com/a$third-party,script,badfilter'].join('\n'));
  assert.ok(blocked(e, 'https://ads.com/ad.js'));
  const v = verdict(e, 'https://ads.com/ok.js');
  assert.equal(v.block, false);
  assert.equal(v.filter, '@@||ads.com/ok.js');
  assert.ok(blocked(e, 'https://strong.com/x.js'), '$important beats exceptions');
  assert.ok(!blocked(e, 'https://bad.com/x.js'), 'badfilter removes the plain host filter');
  assert.ok(!blocked(e, 'https://x.com/a.js', 'script', 'https://other.org/'), 'badfilter matches whatever the option order');
  assert.equal(filterKey('||x.com/a$third-party,script,badfilter'), filterKey('||x.com/a$script,third-party'));
});

test('network: exceptions in one engine apply to blocks from another (my filters vs lists)', () => {
  const lists = new Engine(compile([{ id: 'l', text: '||tracker.net^' }]));
  const mine = new Engine(compile([{ id: 'user', text: '@@||tracker.net/needed.js$script' }]));
  assert.ok(blocked([lists, mine], 'https://tracker.net/t.js'));
  assert.ok(!blocked([lists, mine], 'https://tracker.net/needed.js'));
});

test('network: party, types, domain=, denyallow=, to=, method=', () => {
  const e = engines(
    [
      '||cdn.tracker.com^$third-party',
      '||pixel.site.com^$1p',
      '||img.ads.net^$image',
      '||nojs.net^$~script',
      '||x.com/a.js$domain=foo.com|~bar.foo.com',
      '||y.com/b.js$domain=google.*',
      '*$script,3p,denyallow=cdn.com|static.org,domain=site.com',
      '||api.z.com^$xhr,method=post',
      '/collect$ping,to=analytics.io|~safe.analytics.io',
    ].join('\n'),
  );
  assert.ok(blocked(e, 'https://cdn.tracker.com/t.js', 'script', 'https://news.org/'));
  assert.ok(!blocked(e, 'https://cdn.tracker.com/t.js', 'script', 'https://www.tracker.com/'), 'same registrable domain = first party');
  assert.ok(blocked(e, 'https://pixel.site.com/p.gif', 'image', 'https://www.site.com/'));
  assert.ok(!blocked(e, 'https://pixel.site.com/p.gif', 'image', 'https://other.com/'));
  assert.ok(blocked(e, 'https://img.ads.net/1.png', 'image'));
  assert.ok(!blocked(e, 'https://img.ads.net/1.js', 'script'));
  assert.ok(blocked(e, 'https://nojs.net/1.png', 'image'));
  assert.ok(!blocked(e, 'https://nojs.net/1.js', 'script'));
  assert.ok(blocked(e, 'https://x.com/a.js', 'script', 'https://foo.com/'));
  assert.ok(blocked(e, 'https://x.com/a.js', 'script', 'https://www.foo.com/'));
  assert.ok(!blocked(e, 'https://x.com/a.js', 'script', 'https://bar.foo.com/'));
  assert.ok(!blocked(e, 'https://x.com/a.js', 'script', 'https://foo.org/'));
  assert.ok(blocked(e, 'https://y.com/b.js', 'script', 'https://www.google.co.uk/'), 'entity google.*');
  assert.ok(blocked(e, 'https://y.com/b.js', 'script', 'https://google.de/'));
  assert.ok(!blocked(e, 'https://y.com/b.js', 'script', 'https://notgoogle.de/'));
  assert.ok(blocked(e, 'https://evil.net/x.js', 'script', 'https://site.com/'));
  assert.ok(!blocked(e, 'https://a.cdn.com/x.js', 'script', 'https://site.com/'), 'denyallow');
  assert.ok(!blocked(e, 'https://evil.net/x.js', 'script', 'https://elsewhere.com/'));
  assert.ok(blocked(e, 'https://api.z.com/v1', 'xhr', 'https://p.com/', 'POST'));
  assert.ok(!blocked(e, 'https://api.z.com/v1', 'xhr', 'https://p.com/', 'GET'));
  assert.ok(blocked(e, 'https://www.analytics.io/collect', 'ping'));
  assert.ok(!blocked(e, 'https://safe.analytics.io/collect', 'ping'));
});

test('network: regex filters (indexed by their literal tokens when possible)', () => {
  const e = engines(['/^https?:\\/\\/[a-z]{8}\\.xyz\\/ad\\//$script', '/\\/pagead\\d+\\.js$/', '/(?:foo|bar)\\.click\\//$image'].join('\n'));
  assert.ok(blocked(e, 'https://abcdefgh.xyz/ad/x.js'));
  assert.ok(!blocked(e, 'https://abcdefg.xyz/ad/x.js'));
  assert.ok(!blocked(e, 'https://abcdefgh.xyz/ad/x.js', 'image'));
  assert.ok(blocked(e, 'https://x.com/pagead12.js'));
  assert.ok(!blocked(e, 'https://x.com/pagead12.js?x'));
  assert.ok(blocked(e, 'https://x.com/bar.click/a.png', 'image'));
  // compile: the first regex is filed under a literal token, not in the scan-always bucket
  const c = compile([{ id: 'r', text: '/^https?:\\/\\/[a-z]{8}\\.xyz\\/ad\\//$script' }]);
  assert.equal(c.net.block.any, '');
  assert.ok(c.net.block.tokens.some(([k]) => k === 'ad' || k === 'xyz'));
});

test('network: strict blocking of documents, $document page exceptions', () => {
  const e = engines(['||evil.com^', '||onlyjs.com^$script', '||x.com/path', '@@||trusted.com^$document', '@@||nocos.com^$generichide', '@@||quiet.com^$elemhide', '||malware.org/dl.exe^$document'].join('\n'));
  assert.ok(blocked(e, 'https://evil.com/', 'mainFrame', ''));
  assert.ok(blocked(e, 'https://www.evil.com/page', 'mainFrame', ''));
  assert.ok(!blocked(e, 'https://onlyjs.com/', 'mainFrame', ''));
  assert.ok(!blocked(e, 'https://x.com/path/page', 'mainFrame', ''), 'path filters do not block pages');
  assert.ok(blocked(e, 'https://x.com/path/a.js'));
  assert.ok(blocked(e, 'https://malware.org/dl.exe', 'mainFrame', ''));
  assert.ok(!blocked(e, 'https://malware.org/dl.exe', 'script'));
  assert.equal(docFlags(e, 'https://www.trusted.com/a') & DOC.DOCUMENT, DOC.DOCUMENT);
  assert.equal(docFlags(e, 'https://nocos.com/'), DOC.GENERICHIDE);
  assert.equal(docFlags(e, 'https://quiet.com/'), DOC.ELEMHIDE);
  assert.equal(docFlags(e, 'https://other.com/'), 0);
});

test('network: $redirect blocks, $redirect-rule alone does not, $removeparam, $csp', () => {
  const e = engines(['||ga.com/analytics.js$script,redirect=google-analytics_analytics.js:5', '||img.ads.com^$image,redirect=1x1.gif', '*$script,redirect-rule=noopjs,domain=page.example', '@@||img.ads.com/ok.png$redirect', '$removeparam=utm_source', '$removeparam=/^fbclid=/', '||shop.com^$csp=worker-src \'none\''].join('\n'));
  assert.ok(blocked(e, 'https://ga.com/analytics.js'));
  assert.ok(blocked(e, 'https://img.ads.com/1.png', 'image'));
  assert.ok(blocked(e, 'https://img.ads.com/ok.png', 'image'), '@@…$redirect only disables a redirect, never the block');
  assert.ok(!blocked(e, 'https://any.example/x.js', 'script', 'https://page.example/'), 'redirect-rule never blocks by itself');
  const ctx = requestContext('https://news.com/a?id=1&utm_source=x&fbclid=abc#top', TYPE.DOCUMENT, '');
  assert.equal(stripParams(e, ctx), 'https://news.com/a?id=1#top');
  assert.equal(stripParams(e, requestContext('https://news.com/a?id=1', TYPE.DOCUMENT, '')), null);
  assert.deepEqual(cspFor(e, requestContext('https://shop.com/', TYPE.DOCUMENT, '')), ["worker-src 'none'"]);
});

test('network: unsupported options drop the whole filter (never broaden it)', () => {
  assert.equal(parseNetworkFilter('||example.com^$inline-script'), null);
  assert.equal(parseNetworkFilter('||example.com^$popup'), null);
  assert.equal(parseNetworkFilter('||example.com^$header=x-foo'), null);
  assert.equal(parseNetworkFilter('||example.com^$unknownoption'), null);
  assert.equal(parseNetworkFilter('$script'), null, 'an empty pattern needs a domain= or similar');
  assert.ok(parseNetworkFilter('||example.com^$doc,popup'));
  const f = parseNetworkFilter('||example.com^$removeparam=/^(utm_|fb)\\w+$/');
  assert.equal(f.removeparam, '/^(utm_|fb)\\w+$/');
  assert.equal(parseNetworkFilter('/ads/').pattern, '/ads/', '/ads/ without regex characters is a path');
  assert.equal(parseNetworkFilter('/ad[sv]/').regex, 'ad[sv]');
  assert.equal(normalizeNetworkLine('tracker.example.com'), '||tracker.example.com^');
  assert.equal(normalizeNetworkLine('ads.js'), 'ads.js');
});

test('cosmetic: specific, generic, exceptions, entities, procedural, scriptlets', () => {
  const e = engines(
    [
      '##.ad-banner',
      '###sponsor-box',
      '##a[href^="https://ads."]',
      'example.com##.promo',
      'sub.example.com#@#.promo',
      'example.com#@#.ad-banner',
      '~example.com##.only-elsewhere',
      'google.*##.g-ads',
      'example.com##.post:has-text(Sponsored)',
      'example.com##.bar:style(margin-top: 0 !important)',
      'example.com##+js(set-constant, adsEnabled, false)',
      'example.com##+js(aopr, detectAdblock)',
      'quiet.example.com#@#+js()',
      'example.com##div:has(> .label)',
    ].join('\n'),
  );
  const r = cosmeticFor(e, 'www.example.com', 0);
  assert.match(r.css, /\.promo\{display:none!important\}/);
  assert.match(r.css, /div:has\(> \.label\)\{display:none!important\}/, 'native :has() stays CSS');
  assert.match(r.css, /\.bar\{margin-top: 0 !important\}/);
  assert.match(r.css, /a\[href\^="https:\/\/ads\."\]\{display:none!important\}/, 'highly generic selectors are always injected');
  assert.deepEqual(r.procedural, ['.post:has-text(Sponsored)']);
  assert.deepEqual(r.scriptlets, [['set-constant', 'adsEnabled', 'false'], ['abort-on-property-read', 'detectAdblock']]);
  assert.equal(r.generic, true);
  assert.deepEqual(genericSelectors(e, ['.ad-banner', '#sponsor-box', '.nothing'], r.exceptions), ['#sponsor-box'], 'example.com#@#.ad-banner');
  assert.deepEqual(genericSelectors(e, ['.ad-banner'], cosmeticFor(e, 'other.org', 0).exceptions), ['.ad-banner']);
  assert.deepEqual(genericSelectors(e, ['.only-elsewhere'], cosmeticFor(e, 'other.org', 0).exceptions), ['.only-elsewhere']);
  assert.deepEqual(genericSelectors(e, ['.only-elsewhere'], r.exceptions), [], '~example.com');
  assert.doesNotMatch(cosmeticFor(e, 'sub.example.com', 0).css, /\.promo\{/, 'sub.example.com#@#.promo');
  assert.doesNotMatch(cosmeticFor(e, 'other.org', 0).css, /\.promo\{/);
  assert.match(cosmeticFor(e, 'www.google.co.uk', 0).css, /\.g-ads\{/, 'entity');
  assert.deepEqual(cosmeticFor(e, 'quiet.example.com', 0).scriptlets, [], '#@#+js() disables every scriptlet');
  const gh = cosmeticFor(e, 'www.example.com', DOC.GENERICHIDE);
  assert.equal(gh.generic, false);
  assert.doesNotMatch(gh.css, /ads\./);
  assert.match(gh.css, /\.promo\{/);
  assert.equal(cosmeticFor(e, 'www.example.com', DOC.ELEMHIDE).css, '');
  assert.equal(cosmeticFor(e, 'www.example.com', DOC.SPECIFICHIDE).scriptlets.length, 0);
});

test('cosmetic: parser details', () => {
  assert.equal(genericKey('.ad-box > div'), '.ad-box');
  assert.equal(genericKey('div.sponsored.big'), '.sponsored');
  assert.equal(genericKey('ins#ad.x'), '#ad');
  assert.equal(genericKey('a[href*="ads"]'), null);
  assert.equal(genericKey(':not(.x) .y'), null);
  assert.equal(parseCosmeticFilter('example.com##^script:has-text(ads)'), null, 'HTML filters are not supported');
  assert.equal(parseCosmeticFilter('example.com#%#window.x=1'), null, 'AdGuard JS is never run');
  assert.equal(parseCosmeticFilter('example.com##+js(trusted-set-cookie, a, b)'), null, 'trusted scriptlets are not run');
  assert.equal(parseCosmeticFilter('example.com##body{background:red}').kind, 'style', '`selector {declarations}` spelling');
  assert.equal(parseCosmeticFilter('example.com##a{b}c{d}'), null);
  assert.equal(parseCosmeticFilter('##body{background:red}'), null, 'generic styles are not allowed');
  assert.equal(parseCosmeticFilter('##.x:has-text(foo)'), null, 'generic procedural filters are not allowed');
  assert.equal(parseCosmeticFilter('example.com##.x:style(background: url(https://evil/))'), null);
  assert.equal(parseCosmeticFilter('example.com##.banner {height: 0 !important}').body, '.banner{height: 0 !important}');
  const p = parseCosmeticFilter('a.com,~b.a.com,c.*##.x:-abp-has(.y)');
  assert.deepEqual([p.hosts, p.notHosts, p.body, p.kind], [['a.com', 'c.*'], ['b.a.com'], '.x:has(.y)', 'hide']);
  assert.equal(parseCosmeticFilter('||example.com/#ad'), null, 'URL fragments are network filters');
  // unreadable hostnames must never turn a specific filter into a generic one
  assert.deepEqual(parseCosmeticFilter('voe.sx>>,s.to>>,~twitter.com##+js(set, console.clear, undefined)').hosts, ['voe.sx', 's.to']);
  assert.equal(parseCosmeticFilter('bad_host!,~x.com##+js(nowoif)'), null);
  assert.equal(parseCosmeticFilter('bad_host!##.ad'), null);
  assert.equal(parseNetworkFilter('||x.com^$domain=bad_host!|~y.com'), null);
  const real = compile([{ id: 'r', text: 'voe.sx>>,~twitter.com##+js(nowoif)\nbad_host!##+js(nowoif)' }]);
  assert.equal(real.cosmetic.genericJs, '', 'no scriptlet may become generic');
});

test('procedural selectors parse into operator chains', () => {
  const t = parseProcedural('.feed > div:has-text(/Sponsored|Promoted/i):upward(2) .x:remove()');
  assert.equal(t.prefix, '.feed > div');
  assert.deepEqual(
    t.steps.map((s) => [s.op, s.arg]),
    [
      ['has-text', '/Sponsored|Promoted/i'],
      ['upward', '2'],
      ['spath', ' .x'],
    ],
  );
  assert.equal(t.action.op, 'remove');
  const n = parseProcedural('article:not(:has-text(Ad)):has(span:matches-css(display: block))');
  assert.equal(n.prefix, 'article');
  assert.deepEqual(n.steps.map((s) => s.op), ['not', 'has']);
  assert.equal(n.steps[1].sub.prefix, 'span');
  assert.equal(parseProcedural('div:has(> .a)').prefix, 'div:has(> .a)', 'plain :has() stays CSS');
  assert.equal(parseProcedural('.x:style(color: red)').action.op, 'style');
  assert.equal(parseProcedural('.x:has-text(a)').action.op, 'hide');
});

test('scriptlet arguments: quoting, escaped commas, aliases', () => {
  assert.deepEqual(parseScriptletArgs('set-constant, a.b, false'), ['set-constant', 'a.b', 'false']);
  assert.deepEqual(parseScriptletArgs("rmnt, script, 'a, b', x"), ['rmnt', 'script', 'a, b', 'x']);
  assert.deepEqual(parseScriptletArgs('nostif, /a\\,b/, 1000'), ['nostif', '/a,b/', '1000']);
  assert.deepEqual(parseScriptletArgs('json-prune, "a b", ""'), ['json-prune', 'a b', '']);
  assert.deepEqual(parseScriptletArgs('set, x, '), ['set', 'x', '']);
  assert.deepEqual(parseScriptletArgs('aeld, /^(?:load|click)$/, /popup\\(/'), ['aeld', '/^(?:load|click)$/', '/popup\\(/']);
  assert.deepEqual(parseScriptletCall('aopr, foo'), ['abort-on-property-read', 'foo']);
  assert.deepEqual(parseScriptletCall('nano-stb.js, timeLeft, *, 0.02'), ['adjust-setTimeout', 'timeLeft', '*', '0.02']);
  assert.deepEqual(parseScriptletCall('acis, document.write, adblock'), ['abort-current-script', 'document.write', 'adblock']);
  assert.equal(parseScriptletCall('trusted-replace-xhr-response, a, b'), null);
  assert.equal(parseScriptletCall('no-such-scriptlet'), null);
});

test('lists: preprocessor, hosts files, comments, Expires', () => {
  const text = ['[Adblock Plus 2.0]', '! Title: Test', '! Expires: 12 hours', '||a.com^', '!#if env_firefox', '||firefox-only.com^', '!#else', '||not-firefox.com^', '!#endif', '!#if !cap_html_filtering', '||no-html.com^', '!#endif', '# hosts comment', '0.0.0.0 tracker.example # c', '127.0.0.1 localhost', 'example.com##.ad'].join('\n');
  assert.deepEqual([...listLines(text)], ['||a.com^', '||not-firefox.com^', '||no-html.com^', '||tracker.example^', 'example.com##.ad']);
  assert.equal(parseExpires(text), 12 * 3600 * 1000);
  assert.equal(parseExpires('! Expires: 4 days (update frequency)'), 4 * 86400 * 1000);
  assert.equal(parseExpires('! nothing'), 4 * 86400 * 1000);
  assert.equal(parseExpires('! Expires: 1 hours'), 2 * 3600 * 1000, 'clamped');
  for (const c of CATALOG) for (const u of c.urls) assert.match(u, /^https:\/\//, c.id);
  assert.deepEqual(
    CATALOG.filter((c) => c.on).map((c) => c.id),
    ['ublock-filters', 'ublock-badware', 'ublock-privacy', 'ublock-quick-fixes', 'ublock-unbreak', 'easylist', 'easyprivacy', 'urlhaus-1', 'plowe-0'],
  );
});

test('hostnames: suffixes, entities, URL host parsing', () => {
  assert.deepEqual(hostInfo('a.b.example.co.uk').entities, ['a.b.example.*', 'b.example.*', 'example.*']);
  assert.equal(hostInfo('a.b.example.co.uk').domain, 'example.co.uk');
  assert.deepEqual(hostInfo('1.2.3.4').suffixes, ['1.2.3.4']);
  assert.deepEqual(urlHost('https://user:pw@Sub.Example.com:8443/p?q'), { host: 'sub.example.com', hostEnd: 31 });
  assert.equal(urlHost('http://[::1]:8080/').host, '[::1]');
});

test('performance: 100k filters, 10k URLs, < 0.05 ms per request', () => {
  const lines = [];
  for (let i = 0; i < 40000; i++) lines.push(`||ads${i}.tracker${i % 500}.com^`);
  for (let i = 0; i < 20000; i++) lines.push(`||cdn${i}.net^$third-party,script`);
  for (let i = 0; i < 20000; i++) lines.push(`/banner-${i}/ad^`);
  for (let i = 0; i < 10000; i++) lines.push(`||site${i % 2000}.org/path${i}/*/pixel.gif$image`);
  for (let i = 0; i < 5000; i++) lines.push(`*$script,3p,domain=pub${i}.com`);
  for (let i = 0; i < 4000; i++) lines.push(`@@||ads${i * 7}.tracker${(i * 7) % 500}.com/ok^`);
  for (let i = 0; i < 1000; i++) lines.push(`||ads.example${i}.com^$important`);
  const t0 = performance.now();
  const c = compile([{ id: 'synthetic', text: lines.join('\n') }]);
  const compileMs = performance.now() - t0;
  assert.equal(c.counts.network, 100000);
  const e = [new Engine(c)];
  const urls = [];
  for (let i = 0; i < 10000; i++) {
    switch (i % 5) {
      case 0:
        urls.push([`https://ads${i * 3}.tracker${(i * 3) % 500}.com/${i % 2 ? 'ok' : 'x'}/a.js?i=${i}`, TYPE.SCRIPT, `https://news${i % 50}.com/`]);
        break;
      case 1:
        urls.push([`https://cdn${i}.net/lib/v${i}.js`, TYPE.SCRIPT, 'https://blog.example.org/post']);
        break;
      case 2:
        urls.push([`https://static.example.com/banner-${i}/ad?x=${i}`, TYPE.IMAGE, 'https://www.example.com/']);
        break;
      case 3:
        urls.push([`https://www.site${i % 2000}.org/path${i}/a/b/pixel.gif`, TYPE.IMAGE, `https://pub${i % 5000}.com/`]);
        break;
      default:
        urls.push([`https://images.unrelated${i}.io/photos/2026/10/${i}.jpg?w=640&h=480`, TYPE.IMAGE, 'https://gallery.io/']);
    }
  }
  const pass = () => {
    const t = performance.now();
    let n = 0;
    for (const [u, ty, d] of urls) {
      const v = matchRequest(e, requestContext(u, ty, d));
      if (v && v.block) n++;
    }
    return { n, avg: (performance.now() - t) / urls.length };
  };
  // First pass: every filter group a URL touches is parsed on first use (one-time cost).
  const cold = pass();
  const warm = pass();
  console.log(`compile ${compileMs.toFixed(0)} ms; match avg: first pass ${(cold.avg * 1000).toFixed(2)} µs (incl. lazy parsing), then ${(warm.avg * 1000).toFixed(2)} µs; blocked ${warm.n}/${urls.length}`);
  assert.equal(cold.n, warm.n);
  assert.ok(warm.n > 3000 && warm.n < 10000, `plausible block count (${warm.n})`);
  assert.ok(warm.avg < 0.05, `average ${warm.avg.toFixed(4)} ms per request`);
  assert.ok(cold.avg < 0.25, `first-pass average ${cold.avg.toFixed(4)} ms per request`);
});
