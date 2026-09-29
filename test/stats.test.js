const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, eventInput } = require('./helpers/harness');

const minutesAgo = m => new Date(Date.now() - m * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
let revid = 1000;
function edit(user, { title = 'পাতা', ns = 0, minutes = 10, sizediff = 100, isNew = false, wiki = 'bn.wikipedia.org' } = {}) {
  return { wiki, user, revid: revid++, title, ns, timestamp: minutesAgo(minutes), sizediff, new: isNew };
}

async function setup(eventOverrides = {}) {
  const t = await startApp({ ENABLE_MOCK_LOGIN: 'true' });
  const admin = t.client();
  await admin.mockLogin('Admin User');
  const created = await admin.post('/api/admin/events', eventInput(eventOverrides));
  assert.equal(created.status, 200, created.text);
  const add = await admin.post(`/api/admin/events/${created.data.id}/participants`, { usernames: 'Active Editor\nQuiet Editor' });
  assert.deepEqual(add.data.added.sort(), ['Active Editor', 'Quiet Editor']);
  return { ...t, admin, eventId: created.data.id };
}

test('contributions are counted per participant with the right metrics', async () => {
  const t = await setup();
  try {
    t.wiki.state.contribs.push(
      edit('Active Editor', { title: 'নতুন নিবন্ধ', isNew: true, sizediff: 2500 }),
      edit('Active Editor', { title: 'নতুন নিবন্ধ', sizediff: 300 }),
      edit('Active Editor', { title: 'অন্য পাতা', sizediff: -50 }),
      edit('Active Editor', { title: 'File:ছবি.jpg', ns: 6, isNew: true, sizediff: 120 }),
      edit('Active Editor', { title: 'পুরনো', minutes: 24 * 60 * 30 }), // before the event started
      edit('Quiet Editor', { title: 'অন্য পাতা', sizediff: 10 }),
      edit('Someone Else', { title: 'অন্য পাতা' }) // not a participant
    );
    const result = await t.ctx.stats.pollEvent(t.eventId);
    assert.equal(result.status, 'done', JSON.stringify(result));

    const { data } = await t.client().get(`/api/events/${t.eventId}/stats`);
    const active = data.leaderboard.find(r => r.username === 'Active Editor');
    assert.equal(active.rank, 1);
    assert.equal(active.total_edits, 4);
    assert.equal(active.articles_created, 1);
    assert.equal(active.pages_edited, 3);
    assert.equal(active.file_uploads, 1);
    assert.equal(active.bytes_added, 2920, 'only positive size changes are added');
    assert.equal(data.stats.total_participants, 2);
    assert.equal(data.stats.total_edits, 5);
    assert.equal(data.stats.pages_edited, 3, 'a page edited by two participants counts once in the total');
    assert.ok(data.stats.last_updated);
    assert.equal(data.timeline.unit, 'day');
    assert.equal(data.timeline.points.reduce((s, p) => s + p.edits, 0), 5);

    const contribs = await t.client().get(`/api/events/${t.eventId}/participants/${encodeURIComponent('Active Editor')}/contribs`);
    assert.equal(contribs.data.contributions.length, 4);
    assert.equal((await t.client().get(`/api/events/${t.eventId}/participants/Nobody/contribs`)).status, 404);
  } finally {
    await t.stop();
  }
});

test('polling asks for 50 users at a time and only for new edits afterwards', async () => {
  const t = await setup();
  try {
    const names = Array.from({ length: 120 }, (_, i) => `Bulk Editor ${i}`);
    names.forEach(n => t.wiki.state.users.add(n));
    const add = await t.admin.post(`/api/admin/events/${t.eventId}/participants`, { usernames: names });
    assert.equal(add.data.added.length, 120);
    t.wiki.state.contribs.push(edit('Bulk Editor 7', { minutes: 30 }));
    t.wiki.state.contribPageSize = 1; // force continuation handling

    t.wiki.state.requests.length = 0;
    await t.ctx.stats.pollEvent(t.eventId);
    const first = t.wiki.state.requests.filter(r => r.params.list === 'usercontribs');
    assert.ok(first.every(r => r.params.ucuser.split('|').length <= 50), 'batches of at most 50 users');
    assert.ok(first.length <= 4, `few requests for 122 users (got ${first.length})`);
    assert.equal(first[0].params.maxlag, '5', 'background requests send maxlag');
    assert.ok(first.every(r => r.method === 'POST'), 'usernames go in the POST body, not a long URL');

    t.wiki.state.contribs.push(edit('Bulk Editor 7', { minutes: 1 }), edit('Bulk Editor 8', { minutes: 1 }));
    t.wiki.state.requests.length = 0;
    await t.ctx.stats.pollEvent(t.eventId);
    const second = t.wiki.state.requests.filter(r => r.params.list === 'usercontribs');
    const firstStart = first[0].params.ucstart;
    assert.ok(second.every(r => r.params.ucstart > firstStart), 'second poll starts near the previous one');

    const { data } = await t.client().get(`/api/events/${t.eventId}/stats`);
    assert.equal(data.leaderboard.find(r => r.username === 'Bulk Editor 7').total_edits, 2, 'overlap does not double count');
    assert.equal(data.leaderboard.find(r => r.username === 'Bulk Editor 8').total_edits, 1);
  } finally {
    await t.stop();
  }
});

test('namespace filters and event changes recount the statistics', async () => {
  const t = await setup({ target_namespaces: '0' });
  try {
    t.wiki.state.contribs.push(
      edit('Active Editor', { title: 'নিবন্ধ', ns: 0 }),
      edit('Active Editor', { title: 'User:Active Editor', ns: 2 })
    );
    await t.ctx.stats.pollEvent(t.eventId);
    let { data } = await t.client().get(`/api/events/${t.eventId}/stats`);
    assert.equal(data.stats.total_edits, 1);

    const update = await t.admin.put(`/api/admin/events/${t.eventId}`, eventInput({ target_namespaces: 'all' }));
    assert.equal(update.data.statsReset, true);
    await t.ctx.stats.pollEvent(t.eventId);
    ({ data } = await t.client().get(`/api/events/${t.eventId}/stats`));
    assert.equal(data.stats.total_edits, 2);
  } finally {
    await t.stop();
  }
});

test('goals report how many participants reached them', async () => {
  const t = await setup({ goal_edits: '2' });
  try {
    t.wiki.state.contribs.push(edit('Active Editor'), edit('Active Editor'), edit('Quiet Editor'));
    await t.ctx.stats.pollEvent(t.eventId);
    const { data } = await t.client().get(`/api/events/${t.eventId}/stats`);
    assert.deepEqual(data.stats.goals, { edits: 2, articles: null, reached: 1 });
  } finally {
    await t.stop();
  }
});

test('public refresh is limited to once a minute per event', async () => {
  const t = await setup();
  try {
    const visitor = t.client();
    await visitor.get(`/event/${t.eventId}/stats`);
    const first = await visitor.post(`/api/events/${t.eventId}/refresh`);
    assert.equal(first.status, 200);
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await visitor.post(`/api/events/${t.eventId}/refresh`);
    assert.equal(second.status, 429);
    assert.ok(second.data.retryAfter > 0);
  } finally {
    await t.stop();
  }
});

test('a wiki outage is recorded without breaking the stats page', async () => {
  const t = await setup();
  try {
    t.wiki.state.down = true;
    const result = await t.ctx.stats.pollEvent(t.eventId);
    assert.equal(result.status, 'error');
    const { status, data } = await t.client().get(`/api/events/${t.eventId}/stats`);
    assert.equal(status, 200);
    assert.ok(data.stats.last_error);
  } finally {
    await t.stop();
  }
});

test('upcoming events are not polled', async () => {
  const t = await setup({ start_time: '2099-01-01T10:00', end_time: '2099-01-05T10:00' });
  try {
    const result = await t.ctx.stats.pollEvent(t.eventId);
    assert.equal(result.status, 'not_started');
  } finally {
    await t.stop();
  }
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('changing the event while a poll runs discards that poll and counts again', async () => {
  const t = await setup({ target_namespaces: 'all' });
  try {
    t.wiki.state.contribs.push(
      edit('Active Editor', { title: 'নিবন্ধ', ns: 0 }),
      edit('Active Editor', { title: 'User:Active Editor', ns: 2 })
    );
    t.wiki.state.delayMs = 150;
    const running = t.ctx.stats.pollEvent(t.eventId);
    await sleep(50);
    const update = await t.admin.put(`/api/admin/events/${t.eventId}`, eventInput({ target_namespaces: '0' }));
    assert.equal(update.data.statsReset, true);
    assert.equal((await running).status, 'reset', 'the poll that started before the change is thrown away');
    t.wiki.state.delayMs = 0;
    for (let i = 0; i < 40 && !t.db.prepare('SELECT stats_updated_at FROM events WHERE id = ?').get(t.eventId).stats_updated_at; i++) {
      await sleep(50);
    }
    const { data } = await t.client().get(`/api/events/${t.eventId}/stats`);
    assert.equal(data.stats.total_edits, 1, 'only the article namespace is counted after the change');
  } finally {
    await t.stop();
  }
});

test('a poll requested while another runs is run afterwards', async () => {
  const t = await setup();
  try {
    t.wiki.state.delayMs = 100;
    const first = t.ctx.stats.pollEvent(t.eventId);
    await sleep(20);
    // Someone joins after the running poll already read the participant list
    t.wiki.state.contribs.push(edit('Late Joiner'));
    t.db.prepare("INSERT INTO participants (event_id, username, source, added_at) VALUES (?, 'Late Joiner', 'self', ?)").run(t.eventId, new Date().toISOString());
    assert.equal((await t.ctx.stats.pollEvent(t.eventId)).status, 'busy');
    await first;
    t.wiki.state.delayMs = 0;
    let row;
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      row = (await t.client().get(`/api/events/${t.eventId}/stats`)).data.leaderboard.find(r => r.username === 'Late Joiner');
      if (row && row.total_edits === 1) break;
    }
    assert.equal(row.total_edits, 1);
  } finally {
    await t.stop();
  }
});
