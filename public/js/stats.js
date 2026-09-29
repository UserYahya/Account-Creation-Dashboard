// Public event statistics: summary, goals, edits-over-time chart,
// sortable leaderboard and each participant's contributions.
(function () {
  'use strict';
  const { api, esc, icon, pageData, setBusy, toast, formatDate, formatNumber, formatBytes, timeAgo, openModal } = window.App;
  const page = pageData();
  const $ = id => document.getElementById(id);

  const NAMESPACES = { 0: 'নিবন্ধ', 1: 'আলাপ', 2: 'ব্যবহারকারী', 4: 'প্রকল্প', 6: 'ফাইল', 10: 'টেমপ্লেট', 14: 'বিষয়শ্রেণী', 118: 'খসড়া', 828: 'মডিউল' };
  $('namespaceText').textContent = page.targetNamespaces === 'all'
    ? 'সকল'
    : page.targetNamespaces.split(',').map(n => NAMESPACES[n] || n).join(', ');

  let stats = null;
  let rows = [];
  let event = null;
  let sortKey = 'total_edits';
  let sortDir = 'desc';

  // "2026-06-18T10" (Bangladesh hour) or "2026-06-18" (day) -> ISO time
  function bucketToIso(bucket, unit) {
    return unit === 'hour' ? `${bucket}:00:00+06:00` : `${bucket}T00:00:00+06:00`;
  }
  function bucketLabel(bucket, unit) {
    const iso = bucketToIso(bucket, unit);
    // Hourly labels carry the date too, since an event can span several days
    const opts = unit === 'hour' ? { day: 'numeric', month: 'numeric', hour: 'numeric' } : { month: 'short', day: 'numeric' };
    return new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', ...opts }).format(new Date(iso));
  }

  const updateChart = window.App.timeChart($('chart'), {
    label: 'সময়ের সাথে সম্পাদনার সংখ্যা',
    formatValue: formatNumber,
    emptyText: 'এখনো কোনো সম্পাদনা গণনা হয়নি।'
  });

  function renderSummary() {
    const s = stats;
    const set = (key, text) => { document.querySelector(`[data-stat="${key}"]`).textContent = text; };
    set('participants', formatNumber(s.total_participants));
    document.querySelector('[data-stat-sub="participants"]').textContent = s.total_participants
      ? `${formatNumber(s.active_participants)} জন সক্রিয়`
      : '';
    set('edits', formatNumber(s.total_edits));
    set('articles', formatNumber(s.articles_created));
    set('pages', formatNumber(s.pages_edited));
    set('uploads', formatNumber(s.file_uploads));
    set('bytes', formatBytes(s.bytes_added));

    $('lastUpdated').textContent = s.refreshing
      ? 'পরিসংখ্যান এখন হালনাগাদ হচ্ছে...'
      : s.last_updated ? `সর্বশেষ হালনাগাদ: ${timeAgo(s.last_updated)} (${formatDate(s.last_updated, 'time')})` : 'এখনো হালনাগাদ হয়নি';

    const errorBox = $('statsError');
    errorBox.hidden = !(page.isAdmin && s.last_error);
    if (s.last_error) errorBox.querySelector('p').textContent = `সর্বশেষ হালনাগাদে সমস্যা হয়েছে: ${s.last_error}`;

    const goals = s.goals;
    $('goalCard').hidden = !goals || s.total_participants === 0;
    if (goals && s.total_participants > 0) {
      const parts = [];
      if (goals.edits) parts.push(`${formatNumber(goals.edits)}টি সম্পাদনা`);
      if (goals.articles) parts.push(`${formatNumber(goals.articles)}টি নতুন নিবন্ধ`);
      $('goalText').textContent = `লক্ষ্য: প্রত্যেকে ${parts.join(' ও ')}। ${formatNumber(s.total_participants)} জনের মধ্যে ${formatNumber(goals.reached)} জন লক্ষ্য পূরণ করেছেন।`;
      $('goalMeter').setAttribute('aria-valuemax', String(s.total_participants));
      $('goalMeter').setAttribute('aria-valuenow', String(goals.reached));
      $('goalBar').style.width = `${Math.round((goals.reached / s.total_participants) * 100)}%`;
    }
  }

  function renderTimeline(timeline) {
    const unit = timeline.unit;
    $('chartSubtitle').textContent = unit === 'hour' ? 'প্রতি ঘণ্টায়, বাংলাদেশ সময়' : 'প্রতিদিন, বাংলাদেশ সময়';
    updateChart(timeline.points.map(p => ({
      value: p.edits,
      label: bucketLabel(p.bucket, unit),
      fullLabel: formatDate(bucketToIso(p.bucket, unit), unit === 'hour' ? 'short' : 'date')
    })));
    $('chartTable').innerHTML = timeline.points.length === 0
      ? '<tr><td colspan="2" class="text-on-surface-variant">কোনো তথ্য নেই।</td></tr>'
      : timeline.points.map(p => `<tr><td>${esc(formatDate(bucketToIso(p.bucket, unit), unit === 'hour' ? 'short' : 'date'))}</td><td class="text-right tabular-nums">${formatNumber(p.edits)}</td></tr>`).join('');
  }

  function goalProgress(row) {
    const goals = stats.goals;
    if (!goals) return '';
    const parts = [];
    if (goals.edits) parts.push(Math.min(1, row.total_edits / goals.edits));
    if (goals.articles) parts.push(Math.min(1, row.articles_created / goals.articles));
    const progress = parts.reduce((a, b) => a + b, 0) / parts.length;
    const done = progress >= 1;
    return `<div class="mt-xs flex flex-wrap items-center gap-x-xs gap-y-[2px]" title="লক্ষ্যের ${formatNumber(Math.round(progress * 100))}%">
      <div class="h-1.5 w-20 rounded-pill bg-secondary/15 overflow-hidden"><div class="h-full bg-secondary" data-width="${Math.round(progress * 100)}"></div></div>
      ${done ? `<span class="text-[11px] font-bold text-secondary whitespace-nowrap">${icon('check_circle', 'icon-sm')} লক্ষ্য পূরণ</span>` : `<span class="text-[11px] text-on-surface-variant">${formatNumber(Math.round(progress * 100))}%</span>`}
    </div>`;
  }

  const MEDALS = ['bg-yellow-400 text-yellow-950', 'bg-slate-300 text-slate-800', 'bg-amber-600 text-amber-50'];

  function renderLeaderboard() {
    const term = $('leaderboardSearch').value.trim().toLowerCase();
    const sorted = [...rows].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'username') return dir * a.username.localeCompare(b.username);
      return dir * (a[sortKey] - b[sortKey]) || a.rank - b.rank;
    });
    const list = sorted.map((r, i) => ({ ...r, position: i + 1 })).filter(r => !term || r.username.toLowerCase().includes(term));
    document.querySelectorAll('[data-sort-col]').forEach(th => {
      th.setAttribute('aria-sort', th.dataset.sortCol === sortKey ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
    if (list.length === 0) {
      $('leaderboardBody').innerHTML = `<tr><td colspan="7" class="text-center text-on-surface-variant py-lg">${term ? 'কোনো মিল পাওয়া যায়নি।' : 'লিডারবোর্ডে এখনো কোনো অংশগ্রহণকারী নেই।'}</td></tr>`;
      return;
    }
    $('leaderboardBody').innerHTML = list.map(r => {
      const pos = r.position <= 3 && sortKey !== 'username'
        ? `<span class="inline-flex w-8 h-8 items-center justify-center rounded-pill font-extrabold ${MEDALS[r.position - 1]}">${formatNumber(r.position)}</span>`
        : formatNumber(r.position);
      return `
        <tr>
          <td class="text-center font-bold">${pos}</td>
          <td class="min-w-[180px]">
            <button type="button" class="font-bold text-primary hover:underline text-left break-all" data-detail="${esc(r.username)}">${esc(r.username)}</button>
            ${goalProgress(r)}
          </td>
          <td class="text-right tabular-nums font-semibold">${formatNumber(r.total_edits)}</td>
          <td class="text-right tabular-nums">${formatNumber(r.articles_created)}</td>
          <td class="text-right tabular-nums">${formatNumber(r.pages_edited)}</td>
          <td class="text-right tabular-nums">${formatNumber(r.file_uploads)}</td>
          <td class="text-right tabular-nums whitespace-nowrap">${formatBytes(r.bytes_added)}</td>
        </tr>`;
    }).join('');
    // Widths are applied from JS because inline style attributes are blocked by the CSP
    document.querySelectorAll('#leaderboardBody [data-width]').forEach(bar => { bar.style.width = `${bar.dataset.width}%`; });
  }

  async function load() {
    const { ok, data } = await api(`/api/events/${page.eventId}/stats`);
    if (!ok) {
      $('leaderboardBody').innerHTML = `<tr><td colspan="7" class="text-center text-error py-lg">${esc(data.error || 'পরিসংখ্যান লোড করা যায়নি।')}</td></tr>`;
      return null;
    }
    stats = data.stats;
    rows = data.leaderboard;
    event = data.event;
    renderSummary();
    renderTimeline(data.timeline);
    renderLeaderboard();
    return data;
  }

  document.querySelectorAll('[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else {
        sortKey = key;
        sortDir = key === 'username' ? 'asc' : 'desc';
      }
      renderLeaderboard();
    });
  });
  $('leaderboardSearch').addEventListener('input', renderLeaderboard);

  // Participant detail: their edits during the event
  $('leaderboardBody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-detail]');
    if (!btn) return;
    const username = btn.dataset.detail;
    const row = rows.find(r => r.username === username) || {};
    $('detailTitle').textContent = username;
    $('detailBody').innerHTML = '<p class="text-body-md text-on-surface-variant flex items-center gap-sm"><span class="spinner"></span> লোড হচ্ছে...</p>';
    openModal($('detailModal'));
    const wikis = event ? event.target_wikis.split(',') : [];
    const links = wikis.map(w => `<a class="btn btn-outline btn-sm" href="https://${esc(w)}/wiki/Special:Contributions/${encodeURIComponent(username)}" target="_blank" rel="noopener">${icon('open_in_new', 'icon-sm')} ${esc(w)}</a>`).join(' ');
    const { ok, data } = await api(`/api/events/${page.eventId}/participants/${encodeURIComponent(username)}/contribs`);
    if (!ok) {
      $('detailBody').innerHTML = `<div class="alert alert-error">${icon('error')}<p>${esc(data.error || 'তথ্য লোড করা যায়নি।')}</p></div>`;
      return;
    }
    const items = data.contributions.map(c => {
      const pageUrl = `https://${esc(c.wiki)}/wiki/${encodeURIComponent(c.title.replace(/ /g, '_'))}`;
      const diffUrl = `https://${esc(c.wiki)}/w/index.php?diff=${Number(c.revid)}`;
      const size = c.sizediff > 0 ? `<span class="text-secondary font-bold">+${formatNumber(c.sizediff)}</span>` : `<span class="text-on-surface-variant">${formatNumber(c.sizediff)}</span>`;
      return `<li class="py-sm border-b border-outline-variant/60 flex justify-between gap-md">
        <div class="min-w-0">
          <a class="font-bold break-words" href="${pageUrl}" target="_blank" rel="noopener">${esc(c.title)}</a>
          ${c.is_new ? '<span class="badge badge-self ml-xs">নতুন পাতা</span>' : ''}
          <p class="text-label-md text-on-surface-variant">${esc(formatDate(c.timestamp, 'short'))} · ${esc(c.wiki)} · <a href="${diffUrl}" target="_blank" rel="noopener">পরিবর্তন দেখুন</a></p>
        </div>
        <div class="text-label-md tabular-nums shrink-0">${size}</div>
      </li>`;
    }).join('');
    $('detailBody').innerHTML = `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-sm text-center">
        <div class="bg-surface-container-low rounded-lg p-sm"><p class="text-[11px] text-on-surface-variant font-bold">সম্পাদনা</p><p class="font-bold">${formatNumber(row.total_edits)}</p></div>
        <div class="bg-surface-container-low rounded-lg p-sm"><p class="text-[11px] text-on-surface-variant font-bold">নতুন নিবন্ধ</p><p class="font-bold">${formatNumber(row.articles_created)}</p></div>
        <div class="bg-surface-container-low rounded-lg p-sm"><p class="text-[11px] text-on-surface-variant font-bold">পাতা</p><p class="font-bold">${formatNumber(row.pages_edited)}</p></div>
        <div class="bg-surface-container-low rounded-lg p-sm"><p class="text-[11px] text-on-surface-variant font-bold">যুক্ত ডেটা</p><p class="font-bold">${formatBytes(row.bytes_added)}</p></div>
      </div>
      <div class="flex flex-wrap gap-xs">${links}</div>
      ${items ? `<ul>${items}</ul>` : '<p class="text-body-md text-on-surface-variant">ইভেন্টের সময়ে এখনো কোনো সম্পাদনা পাওয়া যায়নি।</p>'}
      ${data.contributions.length >= 500 ? '<p class="help">সর্বশেষ ৫০০টি সম্পাদনা দেখানো হচ্ছে।</p>' : ''}`;
  });

  // Manual refresh (limited to once a minute per event on the server)
  const refreshBtn = $('refreshBtn');
  let waitTimer = null;
  function waitForUpdate(attempt) {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(async () => {
      const data = await load();
      if (data && data.stats.refreshing && attempt < 30) waitForUpdate(attempt + 1);
      else setBusy(refreshBtn, false);
    }, 4000);
  }
  refreshBtn.addEventListener('click', async () => {
    setBusy(refreshBtn, true, 'হালনাগাদ হচ্ছে...');
    const { ok, data } = await api(`/api/events/${page.eventId}/refresh`, { method: 'POST' });
    if (!ok) {
      setBusy(refreshBtn, false);
      toast(data.error || 'রিফ্রেশ করা যায়নি।', 'error');
      return;
    }
    toast(data.message || 'পরিসংখ্যান হালনাগাদ হচ্ছে।', 'info', 3500);
    waitForUpdate(0);
  });

  load();
  // Reload the numbers every minute while the page is visible
  setInterval(() => {
    if (!document.hidden) load();
  }, 60000);
})();
