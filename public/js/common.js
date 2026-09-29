// Shared helpers for every page: escaping, API calls with the CSRF token,
// toasts, Bangla formatting, modals and the navigation menus.
(function () {
  'use strict';

  const meta = name => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : '';
  };
  const sprite = meta('icon-sprite') || '/static/icons.svg';

  // Escape text before inserting it into HTML
  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]
    ));
  }

  function icon(name, className) {
    return `<svg class="icon ${className || ''}" aria-hidden="true" focusable="false"><use href="${sprite}#${name}"></use></svg>`;
  }

  let authRedirectPending = false;
  function onAuthRequired(message) {
    if (authRedirectPending) return;
    authRedirectPending = true;
    toast(message || 'আপনার সেশনের মেয়াদ শেষ হয়েছে। আবার লগ ইন করুন।', 'error');
    setTimeout(() => { window.location.href = '/login?reauth=1'; }, 2500);
  }

  // JSON API call. Always resolves to { ok, status, data } unless aborted.
  async function api(url, options) {
    const { method = 'GET', body, signal } = options || {};
    const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin', signal };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (method !== 'GET') init.headers['X-CSRF-Token'] = meta('csrf-token');
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      return { ok: false, status: 0, data: { success: false, error: 'সার্ভারের সাথে যোগাযোগ করা যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।' } };
    }
    let data;
    try {
      data = await res.json();
    } catch {
      data = { success: false, error: 'সার্ভার থেকে অপ্রত্যাশিত উত্তর এসেছে। আবার চেষ্টা করুন।' };
    }
    if (res.status === 401 && data.code === 'auth_required' && document.body.dataset.admin === 'true') {
      onAuthRequired(data.error);
    }
    return { ok: res.ok && data.success !== false, status: res.status, data };
  }

  function toast(message, type, timeout) {
    const region = document.getElementById('toastRegion');
    if (!region) return;
    const kind = type || 'info';
    const el = document.createElement('div');
    el.className = `toast alert-${kind}`;
    const icons = { success: icon('check_circle'), error: icon('error'), warning: icon('warning'), info: icon('info') };
    el.innerHTML = `${icons[kind] || icons.info}<p class="flex-1"></p>
      <button type="button" class="btn btn-ghost btn-sm p-xs" aria-label="বন্ধ করুন">${icon('close', 'icon-sm')}</button>`;
    el.querySelector('p').textContent = message;
    el.querySelector('button').addEventListener('click', () => el.remove());
    region.appendChild(el);
    setTimeout(() => el.remove(), timeout || (kind === 'error' ? 9000 : 5000));
  }

  const dateFormats = {
    datetime: { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    date: { year: 'numeric', month: 'long', day: 'numeric' },
    short: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    time: { hour: 'numeric', minute: '2-digit' },
    day: { month: 'short', day: 'numeric' },
    hour: { hour: 'numeric' }
  };
  // Dates are always shown in Bangladesh time, whatever the device's time zone
  function formatDate(iso, style) {
    if (!iso) return '-';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '-';
    return new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', ...(dateFormats[style || 'datetime'] || dateFormats.datetime) }).format(date);
  }

  function formatNumber(n) {
    return Number(n || 0).toLocaleString('bn-BD');
  }

  function formatBytes(n) {
    const value = Number(n || 0);
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toLocaleString('bn-BD', { maximumFractionDigits: 1 })} MB`;
    if (value >= 1024) return `${(value / 1024).toLocaleString('bn-BD', { maximumFractionDigits: 1 })} KB`;
    return `${value.toLocaleString('bn-BD')} বাইট`;
  }

  // "3 minutes ago" style text
  function timeAgo(iso) {
    if (!iso) return '';
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'এইমাত্র';
    const rtf = new Intl.RelativeTimeFormat('bn', { numeric: 'auto' });
    if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
    if (seconds < 86400) return rtf.format(-Math.round(seconds / 3600), 'hour');
    return rtf.format(-Math.round(seconds / 86400), 'day');
  }

  function pageData() {
    const el = document.getElementById('page-data');
    if (!el) return {};
    try {
      return JSON.parse(el.textContent);
    } catch {
      return {};
    }
  }

  // Button loading state that restores the original label afterwards
  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      if (!button.dataset.label) button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${esc(busyText || 'অপেক্ষা করুন...')}`;
    } else {
      button.disabled = false;
      if (button.dataset.label) {
        button.innerHTML = button.dataset.label;
        delete button.dataset.label;
      }
    }
  }

  // --- Modals: focus moves inside, Esc and the backdrop close them ---
  let openModalState = null;
  const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function openModal(modal) {
    if (openModalState) closeModal();
    openModalState = { modal, returnFocus: document.activeElement };
    modal.hidden = false;
    document.body.classList.add('overflow-hidden');
    const first = modal.querySelector('[data-autofocus]') || modal.querySelector(FOCUSABLE);
    if (first) setTimeout(() => first.focus(), 20);
  }

  function closeModal() {
    if (!openModalState) return;
    const { modal, returnFocus } = openModalState;
    modal.hidden = true;
    document.body.classList.remove('overflow-hidden');
    openModalState = null;
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  }

  document.addEventListener('keydown', e => {
    if (!openModalState) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
    } else if (e.key === 'Tab') {
      const items = [...openModalState.modal.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  document.addEventListener('click', e => {
    if (openModalState && e.target === openModalState.modal) closeModal();
    if (e.target.closest('[data-modal-close]')) closeModal();
  });

  // --- Navigation: mobile menu and dropdowns ---
  const menuToggle = document.querySelector('[data-menu-toggle]');
  const menu = document.getElementById('mobileMenu');
  if (menuToggle && menu) {
    menuToggle.addEventListener('click', () => {
      const open = menu.classList.toggle('hidden') === false;
      menuToggle.setAttribute('aria-expanded', String(open));
    });
  }

  document.querySelectorAll('[data-dropdown]').forEach(dropdown => {
    const toggle = dropdown.querySelector('[data-dropdown-toggle]');
    const panel = dropdown.querySelector('[data-dropdown-menu]');
    const setOpen = open => {
      panel.classList.toggle('hidden', !open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      setOpen(panel.classList.contains('hidden'));
    });
    document.addEventListener('click', e => {
      if (!dropdown.contains(e.target)) setOpen(false);
    });
    dropdown.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        setOpen(false);
        toggle.focus();
      }
    });
  });

  // Copy-to-clipboard buttons: <button data-copy="text">
  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      toast('কপি করা হয়েছে।', 'success', 2500);
    } catch {
      toast('কপি করা যায়নি। নিজে নির্বাচন করে কপি করুন।', 'error');
    }
  });

  window.App = { esc, icon, api, toast, formatDate, formatNumber, formatBytes, timeAgo, pageData, setBusy, openModal, closeModal };
})();
