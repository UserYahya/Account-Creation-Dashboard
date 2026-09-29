const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validation');
const time = require('../src/time');

test('usernames are normalised like MediaWiki', () => {
  assert.equal(v.normalizeUsername('  rahim_uddin  '), 'Rahim uddin');
  assert.equal(v.normalizeUsername('a   b'), 'A b');
  assert.equal(v.normalizeUsername('রহিম উদ্দিন'), 'রহিম উদ্দিন');
  assert.equal(v.normalizeUsername(''), '');
  assert.equal(v.normalizeUsername(null), '');
});

test('username problems are explained', () => {
  assert.equal(v.usernameProblem('Good Name'), null);
  assert.ok(v.usernameProblem('ab'));
  assert.ok(v.usernameProblem('a#b c'));
  assert.ok(v.usernameProblem('user@example.com'));
  assert.ok(v.usernameProblem('192.168.1.1'));
  assert.ok(v.usernameProblem('x'.repeat(86)));
});

test('emails and wiki domains are validated', () => {
  assert.ok(v.isValidEmail('someone@gmail.com'));
  assert.ok(!v.isValidEmail('someone@gmail'));
  assert.ok(!v.isValidEmail('<b>@x.com'));
  assert.ok(!v.isValidEmail('a b@x.com'));

  assert.deepEqual(v.parseWikiList('bn.wikipedia.org, https://commons.wikimedia.org/wiki/Main, www.wikidata.org'), {
    wikis: ['bn.wikipedia.org', 'commons.wikimedia.org', 'www.wikidata.org'],
    invalid: []
  });
  assert.deepEqual(v.parseWikiList('evil.com, localhost:8080').invalid, ['evil.com', 'localhost:8080']);
  assert.ok(!v.isWikimediaDomain('wikipedia.org.evil.com'));
});

test('emails are masked for the status page', () => {
  assert.equal(v.maskEmail('student@example.com'), 'st*****@example.com');
  assert.equal(v.maskEmail('a@b.co'), 'a***@b.co');
  assert.equal(v.maskEmail(null), null);
});

test('Bangladesh time converts to and from UTC', () => {
  assert.equal(time.bdLocalToUtcIso('2026-06-18T00:00'), '2026-06-17T18:00:00.000Z');
  assert.equal(time.bdLocalToUtcIso('2026-06-18 10:30:00'), '2026-06-18T04:30:00.000Z');
  assert.equal(time.bdLocalToUtcIso('2026-06-18T10:00:00Z'), '2026-06-18T10:00:00.000Z');
  assert.equal(time.bdLocalToUtcIso('not a date'), null);
  assert.equal(time.utcIsoToBdLocal('2026-06-17T18:00:00.000Z'), '2026-06-18T00:00');
  assert.equal(time.sqliteToIso('2026-06-18 04:30:00'), '2026-06-18T04:30:00.000Z');
});

test('event phases follow the event window', () => {
  const event = { start_time: '2026-06-01T00:00:00.000Z', end_time: '2026-06-10T00:00:00.000Z', registration_active: 1 };
  assert.equal(time.eventPhase(event, new Date('2026-05-30T00:00:00Z')), 'upcoming');
  assert.equal(time.eventPhase(event, new Date('2026-06-05T00:00:00Z')), 'ongoing');
  assert.equal(time.eventPhase(event, new Date('2026-06-11T00:00:00Z')), 'finished');
  assert.equal(time.isRegistrationOpen(event, new Date('2026-06-05T00:00:00Z')), true);
  assert.equal(time.isRegistrationOpen({ ...event, registration_active: 0 }, new Date('2026-06-05T00:00:00Z')), false);
});

test('page data JSON cannot break out of its script tag', () => {
  const { pageData } = require('../src/render');
  const out = pageData({ name: '</script><script>alert(1)</script>' });
  assert.ok(!out.includes('</script>'));
  assert.deepEqual(JSON.parse(out), { name: '</script><script>alert(1)</script>' });
});
