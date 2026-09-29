// Projector page: big counters and the top 10, refreshed every 30 seconds.
(function () {
  'use strict';
  const { api, esc, pageData, formatNumber, formatDate } = window.App;
  const { eventId } = pageData();
  const MEDALS = ['bg-yellow-400 text-yellow-950', 'bg-slate-300 text-slate-800', 'bg-amber-600 text-amber-50'];

  async function load() {
    const { ok, data } = await api(`/api/events/${eventId}/stats`);
    if (!ok) return;
    const s = data.stats;
    for (const el of document.querySelectorAll('[data-display]')) {
      el.textContent = formatNumber(s[el.dataset.display]);
    }
    document.getElementById('displayUpdated').textContent = s.last_updated ? `হালনাগাদ: ${formatDate(s.last_updated, 'time')}` : '';
    const top = data.leaderboard.slice(0, 10);
    document.getElementById('displayLeaderboard').innerHTML = top.length === 0
      ? '<li class="p-lg text-center text-body-lg text-on-surface-variant">অংশগ্রহণকারীরা সম্পাদনা শুরু করলে এখানে দেখা যাবে।</li>'
      : top.map((r, i) => `
        <li class="flex items-center gap-md px-lg py-[6px] text-body-lg">
          <span class="inline-flex w-9 h-9 shrink-0 items-center justify-center rounded-pill font-extrabold ${MEDALS[i] || 'bg-surface-container-high text-on-surface'}">${formatNumber(i + 1)}</span>
          <span class="flex-1 font-bold truncate text-[19px]">${esc(r.username)}</span>
          <span class="tabular-nums font-extrabold text-[22px]">${formatNumber(r.total_edits)}</span>
          <span class="text-label-md text-on-surface-variant w-20">সম্পাদনা</span>
        </li>`).join('');
  }

  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  });

  load();
  setInterval(load, 30000);
})();
