// The Vector 2022 mobile user script (userscripts/vector-2022-mobile.js) runs in a
// browser on a wiki, so these tests run it inside a small fake DOM and a fake `mw`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_PATH = path.join(__dirname, '..', 'userscripts', 'vector-2022-mobile.js');
const source = fs.readFileSync(SCRIPT_PATH, 'utf8');

// --- A very small DOM: just what the script touches ---

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.classes = new Set();
    this.textContent = '';
    this.listeners = {};
    this.computed = {};
    this.clientWidth = 0;
    this.rectWidth = 0;
    const el = this;
    this.classList = {
      add: (...names) => names.forEach(n => el.classes.add(n)),
      remove: (...names) => names.forEach(n => el.classes.delete(n)),
      contains: n => el.classes.has(n)
    };
  }
  get parentElement() { return this.parentNode; }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.attributes.id = value; }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i === -1 ? this.children.length : i, 0, child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter(c => c !== child);
    child.parentNode = null;
  }
  contains(node) {
    return node === this || this.children.some(c => c.contains(node));
  }
  matches(selector) {
    const m = /^([a-z]*)(?:#([\w-]+))?((?:\.[\w-]+)*)(?:\[name="([^"]+)"\])?$/.exec(selector);
    if (!m) throw new Error(`fake DOM: unsupported selector ${selector}`);
    const [, tag, id, classes, name] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (id && this.id !== id) return false;
    if (name && this.getAttribute('name') !== name) return false;
    return classes.split('.').filter(Boolean).every(c => this.classes.has(c));
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = node => node.children.forEach(c => { if (c.matches(selector)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { width: this.rectWidth, height: 0 }; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type, event = {}) {
    event.preventDefault = event.preventDefault || (() => { event.prevented = true; });
    (this.listeners[type] || []).forEach(fn => fn(event));
    return event;
  }
}

function makeDocument() {
  const html = new FakeElement('html');
  const head = html.appendChild(new FakeElement('head'));
  const body = html.appendChild(new FakeElement('body'));
  return {
    documentElement: html,
    head,
    body,
    createElement: tag => new FakeElement(tag),
    querySelector: sel => html.querySelector(sel),
    querySelectorAll: sel => html.querySelectorAll(sel),
    getElementById: id => html.querySelector(`#${id}`),
    addEventListener() {}
  };
}

function makeMw(config) {
  const hooks = {};
  return {
    config: { get: key => config[key] },
    hook(name) {
      const h = hooks[name] = hooks[name] || { handlers: [], fired: null };
      return {
        add(fn) { h.handlers.push(fn); if (h.fired) fn(...h.fired); return this; },
        fire(...args) { h.fired = args; h.handlers.forEach(fn => fn(...args)); return this; }
      };
    },
    loader: { using: () => Promise.resolve() },
    util: {
      addPortletLink(portletId, href, text, id, tooltip) {
        const portlet = this.document.getElementById(portletId);
        if (!portlet) return null;
        const ul = portlet.querySelector('ul') || portlet.appendChild(new FakeElement('ul'));
        const li = ul.appendChild(new FakeElement('li'));
        li.id = id;
        li.classList.add('mw-list-item');
        const a = li.appendChild(new FakeElement('a'));
        a.setAttribute('href', href);
        a.setAttribute('title', tooltip);
        a.textContent = text;
        return li;
      }
    }
  };
}

// Runs the user script in a fresh fake browser and returns the pieces the tests inspect.
function runScript({ skin = 'vector-2022', viewport = 'width=1120', innerWidth = 360, stored = null, lang = 'en', config, personalMenu = true } = {}) {
  const document = makeDocument();
  if (viewport !== null) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    meta.setAttribute('content', viewport);
    document.head.appendChild(meta);
  }
  if (personalMenu) {
    const menu = document.createElement('div');
    menu.id = 'p-personal';
    document.body.appendChild(menu);
  }
  const content = document.createElement('div');
  content.id = 'mw-content-text';
  document.body.appendChild(content);

  const storage = new Map(stored ? [['vector-2022-mobile', stored]] : []);
  const mw = makeMw({ skin, wgUserLanguage: lang });
  mw.util.document = document;
  const window = {
    document,
    mw,
    innerWidth,
    reloaded: 0,
    resizeHandlers: [],
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    matchMedia: query => ({ matches: innerWidth <= parseInt(/\d+/.exec(query)[0], 10) }),
    getComputedStyle: el => ({
      getPropertyValue: prop => el.computed[prop] || { float: 'none', display: el.tagName === 'TABLE' ? 'table' : 'block', position: 'static', 'padding-left': '0px', 'padding-right': '0px' }[prop] || ''
    }),
    addEventListener(type, fn) { if (type === 'resize') this.resizeHandlers.push(fn); },
    setTimeout, clearTimeout,
    location: { reload() { window.reloaded++; } }
  };
  window.window = window;
  if (config) window.vector2022MobileConfig = config;
  vm.runInNewContext(source, window, { filename: 'vector-2022-mobile.js' });
  return { window, document, mw, storage, content, FakeElement };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

// Builds `<table>` elements that are `rectWidth` wide inside `parent`.
function addTable(document, parent, { width, className = 'wikitable', computed = {} } = {}) {
  const table = document.createElement('table');
  table.className = className;
  table.rectWidth = width;
  Object.assign(table.computed, computed);
  parent.appendChild(table);
  return table;
}

test('user script is valid ES2015+ script syntax (no modules, no top-level await)', () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: SCRIPT_PATH }));
  assert.ok(!/^\s*(import|export)\s/m.test(source), 'no module syntax');
  assert.ok(/mw\.config\.get\(\s*'skin'\s*\)\s*!==\s*'vector-2022'/.test(source), 'guards on the skin name');
});

test('does nothing on skins other than Vector 2022', () => {
  const { window, document } = runScript({ skin: 'vector' });
  assert.equal(window.vector2022Mobile, undefined);
  assert.equal(document.querySelector('meta[name="viewport"]').getAttribute('content'), 'width=1120');
  assert.ok(!document.body.classList.contains('skin--responsive'));
  assert.equal(document.head.querySelectorAll('style').length, 0);
});

test('switches Vector 2022 into its responsive mode', async () => {
  const { window, document } = runScript();
  const meta = document.querySelector('meta[name="viewport"]');
  assert.equal(meta.getAttribute('content'), 'width=device-width, initial-scale=1.0, user-scalable=yes, minimum-scale=0.25, maximum-scale=5.0');
  assert.equal(meta.getAttribute('data-vector-2022-mobile-original'), 'width=1120', 'remembers what the server sent');
  assert.ok(document.body.classList.contains('skin--responsive'), "core's responsive content styles are switched on");
  assert.ok(document.documentElement.classList.contains('vector-2022-mobile'));
  const style = document.getElementById('vector-2022-mobile-styles');
  assert.ok(style, 'adds its stylesheet once');
  assert.match(style.textContent, /max-width: 639px/);
  assert.match(style.textContent, /max-width: 1119px/);
  assert.ok(!/min-width/.test(style.textContent), 'no rule applies at desktop widths');
  assert.equal(window.vector2022Mobile.enabled, true);

  await flush();
  const link = document.getElementById('pt-vector-2022-mobile');
  assert.ok(link && link.closest('#p-personal'), 'on/off link sits in the user menu');
  assert.equal(link.querySelector('a').textContent, 'Mobile layout: on');
});

test('adds a viewport tag when the page has none and keeps one that is already responsive', () => {
  const none = runScript({ viewport: null });
  assert.match(none.document.querySelector('meta[name="viewport"]').getAttribute('content'), /device-width/);

  const already = runScript({ viewport: 'width=device-width, initial-scale=1' });
  const meta = already.document.querySelector('meta[name="viewport"]');
  assert.equal(meta.getAttribute('content'), 'width=device-width, initial-scale=1');
  assert.equal(meta.getAttribute('data-vector-2022-mobile-original'), null);
});

test('wraps only wide, unfloated, top-level tables, and only below the desktop breakpoint', () => {
  const { window, document, mw, content } = runScript({ innerWidth: 768 });
  content.clientWidth = 720;
  const wide = addTable(document, content, { width: 1000 });
  const fits = addTable(document, content, { width: 700 });
  const floated = addTable(document, content, { width: 1000, computed: { float: 'right' } });
  const inline = addTable(document, content, { width: 1000, computed: { display: 'inline-table' } });
  const cell = wide.appendChild(document.createElement('td'));
  cell.clientWidth = 200;
  const nested = addTable(document, cell, { width: 900 });
  const noresize = content.appendChild(document.createElement('div'));
  noresize.className = 'noresize';
  noresize.clientWidth = 720;
  const handled = addTable(document, noresize, { width: 1000 });

  mw.hook('wikipage.content').fire({ toArray: () => [content] });

  const wrapped = t => t.parentNode.classList.contains('vector-2022-mobile-table') && t.parentNode.classList.contains('noresize');
  assert.ok(wrapped(wide), 'overflowing table gets a scrolling wrapper');
  assert.ok(!wrapped(fits), 'table that fits is left alone');
  assert.ok(!wrapped(floated), 'floated table is left alone');
  assert.ok(!wrapped(inline), 'inline-table (tables side by side) is left alone');
  assert.ok(!wrapped(nested), 'table inside a table is left alone');
  assert.ok(!wrapped(handled), 'table already inside .noresize is left alone');
  assert.equal(wide.parentNode.parentNode, content, 'wrapper takes the table\'s place');

  assert.equal(window.vector2022Mobile.wrapTables(content), 0, 'running again changes nothing');

  const desktop = runScript({ innerWidth: 1280 });
  desktop.content.clientWidth = 948;
  const wideOnDesktop = addTable(desktop.document, desktop.content, { width: 1400 });
  desktop.mw.hook('wikipage.content').fire({ toArray: () => [desktop.content] });
  assert.equal(wideOnDesktop.parentNode, desktop.content, 'desktop layout is never changed');
});

test('re-checks tables after a resize (e.g. rotating a tablet)', async () => {
  const { window, document, mw, content } = runScript({ innerWidth: 1024 });
  content.clientWidth = 976;
  const table = addTable(document, content, { width: 900 });
  mw.hook('wikipage.content').fire({ toArray: () => [content] });
  assert.equal(table.parentNode, content, 'fits in landscape');

  window.innerWidth = 768;
  content.clientWidth = 720;
  window.resizeHandlers.forEach(fn => fn());
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(table.parentNode.classList.contains('vector-2022-mobile-table'), 'wrapped once it overflows in portrait');
});

test('can be switched off per device from the user menu', async () => {
  const off = runScript({ stored: 'off' });
  assert.equal(off.window.vector2022Mobile.enabled, false);
  assert.equal(off.document.querySelector('meta[name="viewport"]').getAttribute('content'), 'width=1120', 'desktop viewport is kept');
  assert.ok(!off.document.body.classList.contains('skin--responsive'));
  assert.equal(off.document.getElementById('vector-2022-mobile-styles'), null);
  await flush();
  const link = off.document.getElementById('pt-vector-2022-mobile').querySelector('a');
  assert.equal(link.textContent, 'Mobile layout: off');
  const event = link.dispatch('click');
  assert.ok(event.prevented, 'link click does not navigate to #');
  assert.equal(off.storage.has('vector-2022-mobile'), false, 'switching on clears the stored flag');
  assert.equal(off.window.reloaded, 1, 'page reloads to apply the change');

  const on = runScript();
  await flush();
  on.document.getElementById('pt-vector-2022-mobile').querySelector('a').dispatch('click');
  assert.equal(on.storage.get('vector-2022-mobile'), 'off');
});

test('labels follow the user language and can be overridden', async () => {
  const bn = runScript({ lang: 'bn' });
  await flush();
  assert.equal(bn.document.getElementById('pt-vector-2022-mobile').querySelector('a').textContent, 'মোবাইল বিন্যাস: চালু');

  const custom = runScript({ config: { labels: { on: 'Phone view ✓' } } });
  await flush();
  assert.equal(custom.document.getElementById('pt-vector-2022-mobile').querySelector('a').textContent, 'Phone view ✓');

  const noMenu = runScript({ personalMenu: false });
  await flush();
  assert.equal(noMenu.document.getElementById('pt-vector-2022-mobile'), null, 'no menu, no link, no error');
});

test('features can be turned off with window.vector2022MobileConfig', () => {
  const { window, document, content } = runScript({ config: { tables: false, infobox: false, text: false, menuLink: false } });
  const css = document.getElementById('vector-2022-mobile-styles').textContent;
  assert.ok(!/infobox/.test(css));
  assert.ok(!/font-size: 1rem; line-height/.test(css));
  assert.ok(!/vector-2022-mobile-table/.test(css));
  content.clientWidth = 300;
  addTable(document, content, { width: 1000 });
  assert.equal(window.vector2022Mobile.wrapTables(content), 0);
  assert.equal(window.resizeHandlers.length, 0, 'no resize listener when table wrapping is off');
});
