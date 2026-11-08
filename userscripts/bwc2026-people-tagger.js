/**
 * BWC 2026 People Tagger — a Wikimedia Commons user script.
 *
 * Adds a person category (a subcategory of
 * [[Category:People at Bangla WikiConference 2026 by name]]) to images with one click.
 *
 * Instead of printing ~70 names under every image (70 × 200 buttons on a full
 * category page), the page gets:
 *   - ONE floating name palette (built once), with type-to-search, recently
 *     used names and a large preview of the image you are tagging;
 *   - under each image only a ☐ checkbox, the people already tagged, and a
 *     small "＋" button.
 * Select one or many images, click a name (or type a few letters and press
 * Enter) and the category is added to every selected image. Several names
 * clicked in a row are saved together as one edit per image.
 *
 * INSTALL
 *   1. Save this file on Commons as  User:<you>/BWC2026PeopleTagger.js
 *   2. Add this line to  User:<you>/common.js :
 *        mw.loader.load('//commons.wikimedia.org/w/index.php?title=User:<you>/BWC2026PeopleTagger.js&action=raw&ctype=text/javascript');
 *   (or paste the whole file into common.js).
 *
 * It starts by itself on category and file pages that are part of the
 * Bangla WikiConference 2026 tree. On any other page that has images, use
 * Tools → "People tagger".
 *
 * OPTIONAL SETTINGS — put this in common.js ABOVE the mw.loader.load line:
 *   window.bwcPeopleTaggerConfig = {
 *     labels: { 'Category:Md. Abdullah Al Mamun': 'Mamun' }, // fix a short name
 *     exclude: [ 'Category:Some non-person subcategory' ],    // hide from palette
 *     saveDelay: 2000                                         // ms before saving
 *   };
 *
 * KEYS (in the palette search box)
 *   Enter            add the highlighted (first) name
 *   Enter (empty)    next image, when one image is selected
 *   ← / →  (empty)   previous / next image
 *   Esc              clear the search
 *   /                (anywhere on the page) jump to the search box
 */
/* global mw */
(function () {
	'use strict';

	if (window.bwcPeopleTaggerLoaded) {
		return;
	}
	window.bwcPeopleTaggerLoaded = true;

	const DEFAULTS = {
		// Category whose subcategories are the people.
		peopleCategory: 'Category:People at Bangla WikiConference 2026 by name',
		// Start automatically when the page title, or one of its categories, matches.
		activateRegex: /Bangla[ _]WikiConference[ _]2026/i,
		autoStart: true,
		// Short names to show instead of the generated ones: { 'Category:Full Name': 'Nick' }.
		labels: {},
		// Subcategories to leave out of the palette.
		exclude: [],
		// $1 = the list of categories.
		summaryAdd: 'Tagging people at Bangla WikiConference 2026: $1',
		summaryRemove: 'Removing person category: $1',
		minor: true,
		watchlist: 'nochange',
		// Wait this long after the last click before saving, so several names
		// end up in one edit per image.
		saveDelay: 2000,
		previewWidth: 960,
		recentCount: 8,
		cacheMinutes: 60
	};

	const cfg = Object.assign({}, DEFAULTS, window.bwcPeopleTaggerConfig || {});
	if (typeof cfg.activateRegex === 'string') {
		cfg.activateRegex = new RegExp(cfg.activateRegex, 'i');
	}

	const LS_PEOPLE = 'bwcpt-people:' + cfg.peopleCategory;
	const LS_RECENT = 'bwcpt-recent';
	const LS_UI = 'bwcpt-ui';

	let api = null;
	let started = false;
	const ui = {};
	const state = {
		files: [], // { title, idx, box, img, check, tagsEl, cats:Set, pending:Set, removing:Set, inflight:Set, errors:Map, preview }
		byTitle: new Map(),
		people: [], // { cat, full, label, search }
		byCat: new Map(),
		selected: new Set(),
		focus: null,
		lastClicked: -1,
		timer: null,
		saving: false,
		edits: 0,
		loading: true,
		filePage: false
	};

	/* ---------------------------------------------------------------- utils */

	function el(tag, props, ...children) {
		const node = document.createElement(tag);
		if (props) {
			Object.keys(props).forEach(function (k) {
				if (k === 'dataset') {
					Object.assign(node.dataset, props[k]);
				} else {
					node[k] = props[k];
				}
			});
		}
		children.forEach(function (c) {
			if (c != null) {
				node.append(c);
			}
		});
		return node;
	}

	function lsGet(key) {
		try {
			return JSON.parse(localStorage.getItem(key));
		} catch (e) {
			return null;
		}
	}

	function lsSet(key, value) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch (e) { /* storage blocked or full: not important */ }
	}

	function norm(s) {
		return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
	}

	function bare(cat) {
		return cat.replace(/^[^:]+:/, '');
	}

	function sleep(ms) {
		return new Promise(function (r) {
			setTimeout(r, ms);
		});
	}

	// mw.Api returns jQuery promises that reject with (code, data); turn that into an Error.
	function call(jqPromise) {
		return new Promise(function (resolve, reject) {
			jqPromise.then(resolve, function (code, data) {
				const info = data && data.error && data.error.info;
				const err = new Error(info || (data && data.exception) || code || 'request failed');
				err.code = code;
				reject(err);
			});
		});
	}

	async function withRetry(fn) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await fn();
			} catch (e) {
				// Not retried on network errors: an append that did reach the server would be added twice.
				if (attempt < 3 && (e.code === 'ratelimited' || e.code === 'editconflict')) {
					setStatus(e.code === 'ratelimited' ? 'Rate limited, waiting…' : 'Edit conflict, retrying…');
					await sleep(e.code === 'ratelimited' ? 15000 : 2000);
					setStatus('');
					continue;
				}
				throw e;
			}
		}
	}

	function titleFromHref(href) {
		if (!href) {
			return null;
		}
		const m = href.match(/\/wiki\/([^?#]+)/);
		let t = m ? m[1] : mw.util.getParamValue('title', href);
		if (!t) {
			return null;
		}
		try {
			t = decodeURIComponent(t);
		} catch (e) { /* keep as is */ }
		return t.replace(/_/g, ' ');
	}

	/* ------------------------------------------------------- short names */

	// Words that come before the name people actually use (Md., Mohammad, Syed, Dr., A.K.M., মোঃ …).
	const PREFIXES = new Set([
		'md', 'mohd', 'mohammad', 'mohammed', 'muhammad', 'muhammed', 'mohammod', 'mohamad', 'mohamed',
		'mst', 'most', 'mosammat', 'mosamat', 'mosammad', 'sk', 'sheikh', 'shaikh', 'syed', 'sayed', 'sayeed',
		'dr', 'prof', 'mr', 'mrs', 'ms', 'miss', 'engr', 'adv',
		'মো', 'মোহাম্মদ', 'মুহাম্মদ', 'মোহাম্মাদ', 'মোছা', 'মোসা', 'মোসাম্মৎ', 'শেখ', 'সৈয়দ', 'ড', 'ডা'
	]);

	function isPrefix(word) {
		const w = word.replace(/(?:[.:,]|\u0983)+$/, '').toLowerCase();
		return PREFIXES.has(w) ||
			w.length <= 1 || // single initial: "A", "M."
			/^([^\s.]{1,2}\.)+[^\s.]?$/.test(word); // dotted initials: "A.K.M.", "S.M."
	}

	function cleanName(cat) {
		return bare(cat)
			.replace(/\s*\([^)]*\)/g, ' ') // "Yahya (Wikimedian)"
			.replace(/\s+(at|in|during)\s+.*$/i, '') // "Yahya at Bangla WikiConference 2026"
			.replace(/\s+/g, ' ')
			.trim();
	}

	function buildPeople(cats) {
		const exclude = new Set(cfg.exclude.map(function (c) {
			return /^Category:/i.test(c) ? c : 'Category:' + c;
		}));
		const people = cats.filter(function (c) {
			return !exclude.has(c);
		}).map(function (cat) {
			const full = cleanName(cat) || bare(cat);
			const words = full.split(' ');
			let i = words.findIndex(function (w) {
				return !isPrefix(w);
			});
			if (i < 0) {
				i = 0;
			}
			return { cat: cat, full: full, words: words, i: i, label: words[i].replace(/[,;]+$/, '') };
		});

		// Two people with the same first name: add the next word's initial, else the full name.
		const groups = new Map();
		people.forEach(function (p) {
			const k = p.label.toLowerCase();
			groups.set(k, (groups.get(k) || []).concat(p));
		});
		groups.forEach(function (g) {
			if (g.length < 2) {
				return;
			}
			g.forEach(function (p) {
				const next = p.words[p.i + 1];
				p.label = next ? p.label + ' ' + next.charAt(0) + '.' : p.full;
			});
			const count = {};
			g.forEach(function (p) {
				count[p.label] = (count[p.label] || 0) + 1;
			});
			g.forEach(function (p) {
				if (count[p.label] > 1) {
					p.label = p.full;
				}
			});
		});

		people.forEach(function (p) {
			const override = cfg.labels[p.cat] || cfg.labels[bare(p.cat)];
			if (override) {
				p.label = override;
			}
			p.search = norm(p.label + ' ' + p.full);
			delete p.words;
			delete p.i;
		});
		people.sort(function (a, b) {
			return a.label.localeCompare(b.label);
		});

		state.people = people;
		state.byCat = new Map(people.map(function (p) {
			return [p.cat, p];
		}));
	}

	function labelOf(cat) {
		const p = state.byCat.get(cat);
		return p ? p.label : cleanName(cat);
	}

	/* --------------------------------------------------------- loading */

	async function loadPeople(force) {
		const cached = lsGet(LS_PEOPLE);
		if (!force && cached && Array.isArray(cached.cats) && Date.now() - cached.t < cfg.cacheMinutes * 60000) {
			return cached.cats;
		}
		const cats = [];
		let cont = {};
		do {
			const r = await call(api.get(Object.assign({
				action: 'query',
				list: 'categorymembers',
				cmtitle: cfg.peopleCategory,
				cmtype: 'subcat',
				cmlimit: 'max',
				formatversion: 2
			}, cont)));
			r.query.categorymembers.forEach(function (m) {
				cats.push(m.title);
			});
			cont = r.continue;
		} while (cont);
		lsSet(LS_PEOPLE, { t: Date.now(), cats: cats });
		return cats;
	}

	// Current categories (and a big preview URL) of every image on the page, 50 per request.
	async function loadFileInfo() {
		const titles = state.files.map(function (f) {
			return f.title;
		});
		for (let i = 0; i < titles.length; i += 50) {
			const chunk = titles.slice(i, i + 50);
			const touched = new Set();
			let cont = {};
			do {
				const r = await call(api.get(Object.assign({
					action: 'query',
					titles: chunk,
					prop: 'categories|imageinfo',
					cllimit: 'max',
					iiprop: 'url',
					iiurlwidth: cfg.previewWidth,
					formatversion: 2
				}, cont)));
				const from = {};
				(r.query.normalized || []).forEach(function (n) {
					from[n.to] = n.from;
				});
				(r.query.pages || []).forEach(function (p) {
					const f = state.byTitle.get(p.title) || state.byTitle.get(from[p.title]);
					if (!f) {
						return;
					}
					touched.add(f);
					(p.categories || []).forEach(function (c) {
						f.cats.add(c.title);
					});
					const ii = p.imageinfo && p.imageinfo[0];
					if (ii) {
						f.preview = ii.thumburl || ii.url;
					}
				});
				cont = r.continue;
			} while (cont);
			touched.forEach(renderTags);
			refresh();
		}
	}

	/* ------------------------------------------------------ page scan */

	function addFile(title, box, img) {
		if (!title || state.byTitle.has(title)) {
			return null;
		}
		const f = {
			title: title,
			idx: state.files.length,
			box: box,
			img: img,
			cats: new Set(),
			pending: new Set(),
			removing: new Set(),
			inflight: new Set(),
			errors: new Map(),
			preview: null
		};
		state.files.push(f);
		state.byTitle.set(title, f);
		return f;
	}

	function scanPage() {
		if (state.filePage) {
			const box = document.getElementById('file');
			if (box) {
				const f = addFile(mw.config.get('wgPageName').replace(/_/g, ' '), box, box.querySelector('img'));
				if (f) {
					f.tagsEl = el('div', { className: 'bwcpt-tags bwcpt-tags-filepage' });
					f.tagsEl.dataset.idx = f.idx;
					box.after(f.tagsEl);
					state.selected.add(f);
					state.focus = f;
				}
			}
			return;
		}
		document.querySelectorAll('li.gallerybox').forEach(function (box) {
			const nameLink = box.querySelector('a.galleryfilename');
			let title = nameLink && nameLink.getAttribute('title');
			if (!title || title.indexOf(':') < 0) {
				const link = box.querySelector('.thumb a[href]') || box.querySelector('a[href]');
				title = link && titleFromHref(link.getAttribute('href'));
			}
			if (!title || title.indexOf(':') < 0) {
				return;
			}
			const f = addFile(title, box, box.querySelector('.thumb img') || box.querySelector('img'));
			if (!f) {
				return;
			}
			box.classList.add('bwcpt-box');
			box.dataset.bwcptIdx = f.idx;
			f.check = el('input', {
				type: 'checkbox',
				className: 'bwcpt-check',
				title: 'Select for people tagging (Shift-click selects a range)'
			});
			f.check.dataset.idx = f.idx;
			box.prepend(f.check);
			f.tagsEl = el('div', { className: 'bwcpt-tags' });
			f.tagsEl.dataset.idx = f.idx;
			box.append(f.tagsEl);
		});
	}

	/* ------------------------------------------------- per-image tags */

	function hasPerson(f, cat) {
		return (f.cats.has(cat) && !f.removing.has(cat)) || f.pending.has(cat);
	}

	function personTags(f) {
		const list = [];
		f.cats.forEach(function (c) {
			if (state.byCat.has(c)) {
				list.push(c);
			}
		});
		f.pending.forEach(function (c) {
			if (!f.cats.has(c)) {
				list.push(c);
			}
		});
		f.errors.forEach(function (_msg, c) {
			if (!f.cats.has(c) && !f.pending.has(c)) {
				list.push(c);
			}
		});
		return list.sort(function (a, b) {
			return labelOf(a).localeCompare(labelOf(b));
		});
	}

	function renderTags(f) {
		const row = f.tagsEl;
		if (!row) {
			return;
		}
		row.textContent = '';
		personTags(f).forEach(function (c) {
			let cls = 'bwcpt-tag';
			let tip = bare(c);
			let xTip = 'Remove this category';
			if (f.errors.has(c)) {
				cls += ' bwcpt-tag-error';
				tip = 'Not saved: ' + f.errors.get(c) + '. Click the name to try again.';
				xTip = 'Dismiss';
			} else if (f.removing.has(c)) {
				cls += ' bwcpt-tag-removing';
				tip = 'Being removed';
				xTip = 'Keep it';
			} else if (f.pending.has(c)) {
				cls += ' bwcpt-tag-pending';
				tip = 'Not saved yet';
				xTip = 'Cancel';
			}
			const busy = f.inflight.has(c);
			if (busy) {
				cls += ' bwcpt-tag-busy';
				tip = 'Saving…';
			}
			const tag = el('span', { className: cls, title: tip }, el('span', { className: 'bwcpt-tag-label' }, labelOf(c)));
			tag.dataset.cat = c;
			if (!busy) {
				tag.append(el('button', { type: 'button', className: 'bwcpt-x', title: xTip }, '×'));
			}
			row.append(tag);
		});
		if (!state.filePage) {
			row.append(el('button', {
				type: 'button',
				className: 'bwcpt-plus',
				title: 'Tag people in this image'
			}, '＋'));
		}
	}

	function onTagsClick(e, f) {
		const tag = e.target.closest('.bwcpt-tag');
		if (e.target.closest('.bwcpt-plus')) {
			focusFile(f, { scroll: false });
			return;
		}
		if (!tag) {
			return;
		}
		const c = tag.dataset.cat;
		if (f.inflight.has(c)) {
			return;
		}
		if (e.target.closest('.bwcpt-x')) {
			if (f.errors.has(c)) {
				f.errors.delete(c);
			} else if (f.removing.has(c)) {
				f.removing.delete(c);
			} else if (f.pending.has(c)) {
				f.pending.delete(c);
			} else if (f.cats.has(c)) {
				if (!window.confirm('Remove "' + bare(c) + '" from\n' + f.title + '?')) {
					return;
				}
				f.removing.add(c);
				scheduleSave(0);
			}
		} else if (f.errors.has(c)) {
			f.errors.delete(c);
			f.pending.add(c);
			scheduleSave();
		}
		renderTags(f);
		refresh();
	}

	/* ------------------------------------------------------- selection */

	function setSelected(f, on) {
		if (on) {
			state.selected.add(f);
		} else {
			state.selected.delete(f);
		}
	}

	function onCheck(e, f) {
		const on = e.target.checked;
		if (e.shiftKey && state.lastClicked >= 0) {
			const a = Math.min(state.lastClicked, f.idx);
			const b = Math.max(state.lastClicked, f.idx);
			for (let i = a; i <= b; i++) {
				if (!state.files[i].box.classList.contains('bwcpt-hidden')) {
					setSelected(state.files[i], on);
				}
			}
		} else {
			setSelected(f, on);
		}
		state.lastClicked = f.idx;
		if (on) {
			state.focus = f;
		} else if (state.focus === f) {
			state.focus = null;
		}
		selectionChanged();
		refresh();
	}

	function focusFile(f, opts) {
		state.selected.clear();
		state.selected.add(f);
		state.focus = f;
		state.lastClicked = f.idx;
		setCollapsed(false);
		selectionChanged();
		refresh();
		if (opts && opts.scroll && f.box.scrollIntoView) {
			f.box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
		ui.search.focus();
	}

	function visibleFiles() {
		return state.files.filter(function (f) {
			return !f.box.classList.contains('bwcpt-hidden') || state.selected.has(f);
		});
	}

	function step(dir) {
		if (state.filePage) {
			return;
		}
		const list = visibleFiles();
		const cur = list.indexOf(state.focus);
		const next = cur < 0 ? 0 : cur + dir;
		if (next >= 0 && next < list.length) {
			focusFile(list[next], { scroll: true });
		}
	}

	function selectedFiles() {
		return state.files.filter(function (f) {
			return state.selected.has(f);
		});
	}

	/* --------------------------------------------------------- palette */

	function onChip(cat) {
		const sel = selectedFiles();
		if (!sel.length) {
			mw.notify('First select images: tick ☐ on them, or press ＋ under one image.', { tag: 'bwcpt' });
			ui.panel.classList.add('bwcpt-shake');
			setTimeout(function () {
				ui.panel.classList.remove('bwcpt-shake');
			}, 400);
			return;
		}
		const missing = sel.filter(function (f) {
			return !hasPerson(f, cat);
		});
		if (missing.length) {
			missing.forEach(function (f) {
				f.errors.delete(cat);
				if (f.removing.has(cat)) {
					f.removing.delete(cat);
				} else {
					f.pending.add(cat);
				}
				renderTags(f);
			});
			pushRecent(cat);
			scheduleSave();
		} else {
			// Every selected image already has this person: clicking again undoes unsaved additions,
			// or (after confirming) removes the saved category.
			const unsaved = sel.filter(function (f) {
				return f.pending.has(cat) && !f.inflight.has(cat);
			});
			if (unsaved.length) {
				unsaved.forEach(function (f) {
					f.pending.delete(cat);
					renderTags(f);
				});
			} else {
				const saved = sel.filter(function (f) {
					return f.cats.has(cat) && !f.inflight.has(cat);
				});
				if (saved.length && window.confirm('Remove "' + bare(cat) + '" from ' + saved.length + ' selected image(s)?')) {
					saved.forEach(function (f) {
						f.removing.add(cat);
						renderTags(f);
					});
					scheduleSave(0);
				}
			}
		}
		refresh();
	}

	function pushRecent(cat) {
		let recent = lsGet(LS_RECENT);
		recent = (Array.isArray(recent) ? recent : []).filter(function (c) {
			return c !== cat;
		});
		recent.unshift(cat);
		recent = recent.slice(0, 20);
		lsSet(LS_RECENT, recent);
		// Redrawn when the selection changes, so chips don't jump under the mouse while clicking.
		state.recentDirty = true;
		if (!ui.recent.childNodes.length) {
			renderRecent();
		}
	}

	function selectionChanged() {
		if (state.recentDirty) {
			renderRecent();
		}
	}

	function makeChip(p) {
		const b = el('button', { type: 'button', className: 'bwcpt-chip', title: bare(p.cat) }, p.label);
		b.dataset.cat = p.cat;
		return b;
	}

	function renderNames() {
		ui.names.textContent = '';
		if (!state.people.length) {
			ui.names.append(el('em', { className: 'bwcpt-empty' }, 'No subcategories found in ' + cfg.peopleCategory));
			return;
		}
		state.people.forEach(function (p) {
			ui.names.append(makeChip(p));
		});
		renderRecent();
		filterNames();
	}

	function renderRecent() {
		state.recentDirty = false;
		ui.recent.textContent = '';
		const stored = lsGet(LS_RECENT);
		const recent = (Array.isArray(stored) ? stored : []).filter(function (c) {
			return state.byCat.has(c);
		}).slice(0, cfg.recentCount);
		if (recent.length) {
			ui.recent.append(el('span', { className: 'bwcpt-recent-label' }, 'Recent:'));
			recent.forEach(function (c) {
				ui.recent.append(makeChip(state.byCat.get(c)));
			});
			refreshChips();
		}
		ui.recent.hidden = !recent.length || !!ui.search.value.trim();
	}

	function filterNames() {
		const q = norm(ui.search.value.trim());
		let first = null;
		ui.names.querySelectorAll('.bwcpt-chip').forEach(function (b) {
			const p = state.byCat.get(b.dataset.cat);
			const show = !q || p.search.indexOf(q) >= 0;
			b.hidden = !show;
			b.classList.remove('bwcpt-first');
			if (show && q && !first) {
				first = b;
			}
		});
		if (first) {
			first.classList.add('bwcpt-first');
		}
		ui.recent.hidden = !!q || !ui.recent.querySelector('.bwcpt-chip');
		ui.noMatch.hidden = !q || !!first;
	}

	function onSearchKey(e) {
		const empty = !ui.search.value;
		if (e.key === 'Enter') {
			e.preventDefault();
			const first = ui.names.querySelector('.bwcpt-first');
			if (first) {
				onChip(first.dataset.cat);
				ui.search.value = '';
				filterNames();
			} else if (empty && state.selected.size === 1) {
				step(1);
			}
		} else if (e.key === 'Escape') {
			if (empty) {
				ui.search.blur();
			} else {
				ui.search.value = '';
				filterNames();
			}
		} else if (empty && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
			e.preventDefault();
			step(e.key === 'ArrowRight' ? 1 : -1);
		}
	}

	function setCollapsed(on) {
		ui.panel.classList.toggle('bwcpt-collapsed', on);
		ui.collapseBtn.textContent = on ? '▴' : '▾';
		ui.collapseBtn.title = on ? 'Open the palette' : 'Minimise';
		saveUi();
	}

	function saveUi() {
		lsSet(LS_UI, {
			collapsed: ui.panel.classList.contains('bwcpt-collapsed'),
			big: ui.panel.classList.contains('bwcpt-big'),
			hideTagged: ui.hideTagged.checked
		});
	}

	function buildPanel() {
		const saved = lsGet(LS_UI) || {};
		ui.count = el('span', { className: 'bwcpt-count' });
		ui.collapseBtn = el('button', { type: 'button', className: 'bwcpt-btn', dataset: { act: 'collapse' } });
		const head = el('div', { className: 'bwcpt-head' },
			el('strong', null, 'People'),
			ui.count,
			el('span', { className: 'bwcpt-spacer' }),
			el('button', { type: 'button', className: 'bwcpt-btn', title: 'Select all images', dataset: { act: 'all' } }, 'All'),
			el('button', { type: 'button', className: 'bwcpt-btn', title: 'Clear selection', dataset: { act: 'none' } }, 'None'),
			el('button', { type: 'button', className: 'bwcpt-btn', title: 'Bigger preview', dataset: { act: 'big' } }, '⤢'),
			el('button', { type: 'button', className: 'bwcpt-btn', title: 'Reload the list of people', dataset: { act: 'reload' } }, '⟳'),
			ui.collapseBtn
		);

		ui.previewImg = el('img', { alt: '' });
		ui.previewCap = el('div', { className: 'bwcpt-preview-cap' });
		ui.prevBtn = el('button', { type: 'button', className: 'bwcpt-btn', title: 'Previous image (←)', dataset: { act: 'prev' } }, '‹');
		ui.nextBtn = el('button', { type: 'button', className: 'bwcpt-btn', title: 'Next image (→)', dataset: { act: 'next' } }, '›');
		ui.preview = el('div', { className: 'bwcpt-preview' },
			el('div', { className: 'bwcpt-preview-frame' }, ui.previewImg),
			el('div', { className: 'bwcpt-preview-bar' }, ui.prevBtn, ui.previewCap, ui.nextBtn)
		);
		ui.hint = el('div', { className: 'bwcpt-hint' },
			'Tick ☐ on images (Shift-click for a range) or press ＋ under one image, then click names. ',
			'Several names clicked together are saved as one edit per image.');

		ui.search = el('input', {
			type: 'search',
			className: 'bwcpt-search',
			placeholder: 'Type a name, Enter to add  ( / )',
			autocomplete: 'off',
			spellcheck: false
		});
		ui.recent = el('div', { className: 'bwcpt-recent' });
		ui.names = el('div', { className: 'bwcpt-names' }, el('em', { className: 'bwcpt-empty' }, 'Loading people…'));
		ui.noMatch = el('div', { className: 'bwcpt-empty', hidden: true }, 'No name matches.');

		ui.hideTagged = el('input', { type: 'checkbox', checked: !!saved.hideTagged });
		ui.status = el('span', { className: 'bwcpt-status' });
		ui.saveBtn = el('button', { type: 'button', className: 'bwcpt-btn bwcpt-save', hidden: true, dataset: { act: 'save' } }, 'Save now');
		const foot = el('div', { className: 'bwcpt-foot' },
			state.filePage ? null : el('label', { title: 'Hide images that already have at least one person' }, ui.hideTagged, ' Hide tagged'),
			ui.status,
			ui.saveBtn
		);

		ui.panel = el('div', { className: 'bwcpt-panel', id: 'bwcpt-panel' },
			head,
			el('div', { className: 'bwcpt-body' }, ui.preview, ui.hint, ui.search, ui.recent, ui.names, ui.noMatch, foot)
		);
		if (saved.big) {
			ui.panel.classList.add('bwcpt-big');
		}
		document.body.append(ui.panel);
		setCollapsed(!!saved.collapsed);

		ui.panel.addEventListener('click', function (e) {
			const chip = e.target.closest('.bwcpt-chip');
			if (chip) {
				onChip(chip.dataset.cat);
				return;
			}
			const btn = e.target.closest('[data-act]');
			if (!btn) {
				return;
			}
			switch (btn.dataset.act) {
				case 'all':
					visibleFiles().forEach(function (f) {
						state.selected.add(f);
					});
					selectionChanged();
					break;
				case 'none':
					if (!state.filePage) {
						state.selected.clear();
						state.focus = null;
					}
					selectionChanged();
					break;
				case 'big':
					ui.panel.classList.toggle('bwcpt-big');
					saveUi();
					break;
				case 'reload':
					reloadPeople();
					break;
				case 'collapse':
					setCollapsed(!ui.panel.classList.contains('bwcpt-collapsed'));
					break;
				case 'prev':
					step(-1);
					return;
				case 'next':
					step(1);
					return;
				case 'save':
					flush();
					break;
			}
			refresh();
		});
		ui.search.addEventListener('input', filterNames);
		ui.search.addEventListener('keydown', onSearchKey);
		ui.hideTagged.addEventListener('change', function () {
			saveUi();
			refresh();
		});
	}

	async function reloadPeople() {
		setStatus('Loading people…');
		try {
			buildPeople(await loadPeople(true));
			renderNames();
			state.files.forEach(renderTags);
			setStatus('');
		} catch (e) {
			setStatus('Could not load people: ' + e.message, true);
		}
		refresh();
	}

	/* --------------------------------------------------------- refresh */

	function refreshChips() {
		const sel = selectedFiles();
		const counts = new Map();
		sel.forEach(function (f) {
			state.people.forEach(function (p) {
				if (hasPerson(f, p.cat)) {
					counts.set(p.cat, (counts.get(p.cat) || 0) + 1);
				}
			});
		});
		ui.panel.querySelectorAll('.bwcpt-chip').forEach(function (b) {
			const n = counts.get(b.dataset.cat) || 0;
			b.classList.toggle('bwcpt-on', n > 0 && n === sel.length);
			b.classList.toggle('bwcpt-some', n > 0 && n < sel.length);
		});
	}

	function refreshPreview() {
		let f = state.focus && state.selected.has(state.focus) ? state.focus : null;
		if (!f) {
			f = selectedFiles()[0] || null;
		}
		const n = state.selected.size;
		ui.preview.hidden = !f || state.filePage;
		ui.hint.hidden = !!f;
		if (!f || state.filePage) {
			return;
		}
		const src = f.preview || (f.img && (f.img.currentSrc || f.img.src)) || '';
		if (ui.previewImg.getAttribute('src') !== src) {
			ui.previewImg.src = src;
		}
		ui.previewCap.textContent = '';
		ui.previewCap.append(el('a', {
			href: mw.util.getUrl(f.title),
			target: '_blank',
			title: f.title
		}, bare(f.title)));
		if (n > 1) {
			ui.previewCap.append(el('span', { className: 'bwcpt-more' }, ' + ' + (n - 1) + ' more'));
		}
		const list = visibleFiles();
		const i = list.indexOf(f);
		ui.prevBtn.disabled = i <= 0;
		ui.nextBtn.disabled = i < 0 || i >= list.length - 1;
	}

	function refresh() {
		if (!ui.panel) {
			return;
		}
		const hide = ui.hideTagged.checked && !state.filePage;
		state.files.forEach(function (f) {
			const sel = state.selected.has(f);
			if (f.check) {
				f.check.checked = sel;
			}
			if (!state.filePage) {
				f.box.classList.toggle('bwcpt-sel', sel);
				f.box.classList.toggle('bwcpt-focus', sel && f === state.focus);
				const tagged = state.people.some(function (p) {
					return hasPerson(f, p.cat);
				});
				f.box.classList.toggle('bwcpt-hidden', hide && tagged && !sel);
			}
		});
		const n = state.selected.size;
		ui.count.textContent = state.filePage ? 'this file' : n + ' of ' + state.files.length + ' selected';
		ui.panel.classList.toggle('bwcpt-nosel', !n);
		refreshChips();
		refreshPreview();
		updateStatus();
	}

	/* ----------------------------------------------------------- saving */

	function isDirty(f) {
		let dirty = f.removing.size > 0;
		f.pending.forEach(function (c) {
			if (!f.inflight.has(c)) {
				dirty = true;
			}
		});
		return dirty;
	}

	function scheduleSave(delay) {
		clearTimeout(state.timer);
		state.timer = setTimeout(flush, delay == null ? cfg.saveDelay : delay);
		updateStatus();
	}

	async function flush() {
		clearTimeout(state.timer);
		state.timer = null;
		if (state.saving) {
			return;
		}
		state.saving = true;
		const dirty = state.files.filter(isDirty);
		for (const f of dirty) {
			updateStatus();
			try {
				await saveFile(f);
			} catch (e) {
				mw.notify('People tagger: ' + e.message, { type: 'error' });
			}
		}
		state.saving = false;
		if (state.files.some(isDirty)) {
			scheduleSave();
		}
		refresh();
	}

	function summary(template, cats) {
		return template.replace('$1', cats.map(function (c) {
			return '[[:' + c + ']]';
		}).join(', '));
	}

	function appendCats(f, cats) {
		return call(api.postWithToken('csrf', {
			action: 'edit',
			title: f.title,
			appendtext: cats.map(function (c) {
				return '\n[[' + c + ']]';
			}).join(''),
			summary: summary(cfg.summaryAdd, cats),
			minor: cfg.minor ? 1 : undefined,
			nocreate: 1,
			watchlist: cfg.watchlist,
			formatversion: 2
		}));
	}

	function escapeRe(s) {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	// [[Category:Name]] or [[ category : name | sort key ]], first letter case-insensitive, spaces = underscores.
	function catLinkRe(cat) {
		const name = bare(cat);
		const first = name.charAt(0);
		const firstPat = first.toUpperCase() !== first.toLowerCase() ?
			'[' + escapeRe(first.toUpperCase()) + escapeRe(first.toLowerCase()) + ']' :
			escapeRe(first);
		const rest = escapeRe(name.slice(1)).replace(/[ _]+/g, '[ _]+');
		return new RegExp('[ \\t]*\\[\\[[ _]*[Cc]ategory[ _]*:[ _]*' + firstPat + rest + '[ _]*(?:\\|[^\\]]*)?\\]\\][ \\t]*\\n?', 'g');
	}

	// Returns the categories that were not found in the wikitext (e.g. added by a template).
	async function removeCats(f, cats) {
		const r = await call(api.get({
			action: 'query',
			prop: 'revisions',
			rvprop: 'content|timestamp',
			rvslots: 'main',
			titles: f.title,
			curtimestamp: 1,
			formatversion: 2
		}));
		const page = r.query.pages[0];
		const rev = page && page.revisions && page.revisions[0];
		if (!rev) {
			throw new Error('could not read the page');
		}
		let text = rev.slots.main.content;
		const notFound = [];
		cats.forEach(function (c) {
			const next = text.replace(catLinkRe(c), '');
			if (next === text) {
				notFound.push(c);
			}
			text = next;
		});
		const found = cats.filter(function (c) {
			return notFound.indexOf(c) < 0;
		});
		if (found.length) {
			await call(api.postWithToken('csrf', {
				action: 'edit',
				title: f.title,
				text: text,
				basetimestamp: rev.timestamp,
				starttimestamp: r.curtimestamp,
				summary: summary(cfg.summaryRemove, found),
				minor: cfg.minor ? 1 : undefined,
				nocreate: 1,
				watchlist: cfg.watchlist,
				formatversion: 2
			}));
			state.edits++;
		}
		return notFound;
	}

	async function saveFile(f) {
		const adds = [];
		f.pending.forEach(function (c) {
			if (f.cats.has(c)) {
				f.pending.delete(c); // already there (someone else added it)
			} else if (!f.inflight.has(c)) {
				adds.push(c);
			}
		});
		const removes = Array.from(f.removing);
		if (!adds.length && !removes.length) {
			return;
		}
		adds.concat(removes).forEach(function (c) {
			f.inflight.add(c);
		});
		renderTags(f);

		if (removes.length) {
			try {
				const notFound = await withRetry(function () {
					return removeCats(f, removes);
				});
				removes.forEach(function (c) {
					if (notFound.indexOf(c) < 0) {
						f.cats.delete(c);
					}
				});
				if (notFound.length) {
					mw.notify(bare(f.title) + ': ' + notFound.map(bare).join(', ') +
						' is not written on the page (probably added by a template), so it was not removed.', { type: 'warn' });
				}
			} catch (e) {
				mw.notify('Could not remove from ' + bare(f.title) + ': ' + e.message, { type: 'error' });
			}
			removes.forEach(function (c) {
				f.removing.delete(c);
				f.inflight.delete(c);
			});
		}

		if (adds.length) {
			try {
				await withRetry(function () {
					return appendCats(f, adds);
				});
				state.edits++;
				adds.forEach(function (c) {
					f.cats.add(c);
				});
			} catch (e) {
				adds.forEach(function (c) {
					f.errors.set(c, e.message);
				});
			}
			adds.forEach(function (c) {
				f.pending.delete(c);
				f.inflight.delete(c);
			});
		}
		renderTags(f);
		refresh();
	}

	let statusOverride = null;

	function setStatus(text, isError) {
		statusOverride = text ? { text: text, error: !!isError } : null;
		updateStatus();
	}

	function updateStatus() {
		if (!ui.status) {
			return;
		}
		let unsaved = 0;
		let failed = 0;
		state.files.forEach(function (f) {
			unsaved += f.pending.size + f.removing.size;
			failed += f.errors.size;
		});
		let text = '';
		let cls = '';
		if (statusOverride) {
			text = statusOverride.text;
			cls = statusOverride.error ? 'bwcpt-err' : '';
		} else if (state.loading) {
			text = 'Loading…';
		} else if (state.saving) {
			text = 'Saving… ' + unsaved + ' left';
		} else if (unsaved) {
			text = unsaved + ' unsaved';
		} else if (failed) {
			text = '⚠ ' + failed + ' failed: click the red name to retry';
			cls = 'bwcpt-err';
		} else if (state.edits) {
			text = '✓ Saved (' + state.edits + ' edit' + (state.edits === 1 ? '' : 's') + ')';
			cls = 'bwcpt-ok';
		}
		ui.status.textContent = text;
		ui.status.className = 'bwcpt-status ' + cls;
		ui.saveBtn.hidden = !unsaved || state.saving;
	}

	/* ------------------------------------------------------------ style */

	const CSS = `
.bwcpt-box { position: relative; }
.bwcpt-check { position: absolute; top: 4px; left: 4px; z-index: 2; width: 18px; height: 18px; margin: 0; cursor: pointer; opacity: .45; }
.bwcpt-box:hover .bwcpt-check, .bwcpt-check:checked { opacity: 1; }
.bwcpt-box.bwcpt-sel { outline: 2px solid var(--color-progressive, #36c); outline-offset: -2px; background: var(--background-color-progressive-subtle, #f1f4fd); }
.bwcpt-box.bwcpt-focus { outline-width: 3px; }
.bwcpt-hidden { display: none !important; }
.bwcpt-tags { display: flex; flex-wrap: wrap; justify-content: center; gap: 3px; padding: 3px 2px 5px; font-size: 11px; line-height: 16px; }
.bwcpt-tags-filepage { justify-content: flex-start; font-size: 13px; line-height: 20px; padding: 6px 0; }
.bwcpt-tag { display: inline-flex; align-items: center; padding: 0 2px 0 6px; border-radius: 8px; background: var(--background-color-interactive, #eaecf0); color: var(--color-base, #202122); white-space: nowrap; }
.bwcpt-tag-busy { opacity: .55; padding-right: 6px; }
.bwcpt-tag-pending { background: transparent; box-shadow: inset 0 0 0 1px var(--color-progressive, #36c); }
.bwcpt-tag-removing .bwcpt-tag-label { text-decoration: line-through; }
.bwcpt-tag-error { background: var(--background-color-error-subtle, #fee7e6); color: var(--color-error, #d73333); cursor: pointer; }
.bwcpt-x { border: 0; background: none; color: inherit; font: inherit; padding: 0 3px; cursor: pointer; opacity: .55; }
.bwcpt-x:hover { opacity: 1; }
.bwcpt-plus { border: 1px solid var(--border-color-base, #a2a9b1); border-radius: 8px; background: var(--background-color-base, #fff); color: var(--color-progressive, #36c); font: inherit; padding: 0 6px; cursor: pointer; }
.bwcpt-plus:hover { border-color: var(--color-progressive, #36c); }
.bwcpt-panel { position: fixed; right: 12px; bottom: 12px; z-index: 1000; width: min(340px, calc(100vw - 24px)); max-height: min(85vh, 760px); display: flex; flex-direction: column; box-sizing: border-box; background: var(--background-color-base, #fff); color: var(--color-base, #202122); border: 1px solid var(--border-color-base, #a2a9b1); border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,.25); font-size: 13px; line-height: 1.4; }
.bwcpt-panel.bwcpt-big { width: min(600px, calc(100vw - 24px)); }
.bwcpt-panel.bwcpt-collapsed { width: auto; }
.bwcpt-panel.bwcpt-collapsed .bwcpt-body { display: none; }
.bwcpt-panel.bwcpt-shake { animation: bwcpt-shake .35s; }
@keyframes bwcpt-shake { 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }
.bwcpt-head { display: flex; align-items: center; gap: 4px; padding: 5px 6px 5px 10px; border-bottom: 1px solid var(--border-color-subtle, #c8ccd1); }
.bwcpt-panel.bwcpt-collapsed .bwcpt-head { border-bottom: 0; }
.bwcpt-count { color: var(--color-subtle, #54595d); font-size: 12px; white-space: nowrap; }
.bwcpt-spacer { flex: 1; }
.bwcpt-btn { border: 1px solid var(--border-color-base, #a2a9b1); border-radius: 3px; background: var(--background-color-interactive-subtle, #f8f9fa); color: var(--color-base, #202122); font: inherit; font-size: 12px; padding: 1px 7px; cursor: pointer; }
.bwcpt-btn:hover:not(:disabled) { border-color: var(--color-progressive, #36c); }
.bwcpt-btn:disabled { opacity: .4; cursor: default; }
.bwcpt-body { display: flex; flex-direction: column; gap: 6px; padding: 8px; min-height: 0; flex: 1; }
.bwcpt-preview-frame { display: flex; justify-content: center; background: var(--background-color-neutral-subtle, #f8f9fa); border-radius: 3px; }
.bwcpt-preview img { display: block; max-width: 100%; max-height: 210px; object-fit: contain; }
.bwcpt-big .bwcpt-preview img { max-height: 48vh; }
.bwcpt-preview-bar { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.bwcpt-preview-cap { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
.bwcpt-more { color: var(--color-subtle, #54595d); }
.bwcpt-hint { font-size: 12px; color: var(--color-subtle, #54595d); }
.bwcpt-search { width: 100%; box-sizing: border-box; padding: 5px 8px; font: inherit; border: 1px solid var(--border-color-base, #a2a9b1); border-radius: 3px; background: var(--background-color-base, #fff); color: inherit; }
.bwcpt-search:focus { outline: none; border-color: var(--color-progressive, #36c); box-shadow: inset 0 0 0 1px var(--color-progressive, #36c); }
.bwcpt-recent, .bwcpt-names { display: flex; flex-wrap: wrap; gap: 4px; align-content: flex-start; }
.bwcpt-recent { padding-bottom: 6px; border-bottom: 1px dashed var(--border-color-subtle, #c8ccd1); }
.bwcpt-recent-label { font-size: 11px; color: var(--color-subtle, #54595d); align-self: center; }
.bwcpt-names { overflow-y: auto; min-height: 60px; flex: 1; padding: 2px; }
.bwcpt-chip { border: 1px solid var(--border-color-base, #a2a9b1); border-radius: 12px; background: var(--background-color-base, #fff); color: var(--color-base, #202122); font: inherit; font-size: 12px; padding: 2px 9px; cursor: pointer; white-space: nowrap; }
.bwcpt-chip:hover { border-color: var(--color-progressive, #36c); color: var(--color-progressive, #36c); }
.bwcpt-chip.bwcpt-some { background: var(--background-color-progressive-subtle, #f1f4fd); border-color: var(--color-progressive, #36c); }
.bwcpt-chip.bwcpt-on { background: var(--background-color-progressive, #36c); border-color: var(--background-color-progressive, #36c); color: var(--color-inverted, #fff); }
.bwcpt-chip.bwcpt-first { box-shadow: 0 0 0 2px var(--color-progressive, #36c); }
.bwcpt-nosel .bwcpt-names .bwcpt-chip, .bwcpt-nosel .bwcpt-recent .bwcpt-chip { opacity: .6; }
.bwcpt-empty { font-size: 12px; color: var(--color-subtle, #54595d); }
.bwcpt-foot { display: flex; align-items: center; gap: 8px; font-size: 12px; padding-top: 4px; border-top: 1px solid var(--border-color-subtle, #c8ccd1); }
.bwcpt-foot label { white-space: nowrap; cursor: pointer; }
.bwcpt-status { flex: 1; text-align: right; color: var(--color-subtle, #54595d); }
.bwcpt-status.bwcpt-ok { color: var(--color-success, #14866d); }
.bwcpt-status.bwcpt-err { color: var(--color-error, #d73333); }
.bwcpt-save { font-weight: bold; }
`;

	function injectStyles() {
		document.head.append(el('style', { id: 'bwcpt-style' }, CSS));
	}

	/* ------------------------------------------------------------ start */

	function bindPage() {
		document.addEventListener('click', function (e) {
			const check = e.target.closest('.bwcpt-check');
			if (check) {
				onCheck(e, state.files[+check.dataset.idx]);
				return;
			}
			const row = e.target.closest('.bwcpt-tags');
			if (row) {
				onTagsClick(e, state.files[+row.dataset.idx]);
			}
		});
		document.addEventListener('keydown', function (e) {
			if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) {
				return;
			}
			const t = e.target;
			if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
				return;
			}
			e.preventDefault();
			setCollapsed(false);
			ui.search.focus();
		});
		window.addEventListener('beforeunload', function (e) {
			if (state.saving || state.files.some(function (f) {
				return f.pending.size || f.removing.size;
			})) {
				e.preventDefault();
				e.returnValue = '';
			}
		});
	}

	async function start() {
		if (started) {
			setCollapsed(!ui.panel.classList.contains('bwcpt-collapsed'));
			return;
		}
		if (!mw.config.get('wgUserName')) {
			mw.notify('People tagger: please log in first.', { type: 'warn' });
			return;
		}
		scanPage();
		if (!state.files.length) {
			mw.notify('People tagger: no images on this page.');
			return;
		}
		started = true;
		api = new mw.Api();
		injectStyles();
		buildPanel();
		bindPage();
		state.files.forEach(renderTags);
		refresh();

		const people = loadPeople(false).then(function (cats) {
			buildPeople(cats);
			renderNames();
			state.files.forEach(renderTags);
			refresh();
		}).catch(function (e) {
			ui.names.textContent = '';
			ui.names.append(el('em', { className: 'bwcpt-empty' }, 'Could not load people: ' + e.message));
		});
		const info = loadFileInfo().catch(function (e) {
			setStatus('Could not read image categories: ' + e.message, true);
		});
		await Promise.all([people, info]);
		state.loading = false;
		refresh();
	}

	function shouldAutoStart() {
		if (!cfg.autoStart || mw.config.get('wgAction') !== 'view') {
			return false;
		}
		const re = cfg.activateRegex;
		return re.test(mw.config.get('wgTitle')) || (mw.config.get('wgCategories') || []).some(function (c) {
			return re.test(c);
		});
	}

	mw.loader.using(['mediawiki.api', 'mediawiki.util']).then(function () {
		const ns = mw.config.get('wgNamespaceNumber');
		state.filePage = ns === 6;
		if (mw.config.get('wgAction') !== 'view') {
			return;
		}
		const hasImages = state.filePage ? !!document.getElementById('file') : !!document.querySelector('li.gallerybox');
		if (!hasImages) {
			return;
		}
		const link = mw.util.addPortletLink('p-tb', '#', 'People tagger', 't-bwcpt', 'Tag people (Bangla WikiConference 2026) in the images on this page');
		if (link) {
			link.addEventListener('click', function (e) {
				e.preventDefault();
				start();
			});
		}
		if (shouldAutoStart()) {
			start();
		}
	});
}());
