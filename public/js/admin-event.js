// Event administration: live request queue with bulk approval, participant
// management and the settings tab's maintenance actions.
(function () {
  'use strict';
  const { api, esc, icon, pageData, setBusy, toast, formatDate, formatNumber, formatBytes, timeAgo, openModal, closeModal } = window.App;
  const page = pageData();
  const eventId = page.eventId;
  const $ = id => document.getElementById(id);

  // --- Tabs (remembered in the URL hash) ---
  const tabs = [...document.querySelectorAll('[role="tab"][data-tab]')];
  function selectTab(name) {
    tabs.forEach(tab => {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(`panel-${tab.dataset.tab}`).hidden = !selected;
    });
    history.replaceState(null, '', `#${name}`);
    if (name === 'participants') loadParticipants();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next.dataset.tab);
      next.focus();
    });
  });

  // --- Requests ---
  let requests = [];
  let showEmail = false;
  let lastPendingIds = null;
  let bulkRunning = false;
  let stopBulk = false;
  const selected = new Set();
  const busy = new Set();
  const baseTitle = document.title;

  const isPending = r => r.status === 'pending' || r.status === 'processing';

  function updateCounts() {
    const pending = requests.filter(isPending).length;
    $('pendingBadge').textContent = formatNumber(pending);
    document.title = pending > 0 ? `(${pending}) ${baseTitle}` : baseTitle;
    $('bulkBar').hidden = selected.size === 0 || bulkRunning;
    $('bulkCount').textContent = `${formatNumber(selected.size)}টি নির্বাচিত`;
  }

  function renderPending(highlight) {
    const term = $('requestSearch').value.trim().toLowerCase();
    const list = requests
      .filter(isPending)
      .filter(r => !term || r.username.toLowerCase().includes(term))
      .sort((a, b) => a.requested_at.localeCompare(b.requested_at));
    const cols = showEmail ? 5 : 4;
    if (list.length === 0) {
      $('pendingBody').innerHTML = `<tr><td colspan="${cols}" class="text-center text-on-surface-variant py-lg">${term ? 'কোনো মিল পাওয়া যায়নি।' : 'কোনো অপেক্ষমাণ আবেদন নেই। নতুন আবেদন এলে এখানে নিজে থেকেই দেখাবে।'}</td></tr>`;
      $('selectAll').checked = false;
      return;
    }
    $('pendingBody').innerHTML = list.map(r => {
      const locked = r.status === 'processing' || busy.has(r.id) || bulkRunning;
      const initial = esc([...r.username][0] || '?');
      return `
        <tr data-id="${r.id}" class="${highlight && highlight.has(r.id) ? 'bg-secondary-container/25' : ''}">
          <td><input class="checkbox" type="checkbox" data-select value="${r.id}" ${selected.has(r.id) ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="${esc(r.username)} নির্বাচন করুন"></td>
          <td class="md:min-w-[200px]" data-cell="name">
            <div class="flex items-start gap-sm">
              <div class="avatar">${initial}</div>
              <div class="min-w-0">
                <span class="font-bold break-all">${esc(r.username)}</span>
                ${r.status === 'processing' || busy.has(r.id) ? '<span class="badge badge-processing ml-xs"><span class="spinner w-3 h-3"></span> প্রক্রিয়াধীন</span>' : ''}
                ${r.error_message ? `<p class="text-label-md text-error mt-xs">${esc(r.error_message)}</p>` : ''}
                ${!showEmail && r.has_email === false ? '<p class="text-label-md text-on-surface-variant mt-xs">ইমেইল নেই</p>' : ''}
              </div>
            </div>
          </td>
          ${showEmail ? `<td class="font-mono text-label-md break-all" data-cell="meta">${esc(r.email || '-')}</td>` : ''}
          <td class="whitespace-nowrap text-label-md" data-cell="meta">${esc(formatDate(r.requested_at, 'short'))}<br class="max-md:hidden"><span class="text-on-surface-variant max-md:ml-xs">${esc(timeAgo(r.requested_at))}</span></td>
          <td class="text-right whitespace-nowrap" data-cell="actions">
            <button type="button" class="btn btn-primary btn-sm" data-action="approve" data-id="${r.id}" ${locked ? 'disabled' : ''}>${icon('check', 'icon-sm')} অনুমোদন</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="approve-comment" data-id="${r.id}" ${locked ? 'disabled' : ''} title="মন্তব্যসহ অনুমোদন" aria-label="${esc(r.username)}: মন্তব্যসহ অনুমোদন">${icon('add_comment', 'icon-sm')}</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="rename" data-id="${r.id}" ${locked ? 'disabled' : ''} title="নাম পরিবর্তন" aria-label="${esc(r.username)}: নাম পরিবর্তন">${icon('edit', 'icon-sm')}</button>
            <button type="button" class="btn btn-danger-outline btn-sm" data-action="decline" data-id="${r.id}" ${locked ? 'disabled' : ''}>বাতিল</button>
          </td>
        </tr>`;
    }).join('');
    const selectable = [...document.querySelectorAll('[data-select]:not(:disabled)')];
    $('selectAll').checked = selectable.length > 0 && selectable.every(cb => cb.checked);
  }

  const WELCOME_NOTE = { failed: 'স্বাগত বার্তা পোস্ট করা যায়নি', exists: 'আলাপ পাতা আগে থেকে ছিল, স্বাগত বার্তা যায়নি' };

  function renderHistory() {
    const filter = $('historyFilter').value;
    const list = requests
      .filter(r => r.status === 'approved' || r.status === 'declined')
      .filter(r => filter === 'all' || r.status === filter)
      .sort((a, b) => (b.decided_at || '').localeCompare(a.decided_at || ''));
    const cols = showEmail ? 6 : 5;
    if (list.length === 0) {
      $('historyBody').innerHTML = `<tr><td colspan="${cols}" class="text-center text-on-surface-variant py-lg">এখনো কোনো সিদ্ধান্ত নেওয়া হয়নি।</td></tr>`;
      return;
    }
    $('historyBody').innerHTML = list.map(r => {
      const approved = r.status === 'approved';
      const nameHtml = approved && r.created_on_wiki
        ? `<a class="font-bold break-all" href="https://${esc(r.created_on_wiki)}/wiki/Special:Contributions/${encodeURIComponent(r.username)}" target="_blank" rel="noopener">${esc(r.username)}</a>`
        : `<span class="font-bold break-all">${esc(r.username)}</span>`;
      const notes = [
        r.decision_reason ? `মন্তব্য: ${esc(r.decision_reason)}` : '',
        WELCOME_NOTE[r.welcome_status] ? `<span class="text-error">${WELCOME_NOTE[r.welcome_status]}</span>` : ''
      ].filter(Boolean).join('<br>');
      return `
        <tr>
          <td>${nameHtml}${approved && r.created_on_wiki ? `<p class="text-[11px] text-on-surface-variant">${esc(r.created_on_wiki)}</p>` : ''}</td>
          ${showEmail ? `<td class="font-mono text-label-md break-all">${esc(r.email || (r.email_purged_at ? 'মুছে ফেলা হয়েছে' : '-'))}</td>` : ''}
          <td><span class="badge badge-${r.status}">${approved ? 'অনুমোদিত' : 'বাতিল'}</span></td>
          <td class="whitespace-nowrap text-label-md">${esc(formatDate(r.requested_at, 'short'))}</td>
          <td class="whitespace-nowrap text-label-md"><strong>${esc(r.decided_by || '-')}</strong><br>${esc(formatDate(r.decided_at, 'short'))}</td>
          <td class="text-label-md text-on-surface-variant max-w-xs break-words">${notes || '-'}</td>
        </tr>`;
    }).join('');
  }

  async function loadRequests(options) {
    const quiet = options && options.quiet;
    const { ok, data } = await api(`/api/admin/events/${eventId}/requests`);
    if (!ok) {
      if (!quiet) toast(data.error || 'আবেদনের তালিকা লোড করা যায়নি।', 'error');
      return;
    }
    showEmail = data.showEmail;
    document.querySelectorAll('[data-email-col]').forEach(el => { el.hidden = !showEmail; });
    requests = data.requests;
    const pendingIds = requests.filter(isPending).map(r => r.id);
    const fresh = lastPendingIds ? pendingIds.filter(id => !lastPendingIds.includes(id)) : [];
    lastPendingIds = pendingIds;
    for (const id of [...selected]) {
      if (!pendingIds.includes(id)) selected.delete(id);
    }
    renderPending(new Set(fresh));
    renderHistory();
    updateCounts();
    $('liveIndicator').title = `সর্বশেষ হালনাগাদ: ${formatDate(new Date().toISOString(), 'time')}`;
    if (quiet && fresh.length > 0) toast(`${formatNumber(fresh.length)}টি নতুন আবেদন এসেছে।`, 'info', 4000);
  }

  async function approveOne(id, reason) {
    busy.add(id);
    renderPending();
    const result = await api(`/api/admin/requests/${id}/approve`, { method: 'POST', body: { reason: reason || '' } });
    busy.delete(id);
    return result;
  }

  async function declineOne(id, reason) {
    busy.add(id);
    renderPending();
    const result = await api(`/api/admin/requests/${id}/decline`, { method: 'POST', body: { reason: reason || '' } });
    busy.delete(id);
    return result;
  }

  function approvedMessage(data) {
    const welcome = data.welcome === 'failed' ? ' (স্বাগত বার্তা পোস্ট করা যায়নি)' : '';
    return `"${data.username}" অ্যাকাউন্ট তৈরি হয়েছে (${data.wiki})${welcome}।`;
  }

  async function approve(id, reason) {
    const { ok, data } = await approveOne(id, reason);
    toast(ok ? approvedMessage(data) : data.error || 'অ্যাকাউন্ট তৈরি করা যায়নি।', ok ? 'success' : 'error');
    await loadRequests({ quiet: true });
  }

  async function decline(id, reason) {
    const { ok, data } = await declineOne(id, reason);
    toast(ok ? 'আবেদনটি বাতিল করা হয়েছে।' : data.error || 'বাতিল করা যায়নি।', ok ? 'success' : 'error');
    await loadRequests({ quiet: true });
  }

  // Reason dialog, used for decline and "approve with comment"
  let reasonAction = null;
  function openReason(action, ids) {
    reasonAction = { action, ids };
    const count = ids.length;
    const decline = action === 'decline';
    const name = count === 1 ? (requests.find(r => r.id === ids[0]) || {}).username : null;
    $('reasonTitle').textContent = decline ? (count > 1 ? `${formatNumber(count)}টি আবেদন বাতিল` : 'আবেদন বাতিল') : 'মন্তব্যসহ অনুমোদন';
    $('reasonDescription').textContent = decline
      ? (count > 1 ? 'নির্বাচিত আবেদনগুলো বাতিল হবে। কারণটি আবেদনকারীরা তাদের অবস্থার পাতায় দেখতে পাবেন।' : `"${name}"-এর আবেদন বাতিল হবে। কারণটি আবেদনকারী তার অবস্থার পাতায় দেখতে পাবেন।`)
      : `"${name}"-এর অ্যাকাউন্ট তৈরি হবে। মন্তব্যটি উইকিপিডিয়ার অ্যাকাউন্ট তৈরির লগেও যুক্ত হবে।`;
    $('reasonSubmit').textContent = decline ? 'বাতিল নিশ্চিত করুন' : 'অনুমোদন ও তৈরি করুন';
    $('reasonSubmit').className = `btn ${decline ? 'btn-danger' : 'btn-primary'}`;
    $('reasonInput').value = '';
    openModal($('reasonModal'));
  }
  $('reasonForm').addEventListener('submit', e => {
    e.preventDefault();
    const { action, ids } = reasonAction;
    const reason = $('reasonInput').value.trim();
    closeModal();
    if (ids.length > 1) runBulk(action, ids, reason);
    else if (action === 'decline') decline(ids[0], reason);
    else approve(ids[0], reason);
  });

  // Rename dialog
  let renameId = null;
  function openRename(id) {
    const request = requests.find(r => r.id === id);
    if (!request) return;
    renameId = id;
    $('renameInput').value = request.username;
    $('renameError').hidden = true;
    openModal($('renameModal'));
  }
  $('renameForm').addEventListener('submit', async e => {
    e.preventDefault();
    setBusy($('renameSubmit'), true, 'যাচাই হচ্ছে...');
    const { ok, data } = await api(`/api/admin/requests/${renameId}`, { method: 'PATCH', body: { username: $('renameInput').value } });
    setBusy($('renameSubmit'), false);
    if (!ok) {
      $('renameError').querySelector('p').textContent = data.error || 'নাম পরিবর্তন করা যায়নি।';
      $('renameError').hidden = false;
      return;
    }
    closeModal();
    toast(`নাম পরিবর্তন করে "${data.username}" করা হয়েছে।`, 'success');
    loadRequests({ quiet: true });
  });

  $('pendingBody').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const action = btn.dataset.action;
    if (action === 'approve') approve(id);
    else if (action === 'approve-comment') openReason('approve', [id]);
    else if (action === 'decline') openReason('decline', [id]);
    else if (action === 'rename') openRename(id);
  });

  $('pendingBody').addEventListener('change', e => {
    const cb = e.target.closest('[data-select]');
    if (!cb) return;
    if (cb.checked) selected.add(Number(cb.value));
    else selected.delete(Number(cb.value));
    const selectable = [...document.querySelectorAll('[data-select]:not(:disabled)')];
    $('selectAll').checked = selectable.length > 0 && selectable.every(c => c.checked);
    updateCounts();
  });

  $('selectAll').addEventListener('change', () => {
    document.querySelectorAll('[data-select]:not(:disabled)').forEach(cb => {
      cb.checked = $('selectAll').checked;
      if (cb.checked) selected.add(Number(cb.value));
      else selected.delete(Number(cb.value));
    });
    updateCounts();
  });

  $('requestSearch').addEventListener('input', () => renderPending());
  $('historyFilter').addEventListener('change', renderHistory);
  $('bulkClear').addEventListener('click', () => {
    selected.clear();
    renderPending();
    updateCounts();
  });
  $('bulkApprove').addEventListener('click', () => {
    const ids = [...selected];
    if (ids.length && window.confirm(`${formatNumber(ids.length)}টি অ্যাকাউন্ট তৈরি করবেন? প্রতিটির জন্য উইকিপিডিয়া থেকে ইমেইল যাবে।`)) {
      runBulk('approve', ids, '');
    }
  });
  $('bulkDecline').addEventListener('click', () => {
    const ids = [...selected];
    if (ids.length) openReason('decline', ids);
  });
  $('bulkStop').addEventListener('click', () => {
    stopBulk = true;
    $('bulkProgressText').textContent = 'চলমান কাজটি শেষ হলে থামবে...';
  });

  // Process many requests one after another, showing progress
  async function runBulk(action, ids, reason) {
    bulkRunning = true;
    stopBulk = false;
    selected.clear();
    updateCounts();
    $('bulkProgress').hidden = false;
    let done = 0;
    let failed = 0;
    const failures = [];
    const progress = () => {
      $('bulkProgressText').textContent = `${formatNumber(done)}/${formatNumber(ids.length)} সম্পন্ন${failed ? ` · ${formatNumber(failed)}টি ব্যর্থ` : ''}`;
      $('bulkProgressBar').style.width = `${Math.round((done / ids.length) * 100)}%`;
    };
    progress();
    for (const id of ids) {
      if (stopBulk) break;
      const request = requests.find(r => r.id === id);
      const { ok, status, data } = action === 'approve' ? await approveOne(id, reason) : await declineOne(id, reason);
      done++;
      if (!ok) {
        failed++;
        failures.push(`${request ? request.username : id}: ${data.error || 'ব্যর্থ'}`);
      }
      progress();
      await loadRequests({ quiet: true });
      if (status === 401) break;
    }
    bulkRunning = false;
    renderPending();
    updateCounts();
    const verb = action === 'approve' ? 'অ্যাকাউন্ট তৈরি হয়েছে' : 'আবেদন বাতিল হয়েছে';
    toast(`${formatNumber(done - failed)}টি ${verb}${failed ? `, ${formatNumber(failed)}টি ব্যর্থ` : ''}।`, failed ? 'warning' : 'success', 8000);
    failures.slice(0, 3).forEach(f => toast(f, 'error'));
    setTimeout(() => { $('bulkProgress').hidden = true; }, 4000);
  }

  // Check for new requests every 10 seconds
  loadRequests();
  setInterval(() => {
    const modalOpen = !$('reasonModal').hidden || !$('renameModal').hidden;
    if (!document.hidden && !bulkRunning && !modalOpen && busy.size === 0) loadRequests({ quiet: true });
  }, 10000);

  // Open / close registration
  $('toggleRegistration').addEventListener('click', async () => {
    const btn = $('toggleRegistration');
    const active = btn.dataset.active !== '1';
    setBusy(btn, true, 'হালনাগাদ হচ্ছে...');
    const { ok, data } = await api(`/api/admin/events/${eventId}/registration`, { method: 'POST', body: { active } });
    setBusy(btn, false);
    if (!ok) return toast(data.error || 'পরিবর্তন করা যায়নি।', 'error');
    btn.dataset.active = active ? '1' : '0';
    btn.textContent = active ? 'নিবন্ধন বন্ধ করুন' : 'নিবন্ধন চালু করুন';
    btn.className = `btn ${active ? 'btn-danger-outline' : 'btn-secondary'}`;
    $('registrationBadge').textContent = active ? 'নিবন্ধন চালু' : 'নিবন্ধন বন্ধ';
    $('registrationBadge').className = `badge ${active ? 'badge-ongoing' : 'badge-pending'}`;
    const checkbox = document.querySelector('[name="registration_active"]');
    if (checkbox) checkbox.checked = active;
    toast(active ? 'নিবন্ধন চালু করা হয়েছে।' : 'নিবন্ধন বন্ধ করা হয়েছে।', 'success');
  });

  // --- Participants ---
  let participants = [];
  let participantsLoaded = false;
  const SOURCE_LABELS = { account: ['badge-account', 'টুলে তৈরি'], manual: ['badge-manual', 'আয়োজক যোগ করেছেন'], self: ['badge-self', 'নিজে যুক্ত'] };

  function renderParticipants() {
    const term = $('participantSearch').value.trim().toLowerCase();
    const showExcluded = $('showExcluded').checked;
    const list = participants
      .filter(p => showExcluded || !p.excluded)
      .filter(p => !term || p.username.toLowerCase().includes(term))
      .sort((a, b) => (b.total_edits || 0) - (a.total_edits || 0) || a.username.localeCompare(b.username));
    $('participantBadge').textContent = formatNumber(participants.filter(p => !p.excluded).length);
    if (list.length === 0) {
      $('participantsBody').innerHTML = `<tr><td colspan="6" class="text-center text-on-surface-variant py-lg">${term ? 'কোনো মিল পাওয়া যায়নি।' : 'এখনো কোনো অংশগ্রহণকারী নেই।'}</td></tr>`;
      return;
    }
    $('participantsBody').innerHTML = list.map(p => {
      const [badgeClass, label] = SOURCE_LABELS[p.source] || SOURCE_LABELS.manual;
      return `
        <tr class="${p.excluded ? 'opacity-60' : ''}">
          <td><a class="font-bold break-all" href="https://${esc(page.targetWiki)}/wiki/Special:Contributions/${encodeURIComponent(p.username)}" target="_blank" rel="noopener">${esc(p.username)}</a>
            ${p.excluded ? '<span class="badge badge-declined ml-xs">বাদ দেওয়া</span>' : ''}</td>
          <td><span class="badge ${badgeClass}">${label}</span></td>
          <td class="text-right tabular-nums">${formatNumber(p.total_edits)}</td>
          <td class="text-right tabular-nums">${formatNumber(p.articles_created)}</td>
          <td class="text-right tabular-nums whitespace-nowrap">${formatBytes(p.bytes_added)}</td>
          <td class="text-right">
            ${p.excluded
              ? `<button type="button" class="btn btn-outline btn-sm" data-participant="${p.id}" data-op="restore">ফিরিয়ে আনুন</button>`
              : `<button type="button" class="btn btn-ghost btn-sm text-error" data-participant="${p.id}" data-op="exclude" data-name="${esc(p.username)}">${icon('person_remove', 'icon-sm')} বাদ দিন</button>`}
          </td>
        </tr>`;
    }).join('');
  }

  async function loadParticipants(force) {
    if (participantsLoaded && !force) return;
    const { ok, data } = await api(`/api/admin/events/${eventId}/participants`);
    if (!ok) return toast(data.error || 'অংশগ্রহণকারীর তালিকা লোড করা যায়নি।', 'error');
    participants = data.participants;
    participantsLoaded = true;
    renderParticipants();
  }

  $('participantSearch').addEventListener('input', renderParticipants);
  $('showExcluded').addEventListener('change', renderParticipants);

  $('participantsBody').addEventListener('click', async e => {
    const btn = e.target.closest('[data-participant]');
    if (!btn) return;
    const op = btn.dataset.op;
    if (op === 'exclude' && !window.confirm(`"${btn.dataset.name}"-কে লিডারবোর্ড থেকে বাদ দেবেন? পরে চাইলে ফিরিয়ে আনতে পারবেন।`)) return;
    setBusy(btn, true, '...');
    const { ok, data } = await api(`/api/admin/participants/${btn.dataset.participant}/${op}`, { method: 'POST' });
    if (!ok) {
      setBusy(btn, false);
      return toast(data.error || 'পরিবর্তন করা যায়নি।', 'error');
    }
    toast(op === 'exclude' ? 'লিডারবোর্ড থেকে বাদ দেওয়া হয়েছে।' : 'অংশগ্রহণকারীকে ফিরিয়ে আনা হয়েছে।', 'success');
    loadParticipants(true);
  });

  $('addParticipantsForm').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('participantNames').value.trim();
    if (!text) {
      $('participantNames').focus();
      return;
    }
    setBusy($('addParticipantsBtn'), true, 'যাচাই হচ্ছে...');
    const { ok, data } = await api(`/api/admin/events/${eventId}/participants`, { method: 'POST', body: { usernames: text } });
    setBusy($('addParticipantsBtn'), false);
    if (!ok) {
      $('addResult').innerHTML = `<div class="alert alert-error">${icon('error')}<p>${esc(data.error || 'যোগ করা যায়নি।')}</p></div>`;
      return;
    }
    const line = (label, names) => names.length ? `<li><strong>${label} (${formatNumber(names.length)}):</strong> ${names.map(esc).join(', ')}</li>` : '';
    const problems = data.notFound.length + data.invalid.length;
    $('addResult').innerHTML = `
      <div class="alert ${problems ? 'alert-warning' : 'alert-success'}">${icon(problems ? 'warning' : 'check_circle')}
        <ul class="space-y-xs">
          ${line('যোগ হয়েছে', data.added)}
          ${line('ফিরিয়ে আনা হয়েছে', data.restored)}
          ${line('আগে থেকেই আছেন', data.alreadyPresent)}
          ${line('উইকিপিডিয়ায় পাওয়া যায়নি', data.notFound)}
          ${line('নামটি গ্রহণযোগ্য নয়', data.invalid)}
        </ul>
      </div>`;
    if (!problems) $('participantNames').value = '';
    else $('participantNames').value = [...data.notFound, ...data.invalid].join('\n');
    loadParticipants(true);
  });

  // --- Maintenance ---
  $('resyncBtn').addEventListener('click', async () => {
    if (!window.confirm('এই ইভেন্টের সব পরিসংখ্যান মুছে শুরু থেকে আবার গণনা করবেন? অংশগ্রহণকারী বেশি হলে কয়েক মিনিট লাগতে পারে।')) return;
    setBusy($('resyncBtn'), true, 'শুরু হচ্ছে...');
    const { ok, data } = await api(`/api/admin/events/${eventId}/resync`, { method: 'POST' });
    setBusy($('resyncBtn'), false);
    toast(ok ? 'পরিসংখ্যান আবার গণনা শুরু হয়েছে।' : data.error || 'শুরু করা যায়নি।', ok ? 'success' : 'error');
  });

  // Open the tab named in the URL (#requests, #participants or #settings)
  const tabFromHash = () => {
    const name = window.location.hash.slice(1);
    return tabs.some(t => t.dataset.tab === name) ? name : null;
  };
  selectTab(tabFromHash() || 'requests');
  window.addEventListener('hashchange', () => {
    if (tabFromHash()) selectTab(tabFromHash());
  });
  if (new URLSearchParams(window.location.search).get('created')) {
    toast('ইভেন্ট তৈরি হয়েছে! এখন নিবন্ধন লিংক বা QR কোড অংশগ্রহণকারীদের সাথে শেয়ার করুন।', 'success', 8000);
  }

  const deleteBtn = $('deleteEventBtn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const typed = window.prompt(`এই ইভেন্টের সব আবেদন, অংশগ্রহণকারী ও পরিসংখ্যান চিরতরে মুছে যাবে।\n\nনিশ্চিত করতে ইভেন্টের নাম হুবহু লিখুন:\n${page.eventName}`);
      if (typed === null) return;
      if (typed.trim() !== page.eventName) return toast('নাম মেলেনি, ইভেন্টটি মোছা হয়নি।', 'error');
      setBusy(deleteBtn, true, 'মোছা হচ্ছে...');
      const { ok, data } = await api(`/api/admin/events/${eventId}`, { method: 'DELETE' });
      if (!ok) {
        setBusy(deleteBtn, false);
        return toast(data.error || 'মোছা যায়নি।', 'error');
      }
      window.location.href = '/admin';
    });
  }
})();
