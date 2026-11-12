// Static/build hardening checks only. No network, Firebase or production data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const config = JSON.parse(read('vercel.json'));
assert.deepEqual(Object.keys(config).sort(), ['$schema', 'headers']);
const rule = config.headers.find(item => item.source === '/(.*)');
assert(rule);
const headers = Object.fromEntries(rule.headers.map(item => [item.key.toLowerCase(), item.value]));
assert.match(headers['x-robots-tag'], /\bnoindex\b/);
assert.equal(headers['x-content-type-options'], 'nosniff');
assert.equal(headers['x-frame-options'], 'DENY');
assert.equal(headers['referrer-policy'], 'strict-origin-when-cross-origin');
assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
assert.match(headers['content-security-policy'], /object-src 'none'/);
// Do not restrict the existing Firebase, Apps Script or printer connections.
assert.doesNotMatch(headers['content-security-policy'], /(?:default-src|connect-src|script-src|upgrade-insecure-requests)/);
const html = read('public/index.html');
assert.match(html, /<meta name="robots" content="noindex, nofollow/);
assert.match(html, /<meta name="googlebot" content="noindex, nofollow/);
assert.match(html, /<div id="root"><\/div>/);
assert.match(read('.env.production'), /^GENERATE_SOURCEMAP=false$/m);
console.log('PASS static noindex and response security configuration; routes and connection policy retained.');
if (process.argv.includes('--build')) {
  const build = path.join(root, 'build');
  assert(fs.existsSync(build), 'Production build must exist');
  const walk = dir => fs.readdirSync(dir, {withFileTypes:true}).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  const files = walk(build);
  assert.equal(files.filter(file => file.endsWith('.map')).length, 0, 'No browser source maps may be deployed');
  for (const file of files.filter(file => /\.(js|css)$/.test(file))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /(?:\/\/#|\/\*#)\s*sourceMappingURL=/, 'No source-map URLs in build output');
  }
  assert.match(fs.readFileSync(path.join(build, 'index.html'), 'utf8'), /name="robots"[^>]*noindex/);
  console.log('PASS production HTML has noindex; production assets contain no source maps.');
}
