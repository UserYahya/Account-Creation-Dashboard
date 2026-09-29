// Create / edit event form (admin)
(function () {
  'use strict';
  const { api, pageData, setBusy, toast } = window.App;
  const page = pageData();
  const form = document.querySelector('[data-event-form]');
  if (!form) return;

  const field = name => form.elements.namedItem(name);
  const errorBox = document.getElementById(`${form.id}Error`);
  const allNs = form.querySelector('[data-ns-all]');
  const nsChoices = [...form.querySelectorAll('[data-ns]')];

  allNs.addEventListener('change', () => {
    nsChoices.forEach(cb => {
      cb.disabled = allNs.checked;
      if (allNs.checked) cb.checked = false;
    });
  });

  function selectedNamespaces() {
    if (allNs.checked) return 'all';
    const chosen = nsChoices.filter(cb => cb.checked).map(cb => cb.value);
    return chosen.length ? chosen.join(',') : 'all';
  }

  function showError(message, input) {
    errorBox.querySelector('p').textContent = message;
    errorBox.hidden = false;
    if (input) input.focus();
    else errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errorBox.hidden = true;
    const body = {
      name: field('name').value.trim(),
      workshop_url: field('workshop_url').value.trim(),
      start_time: field('start_time').value,
      end_time: field('end_time').value,
      target_wikis: field('target_wikis').value,
      target_namespaces: selectedNamespaces(),
      registration_active: field('registration_active').checked,
      allow_self_enroll: field('allow_self_enroll').checked,
      account_wiki: field('account_wiki').value,
      instructions: field('instructions').value,
      welcome_message: field('welcome_message').value,
      goal_edits: field('goal_edits').value,
      goal_articles: field('goal_articles').value
    };
    if (!body.name) return showError('ইভেন্টের নাম আবশ্যক।', field('name'));
    if (!body.start_time || !body.end_time) return showError('শুরু ও শেষের সময় দিন।', field(body.start_time ? 'end_time' : 'start_time'));
    if (body.end_time <= body.start_time) return showError('শেষের সময় অবশ্যই শুরুর সময়ের পরে হতে হবে।', field('end_time'));

    const button = form.querySelector('[data-submit]');
    setBusy(button, true, 'সংরক্ষণ হচ্ছে...');
    const { ok, data } = page.mode === 'create'
      ? await api('/api/admin/events', { method: 'POST', body })
      : await api(`/api/admin/events/${page.eventId}`, { method: 'PUT', body });
    if (!ok) {
      setBusy(button, false);
      return showError(data.error || 'সংরক্ষণ করা যায়নি।');
    }
    if (page.mode === 'create') {
      window.location.href = `${data.adminUrl}?created=1`;
      return;
    }
    toast(data.statsReset ? 'সংরক্ষণ হয়েছে। সময় বা উইকি বদলানোয় পরিসংখ্যান আবার গণনা করা হচ্ছে।' : 'পরিবর্তন সংরক্ষণ হয়েছে।', 'success');
    setTimeout(() => window.location.reload(), 1200);
  });
})();
