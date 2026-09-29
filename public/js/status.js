// Application status page: shows the current state and polls while pending.
(function () {
  'use strict';
  const { api, icon, pageData, toast } = window.App;
  const data = pageData();

  const STATES = {
    pending: {
      icon: icon('hourglass_top', 'icon-xl'), tone: 'bg-surface-container-high text-on-surface-variant',
      title: 'আবেদন জমা হয়েছে', text: 'আপনার আবেদনটি আয়োজকদের পর্যালোচনার অপেক্ষায় আছে। অনুমোদন হলে আপনার ইমেইলে উইকিপিডিয়ার পাসওয়ার্ড যাবে।'
    },
    processing: {
      icon: icon('sync', 'icon-xl animate-spin'), tone: 'bg-primary/15 text-primary',
      title: 'অ্যাকাউন্ট তৈরি হচ্ছে', text: 'আয়োজকরা এখনই আপনার অ্যাকাউন্ট তৈরি করছেন। একটু অপেক্ষা করুন।'
    },
    approved: {
      icon: icon('check_circle', 'icon-xl'), tone: 'bg-secondary/15 text-secondary',
      title: 'অ্যাকাউন্ট তৈরি হয়েছে!', text: 'অভিনন্দন! আপনার উইকিপিডিয়া অ্যাকাউন্ট তৈরি হয়েছে এবং ইমেইলে একটি সাময়িক পাসওয়ার্ড পাঠানো হয়েছে।'
    },
    declined: {
      icon: icon('cancel', 'icon-xl'), tone: 'bg-error/15 text-error',
      title: 'আবেদনটি গৃহীত হয়নি', text: 'দুঃখিত, আয়োজকরা এই আবেদনটি অনুমোদন করেননি। চাইলে অন্য একটি নাম দিয়ে আবার আবেদন করতে পারেন।'
    }
  };

  const el = id => document.getElementById(id);

  function render(status, reason, createdOnWiki) {
    const s = STATES[status] || STATES.pending;
    el('statusIcon').className = `mx-auto w-20 h-20 rounded-pill flex items-center justify-center ${s.tone}`;
    el('statusIcon').innerHTML = s.icon;
    el('statusTitle').textContent = s.title;
    el('statusText').textContent = s.text;
    el('nextSteps').hidden = status !== 'approved';
    el('pendingHelp').hidden = status !== 'pending' && status !== 'processing';
    el('declineReason').hidden = !(status === 'declined' && reason);
    if (reason) el('declineReason').querySelector('p').textContent = `আয়োজকদের মন্তব্য: ${reason}`;
    if (createdOnWiki) el('loginLink').href = `https://${createdOnWiki}/wiki/Special:UserLogin`;
  }

  render(data.status, data.reason, data.createdOnWiki);
  el('statusUrl').value = window.location.href;
  el('copyStatusUrl').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast('লিংক কপি করা হয়েছে।', 'success', 2500);
    } catch {
      el('statusUrl').select();
    }
  });

  // Check for a decision every 20 seconds while the page is open
  let current = data.status;
  async function poll() {
    if (current !== 'pending' && current !== 'processing') return;
    if (!document.hidden) {
      const { ok, data: body } = await api(`/api/status/${encodeURIComponent(data.token)}`);
      if (ok && body.request.status !== current) {
        current = body.request.status;
        render(current, body.request.decision_reason, body.request.created_on_wiki);
      }
    }
    setTimeout(poll, 20000);
  }
  setTimeout(poll, 20000);
})();
