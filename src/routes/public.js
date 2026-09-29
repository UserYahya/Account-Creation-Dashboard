const express = require('express');
const QRCode = require('qrcode');
const { asyncHandler, absoluteUrl, textLines, notFound } = require('./util');
const { eventPhase, isRegistrationOpen } = require('../time');
const { maskEmail } = require('../validation');

function createPublicRoutes({ config, db, data }) {
  const router = express.Router();
  const requestByToken = db.prepare('SELECT * FROM requests WHERE status_token = ?');

  function renderRegistration(req, res, event) {
    const instructions = textLines(event.instructions || data.getSetting('additional_instructions', ''));
    const eventPath = `/event/${event.id}`;
    res.render('register', {
      title: `অ্যাকাউন্ট তৈরির আবেদন — ${event.name}`,
      event,
      instructions,
      eventUrl: absoluteUrl(config, req, eventPath),
      otherEvents: data.openEvents().filter(e => e.id !== event.id)
    });
  }

  function renderClosed(req, res, event) {
    res.render('closed', {
      title: `নিবন্ধন বন্ধ — ${event.name}`,
      event,
      phase: eventPhase(event),
      otherEvents: data.openEvents().filter(e => e.id !== event.id)
    });
  }

  // Home: the registration form when exactly one event is open, otherwise a
  // list of events to choose from.
  router.get('/', (req, res) => {
    const open = data.openEvents();
    if (open.length === 1) return renderRegistration(req, res, open[0]);
    const groups = data.groupedEvents();
    res.render('home', {
      title: 'ইভেন্ট ড্যাশবোর্ড',
      open,
      upcoming: groups.upcoming.slice(0, 6),
      finished: groups.finished.slice(0, 6)
    });
  });

  router.get('/events', (req, res) => {
    res.render('events', { title: 'ইভেন্টসমূহ', groups: data.groupedEvents() });
  });

  router.get('/event/:id', (req, res) => {
    const event = data.getEvent(req.params.id);
    if (!event) return notFound(res, 'এই ইভেন্টটি খুঁজে পাওয়া যায়নি। হয়তো এটি মুছে ফেলা হয়েছে।');
    if (isRegistrationOpen(event)) return renderRegistration(req, res, event);
    renderClosed(req, res, event);
  });

  router.get('/event/:id/stats', (req, res) => {
    const event = data.getEvent(req.params.id);
    if (!event) return notFound(res, 'এই ইভেন্টটি খুঁজে পাওয়া যায়নি।');
    res.render('stats', { title: `পরিসংখ্যান — ${event.name}`, event, phase: eventPhase(event) });
  });

  // Full-screen page for projecting during the event
  router.get('/event/:id/display', (req, res) => {
    const event = data.getEvent(req.params.id);
    if (!event) return notFound(res, 'এই ইভেন্টটি খুঁজে পাওয়া যায়নি।');
    const eventUrl = absoluteUrl(config, req, `/event/${event.id}`);
    res.render('display', {
      title: `প্রজেক্টর — ${event.name}`,
      event,
      eventUrl,
      shortUrl: eventUrl.replace(/^https?:\/\//, ''),
      registrationOpen: isRegistrationOpen(event)
    });
  });

  // Old links: /stats and /stats?archive=true
  router.get('/stats', (req, res) => {
    const { ongoing } = data.groupedEvents();
    if (req.query.archive !== 'true' && ongoing.length === 1) {
      return res.redirect(`/event/${ongoing[0].id}/stats`);
    }
    res.redirect(req.query.archive === 'true' ? '/events#finished' : '/events');
  });

  // Old success page link
  router.get('/success', (req, res) => {
    const event = data.getEvent(req.query.eventId);
    res.redirect(event ? `/event/${event.id}` : '/');
  });

  router.get('/status/:token', (req, res) => {
    const request = requestByToken.get(String(req.params.token));
    if (!request) return notFound(res, 'এই আবেদনটি খুঁজে পাওয়া যায়নি। লিংকটি ঠিকভাবে কপি করা হয়েছে কিনা দেখুন।');
    const event = request.event_id ? data.getEvent(request.event_id) : null;
    res.render('status', {
      title: 'আবেদনের অবস্থা',
      request: { ...request, email: undefined, maskedEmail: maskEmail(request.email) },
      event
    });
  });

  router.get('/about', (req, res) => res.render('about', { title: 'ড্যাশবোর্ড পরিচিতি' }));
  router.get('/privacy', (req, res) => res.render('privacy', { title: 'গোপনীয়তা ও তথ্য ব্যবহার', retentionDays: config.emailRetentionDays }));

  async function sendQr(res, url, size) {
    const width = Math.min(1200, Math.max(200, Number(size) || 400));
    const buffer = await QRCode.toBuffer(url, { width, margin: 2, errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  }

  router.get('/qr.png', asyncHandler(async (req, res) => {
    await sendQr(res, absoluteUrl(config, req, '/'), req.query.size);
  }));

  router.get('/event/:id/qr.png', asyncHandler(async (req, res) => {
    const event = data.getEvent(req.params.id);
    if (!event) return res.status(404).send('Not found');
    await sendQr(res, absoluteUrl(config, req, `/event/${event.id}`), req.query.size);
  }));

  return router;
}

module.exports = { createPublicRoutes };
