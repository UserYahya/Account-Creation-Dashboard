const express = require('express');
const { requireAdmin, requireDeveloper } = require('../security');
const { eventPhase, utcIsoToBdLocal } = require('../time');
const { notFound } = require('./util');

function createAdminPages({ config, db, data, accounts }) {
  const router = express.Router();
  const auditEntries = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500');

  function actor(req) {
    return { username: req.session.username, adminWiki: req.session.adminWiki, adminWikis: req.session.adminWikis || [], isMock: req.session.isMock };
  }

  // Values for the event form, in Bangladesh time
  function formValues(event) {
    return {
      ...event,
      start_local: utcIsoToBdLocal(event.start_time),
      end_local: utcIsoToBdLocal(event.end_time)
    };
  }

  router.get('/admin', requireAdmin, (req, res) => {
    const groups = data.groupedEvents();
    const counts = data.eventCounts();
    const totals = Object.values(counts).reduce((acc, c) => {
      acc.pending += c.pending + c.processing;
      acc.approved += c.approved;
      return acc;
    }, { pending: 0, approved: 0 });
    res.render('admin/home', { title: 'অ্যাডমিন ড্যাশবোর্ড', groups, counts, totals });
  });

  router.get('/admin/events/new', requireAdmin, (req, res) => {
    const now = new Date();
    const inAWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    res.render('admin/event-new', {
      title: 'নতুন ইভেন্ট',
      event: formValues({
        name: '',
        workshop_url: '',
        start_time: now.toISOString(),
        end_time: inAWeek.toISOString(),
        target_wikis: 'bn.wikipedia.org',
        target_namespaces: 'all',
        registration_active: 1,
        allow_self_enroll: 1,
        account_wiki: null,
        welcome_message: null,
        instructions: null,
        goal_edits: null,
        goal_articles: null
      }),
      adminWikis: config.adminWikis,
      globalWelcome: data.getSetting('welcome_message', ''),
      globalInstructions: data.getSetting('additional_instructions', '')
    });
  });

  router.get('/admin/events/:id', requireAdmin, (req, res) => {
    const event = data.getEvent(req.params.id);
    if (!event) return notFound(res, 'এই ইভেন্টটি খুঁজে পাওয়া যায়নি।');
    res.render('admin/event', {
      title: `${event.name} — অ্যাডমিন`,
      event: formValues(event),
      phase: eventPhase(event),
      accountWiki: accounts.accountWikiFor(event, actor(req)),
      adminWikis: config.adminWikis,
      counts: data.eventCounts()[event.id] || { pending: 0, processing: 0, approved: 0, declined: 0, participants: 0 },
      globalWelcome: data.getSetting('welcome_message', ''),
      globalInstructions: data.getSetting('additional_instructions', '')
    });
  });

  router.get('/admin/settings', requireAdmin, (req, res) => {
    res.render('admin/settings', {
      title: 'সাধারণ সেটিংস',
      welcome: data.getSetting('welcome_message', ''),
      instructions: data.getSetting('additional_instructions', ''),
      retentionDays: config.emailRetentionDays
    });
  });

  router.get('/admin/audit', requireAdmin, requireDeveloper, (req, res) => {
    const events = new Map(data.listEvents().map(e => [e.id, e.name]));
    res.render('admin/audit', { title: 'কার্যক্রমের লগ', entries: auditEntries.all(), events });
  });

  return router;
}

module.exports = { createAdminPages };
