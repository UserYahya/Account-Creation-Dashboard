// Global settings page (admin)
(function () {
  'use strict';
  const { api, setBusy, toast } = window.App;
  const form = document.getElementById('settingsForm');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const button = document.getElementById('saveSettings');
    setBusy(button, true, 'সংরক্ষণ হচ্ছে...');
    const { ok, data } = await api('/api/admin/settings', {
      method: 'POST',
      body: {
        additional_instructions: form.elements.namedItem('additional_instructions').value,
        welcome_message: form.elements.namedItem('welcome_message').value
      }
    });
    setBusy(button, false);
    toast(ok ? 'সেটিংস সংরক্ষণ হয়েছে।' : data.error || 'সংরক্ষণ করা যায়নি।', ok ? 'success' : 'error');
  });
})();
