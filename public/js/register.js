// Registration page: live username check, email typo hints, the
// "already have an account" tab, and remembering the application on this device.
(function () {
  'use strict';
  const { api, esc, icon, pageData, setBusy } = window.App;
  const { eventId } = pageData();
  const STORAGE_KEY = 'acd:applications';

  function savedApplications() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }
  function saveApplication(entry) {
    try {
      const all = savedApplications();
      all[eventId] = entry;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Private browsing or storage disabled: the status link still works
    }
  }

  // Remind returning visitors of the application they already sent
  const existing = savedApplications()[eventId];
  const banner = document.getElementById('existingApplication');
  if (existing && existing.token && banner) {
    banner.querySelector('[data-username]').textContent = existing.username || '';
    banner.querySelector('[data-status-link]').href = `/status/${encodeURIComponent(existing.token)}`;
    banner.hidden = false;
  }

  // --- Tabs: new account / existing account ---
  const tabs = [...document.querySelectorAll('[data-tab]')];
  function selectTab(name, focus) {
    tabs.forEach(tab => {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(`panel-${tab.dataset.tab}`).hidden = !selected;
      if (selected && focus) tab.focus();
    });
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next.dataset.tab, true);
    });
  });
  if (tabs.length && window.location.hash === '#join') selectTab('join');

  // Same rules MediaWiki applies to usernames
  function normalize(name) {
    const cleaned = name.normalize('NFC').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : '';
  }
  const INVALID_CHARS = /[#<>[\]|{}@:=/\\]/;

  function alertHtml(kind, message, extra) {
    const icons = { success: icon('check_circle'), error: icon('error'), warning: icon('warning'), info: '<span class="spinner mt-[2px]" aria-hidden="true"></span>' };
    return `<div class="alert alert-${kind}">${icons[kind]}<p>${esc(message)}${extra || ''}</p></div>`;
  }

  // --- New account form ---
  const form = document.getElementById('registrationForm');
  if (!form) return;
  const emailInput = document.getElementById('email');
  const confirmInput = document.getElementById('emailConfirm');
  const confirmMsg = document.getElementById('emailConfirmMsg');
  const emailHint = document.getElementById('emailHint');
  const usernameInput = document.getElementById('username');
  const preview = document.getElementById('usernamePreview');
  const feedback = document.getElementById('usernameFeedback');
  const suggestionsBox = document.getElementById('usernameSuggestions');
  const consent = document.getElementById('consent');
  const submitBtn = document.getElementById('submitBtn');
  const formError = document.getElementById('formError');

  let usernameState = 'empty'; // empty | checking | valid | invalid | unknown
  let sequence = 0;
  let debounce = null;
  let controller = null;

  function setFeedback(kind, message, extra) {
    feedback.innerHTML = kind ? alertHtml(kind, message, extra) : '';
  }

  function showSuggestions(names) {
    const list = suggestionsBox.querySelector('[data-list]');
    list.innerHTML = names.map(n => `<button type="button" class="btn btn-outline btn-sm" data-suggestion="${esc(n)}">${esc(n)}</button>`).join('');
    suggestionsBox.hidden = names.length === 0;
  }
  suggestionsBox.addEventListener('click', e => {
    const btn = e.target.closest('[data-suggestion]');
    if (!btn) return;
    usernameInput.value = btn.dataset.suggestion;
    usernameInput.dispatchEvent(new Event('input'));
    usernameInput.focus();
  });

  async function checkUsername(value, mySequence) {
    controller = new AbortController();
    let result;
    try {
      result = await api(`/api/check-username?username=${encodeURIComponent(value)}`, { signal: controller.signal });
    } catch {
      return; // superseded by newer typing
    }
    if (mySequence !== sequence) return;
    const d = result.data;
    if (d.valid) {
      usernameState = 'valid';
      usernameInput.setAttribute('aria-invalid', 'false');
      setFeedback('success', 'দারুণ! এই নামটি ব্যবহার করা যাবে।');
    } else if (result.status === 0 || result.status === 429 || result.status >= 500) {
      // Could not verify right now; the server checks again on submit
      usernameState = 'unknown';
      setFeedback('warning', d.reason || d.error || 'নামটি এখন যাচাই করা যায়নি।', ' আপনি তবুও আবেদন জমা দিতে পারেন, জমা দেওয়ার সময় আবার পরীক্ষা করা হবে।');
    } else {
      usernameState = 'invalid';
      usernameInput.setAttribute('aria-invalid', 'true');
      setFeedback('error', d.reason || d.error || 'এই নামটি ব্যবহার করা যাবে না।');
      if (Array.isArray(d.suggestions) && d.suggestions.length) showSuggestions(d.suggestions);
    }
  }

  usernameInput.addEventListener('input', () => {
    const raw = usernameInput.value.trim();
    const value = normalize(raw);
    sequence++;
    clearTimeout(debounce);
    if (controller) controller.abort();
    suggestionsBox.hidden = true;
    usernameInput.removeAttribute('aria-invalid');

    preview.hidden = !value || value === raw;
    preview.querySelector('strong').textContent = value;

    if (!value) {
      usernameState = 'empty';
      setFeedback(null);
      return;
    }
    if ([...value].length < 3) {
      usernameState = 'invalid';
      setFeedback('error', 'ব্যবহারকারী নাম কমপক্ষে ৩ অক্ষরের হতে হবে।');
      return;
    }
    if (INVALID_CHARS.test(value)) {
      usernameState = 'invalid';
      setFeedback('error', 'নামে # < > [ ] | { } @ : = / \\ অক্ষরগুলো ব্যবহার করা যাবে না।');
      return;
    }
    usernameState = 'checking';
    setFeedback('info', 'নামটি উইকিপিডিয়ায় পরীক্ষা করা হচ্ছে...');
    const mySequence = sequence;
    debounce = setTimeout(() => checkUsername(value, mySequence), 450);
  });

  // --- Email: typo hints for common providers and matching confirmation ---
  const DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'live.com', 'ymail.com', 'protonmail.com', 'yandex.com', 'aol.com'];
  function distance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  }
  function suggestEmail(email) {
    const at = email.lastIndexOf('@');
    if (at < 1) return null;
    const domain = email.slice(at + 1).toLowerCase();
    if (!domain || DOMAINS.includes(domain)) return null;
    let best = null;
    for (const candidate of DOMAINS) {
      const d = distance(domain, candidate);
      if (d > 0 && d <= 2 && (!best || d < best.d)) best = { candidate, d };
    }
    return best ? `${email.slice(0, at)}@${best.candidate}` : null;
  }

  function updateEmailHint() {
    const suggestion = suggestEmail(emailInput.value.trim());
    if (!suggestion) {
      emailHint.hidden = true;
      return;
    }
    emailHint.innerHTML = `আপনি কি <button type="button" class="font-bold text-primary underline" data-email="${esc(suggestion)}">${esc(suggestion)}</button> বোঝাতে চেয়েছেন?`;
    emailHint.hidden = false;
  }
  emailHint.addEventListener('click', e => {
    const btn = e.target.closest('[data-email]');
    if (!btn) return;
    emailInput.value = btn.dataset.email;
    emailHint.hidden = true;
    updateConfirm();
    confirmInput.focus();
  });

  function updateConfirm() {
    const a = emailInput.value.trim().toLowerCase();
    const b = confirmInput.value.trim().toLowerCase();
    if (!b) {
      confirmMsg.textContent = '';
      confirmInput.removeAttribute('aria-invalid');
      return;
    }
    const match = a === b;
    confirmMsg.textContent = match ? 'ইমেইল ঠিকানা মিলেছে।' : 'দুটি ইমেইল ঠিকানা এখনো মেলেনি।';
    confirmMsg.className = `help ${match ? 'text-secondary' : 'text-error'}`;
    confirmInput.setAttribute('aria-invalid', String(!match));
  }
  emailInput.addEventListener('blur', updateEmailHint);
  emailInput.addEventListener('input', () => {
    if (!emailHint.hidden) updateEmailHint();
    updateConfirm();
  });
  confirmInput.addEventListener('input', updateConfirm);

  function showFormError(message, field) {
    formError.querySelector('p').textContent = message;
    formError.hidden = false;
    const target = { email: emailInput, email_confirm: confirmInput, username: usernameInput, consent }[field];
    if (target) {
      target.setAttribute('aria-invalid', 'true');
      target.focus();
    } else {
      formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  const EMAIL_REGEX = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    formError.hidden = true;
    const email = emailInput.value.trim();
    const emailConfirm = confirmInput.value.trim();
    const username = normalize(usernameInput.value);

    if (!EMAIL_REGEX.test(email)) return showFormError('একটি সঠিক ইমেইল ঠিকানা দিন।', 'email');
    if (email.toLowerCase() !== emailConfirm.toLowerCase()) return showFormError('দুটি ইমেইল ঠিকানা মেলেনি। আবার দেখে নিন।', 'email_confirm');
    if (!username) return showFormError('একটি ব্যবহারকারী নাম দিন।', 'username');
    if (usernameState === 'invalid') return showFormError('ব্যবহারকারী নামটি গ্রহণযোগ্য নয়। অন্য একটি নাম বেছে নিন।', 'username');
    if (!consent.checked) return showFormError('আবেদন জমা দিতে তথ্য ব্যবহারের শর্তে সম্মতি দিন।', 'consent');

    setBusy(submitBtn, true, 'জমা দেওয়া হচ্ছে...');
    const { ok, data } = await api(`/api/events/${eventId}/register`, {
      method: 'POST',
      body: { email, email_confirm: emailConfirm, username, consent: true, website: document.getElementById('website').value }
    });
    if (ok && data.token) {
      saveApplication({ token: data.token, username: data.username, at: Date.now() });
      window.location.href = data.statusUrl;
      return;
    }
    setBusy(submitBtn, false);
    if (!ok) showFormError(data.error || 'আবেদন জমা দিতে সমস্যা হয়েছে। আবার চেষ্টা করুন।', data.field);
  });

  // --- Existing account: join the event leaderboard ---
  const joinForm = document.getElementById('joinForm');
  if (joinForm) {
    const joinInput = document.getElementById('joinUsername');
    const joinBtn = document.getElementById('joinBtn');
    const joinMessage = document.getElementById('joinMessage');
    joinForm.addEventListener('submit', async e => {
      e.preventDefault();
      const username = normalize(joinInput.value);
      if ([...username].length < 3) {
        joinMessage.innerHTML = alertHtml('error', 'আপনার উইকিপিডিয়া ব্যবহারকারী নামটি লিখুন।');
        joinInput.focus();
        return;
      }
      setBusy(joinBtn, true, 'যুক্ত করা হচ্ছে...');
      const { ok, data } = await api(`/api/events/${eventId}/join`, {
        method: 'POST',
        body: { username, website: document.getElementById('joinWebsite').value }
      });
      setBusy(joinBtn, false);
      if (ok && data.username) {
        const link = ` <a class="font-bold" href="${esc(data.statsUrl)}">লিডারবোর্ড দেখুন</a>`;
        joinMessage.innerHTML = data.already
          ? alertHtml('success', `${data.username} ইতিমধ্যে এই ইভেন্টে যুক্ত আছেন।`, link)
          : alertHtml('success', `আপনি "${data.username}" নামে ইভেন্টে যুক্ত হয়েছেন! কয়েক মিনিটের মধ্যে আপনার সম্পাদনাগুলো লিডারবোর্ডে দেখা যাবে।`, link);
        joinForm.reset();
      } else if (!ok) {
        joinMessage.innerHTML = alertHtml('error', data.error || 'যুক্ত করা যায়নি। আবার চেষ্টা করুন।');
      }
    });
  }
})();
