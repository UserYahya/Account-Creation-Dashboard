// Browser check for userscripts/vector-2022-mobile.js: loads the mock Vector 2022 page in
// headless Chromium under phone, tablet and desktop emulation, injects the user script and
// checks what changed. Needs Playwright with Chromium (not part of `npm test`):
//
//   npm i --no-save playwright && npx playwright install chromium
//   npm run test:browser
//
// Screenshots of every step are written to a temporary folder (printed at the end).
const path = require('path');
const fs = require('fs');
const os = require('os');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

const SCRIPT = path.resolve(__dirname, '..', '..', 'userscripts', 'vector-2022-mobile.js');
const MOCK = 'file://' + path.resolve(__dirname, 'vector-2022-mobile-mock.html');
const OUT = process.env.SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vector-2022-mobile-'));
fs.mkdirSync(OUT, { recursive: true });

const devices = [
  { name: 'phone-360', viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'phone-412', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'tablet-768', viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'tablet-1024', viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'desktop-1280', viewport: { width: 1280, height: 800 }, isMobile: false },
  { name: 'desktop-1600', viewport: { width: 1600, height: 900 }, isMobile: false }
];

const measure = () => {
  const r = id => { const el = document.getElementById(id); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) }; };
  const parentClass = id => document.getElementById(id).parentElement.className;
  const cs = (id, prop) => getComputedStyle(document.getElementById(id)).getPropertyValue(prop);
  const wide = document.getElementById('wide');
  const scroller = wide.parentElement.classList.contains('vector-2022-mobile-table') ? wide.parentElement : wide;
  const body = document.querySelector('.mw-body').getBoundingClientRect();
  const pre = document.getElementById('pre');
  const link = document.getElementById('pt-vector-2022-mobile');
  return {
    innerWidth: window.innerWidth,
    viewport: document.querySelector('meta[name="viewport"]').getAttribute('content'),
    docScrollWidth: document.documentElement.scrollWidth,
    bodyClass: document.body.classList.contains('skin--responsive'),
    htmlClass: document.documentElement.classList.contains('vector-2022-mobile'),
    style: !!document.getElementById('vector-2022-mobile-styles'),
    link: link ? link.textContent.trim() : null,
    linkInUserMenu: !!(link && link.closest('#p-personal')),
    contentWidth: Math.round(body.width),
    header: r('mw-header') || (() => { const b = document.querySelector('.mw-header').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })(),
    infobox: r('infobox'), infoboxFloat: cs('infobox', 'float'), infoboxDisplay: cs('infobox', 'display'), infoboxImg: r('infobox-img'),
    thumb: r('thumb'), thumbFloat: cs('thumb', 'float'), thumbImg: r('thumb-img'),
    wide: r('wide'), wideParent: parentClass('wide'), wideScrolls: scroller.scrollWidth > scroller.clientWidth + 1, wideScroller: scroller === wide ? 'table' : 'wrapper', wideScrollerWidth: Math.round(scroller.getBoundingClientRect().width),
    full: r('full'), fullParent: parentClass('full'),
    floated: r('floated'), floatedParent: parentClass('floated'),
    inline1: r('inline1'), inline2: r('inline2'), inlineParent: parentClass('inline1'), inlineSameRow: Math.abs(document.getElementById('inline1').getBoundingClientRect().y - document.getElementById('inline2').getBoundingClientRect().y) < 2,
    nestedParent: parentClass('nested'), noresizeParent: parentClass('noresize'),
    navboxTableParent: document.querySelector('#navbox table').parentElement.className,
    preOverflows: pre.scrollWidth > pre.clientWidth + 1,
    math: r('math'),
    bodyFont: getComputedStyle(document.getElementById('bodyContent')).fontSize,
    menuItemHeight: Math.round(document.querySelector('#p-personal .mw-list-item a').getBoundingClientRect().height),
    wrappers: document.querySelectorAll('.vector-2022-mobile-table').length
  };
};

(async () => {
  const browser = await chromium.launch();
  const results = {};
  let failures = 0;
  const check = (name, cond, detail) => { if (!cond) { failures++; console.log(`  FAIL ${name}: ${detail}`); } else { console.log(`  ok   ${name}`); } };

  for (const dev of devices) {
    const errors = [];
    const context = await browser.newContext({ viewport: dev.viewport, isMobile: dev.isMobile, hasTouch: !!dev.hasTouch, deviceScaleFactor: dev.deviceScaleFactor || 1 });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
    await page.goto(MOCK);
    await page.waitForTimeout(100);
    const before = await page.evaluate(measure);
    await page.screenshot({ path: path.join(OUT, `${dev.name}-before.png`), fullPage: false });
    await page.addScriptTag({ path: SCRIPT });
    await page.waitForTimeout(400);
    const after = await page.evaluate(measure);
    await page.screenshot({ path: path.join(OUT, `${dev.name}-after.png`), fullPage: false });
    await page.screenshot({ path: path.join(OUT, `${dev.name}-after-full.png`), fullPage: true });
    results[dev.name] = { before, after, errors };

    console.log(`\n== ${dev.name} (${dev.viewport.width}x${dev.viewport.height}${dev.isMobile ? ', mobile emulation' : ''})`);
    console.log(`  layout viewport: ${before.innerWidth}px -> ${after.innerWidth}px; page scroll width ${before.docScrollWidth} -> ${after.docScrollWidth}; content ${before.contentWidth} -> ${after.contentWidth}px; header h ${before.header.h} -> ${after.header.h}`);
    check('no JS errors or warnings', errors.length === 0, errors.join(' | '));
    check('viewport meta switched to device width', /device-width/.test(after.viewport), after.viewport);
    check('skin--responsive on body, scoping class on html, stylesheet added', after.bodyClass && after.htmlClass && after.style, JSON.stringify([after.bodyClass, after.htmlClass, after.style]));
    check('on/off link in the user menu', after.link === 'Mobile layout: on' && after.linkInUserMenu, after.link);
    if (dev.isMobile) check('page does not scroll sideways', after.docScrollWidth <= after.innerWidth + 1, `${after.docScrollWidth} > ${after.innerWidth}`);
    else check('page width unchanged', after.docScrollWidth === before.docScrollWidth, `${before.docScrollWidth} -> ${after.docScrollWidth}`);
    check('long URL / code block do not overflow', !after.preOverflows, 'pre overflows');
    check('floated table, inline tables, nested table, noresize table and navbox table are not wrapped',
      !/vector-2022-mobile-table/.test([after.floatedParent, after.inlineParent, after.nestedParent, after.noresizeParent, after.navboxTableParent].join(' ')),
      JSON.stringify([after.floatedParent, after.inlineParent, after.nestedParent, after.noresizeParent, after.navboxTableParent]));
    check('inline tables still side by side', after.inlineSameRow, 'inline tables wrapped to separate rows');
    if (dev.isMobile) {
      check('layout viewport now equals the device width', after.innerWidth === dev.viewport.width, `${after.innerWidth} != ${dev.viewport.width}`);
      check('wide table scrolls within itself', after.wideScrolls, `scroller=${after.wideScroller} wide=${JSON.stringify(after.wide)}`);
      check('wide table scroller fits the content column', after.wideScrollerWidth <= after.contentWidth + 1, `${after.wideScrollerWidth} > ${after.contentWidth}`);
      check('full-width table is still full width', Math.abs(after.full.w - after.contentWidth) <= 2 || after.fullParent.indexOf('vector-2022-mobile-table') === -1, `${after.full.w} vs ${after.contentWidth}`);
      check('thumbnail image fits', after.thumbImg.w <= after.contentWidth, `${after.thumbImg.w} > ${after.contentWidth}`);
      check('math image fits', after.math.w <= after.contentWidth, `${after.math.w} > ${after.contentWidth}`);
    }
    if (dev.viewport.width <= 639) {
      check('infobox is full width, not floated, still a table', after.infoboxFloat === 'none' && after.infoboxDisplay === 'table' && Math.abs(after.infobox.w - after.contentWidth) <= 2, JSON.stringify({ float: after.infoboxFloat, display: after.infoboxDisplay, w: after.infobox.w, content: after.contentWidth }));
      check('infobox image stays inside the box', after.infoboxImg.x + after.infoboxImg.w <= after.infobox.x + after.infobox.w && after.infoboxImg.w <= 300, JSON.stringify([after.infoboxImg, after.infobox]));
      check('thumbnail centred, not floated', after.thumbFloat === 'none', after.thumbFloat);
      check('body text is 16px', after.bodyFont === '16px', after.bodyFont);
      check('menu items at least 40px tall', after.menuItemHeight >= 40, String(after.menuItemHeight));
      check('side gutters are 16px', after.contentWidth === dev.viewport.width - 32, `${after.contentWidth} vs ${dev.viewport.width - 32}`);
    } else if (dev.viewport.width <= 1119) {
      check('infobox keeps floating on tablets', after.infoboxFloat === 'right', after.infoboxFloat);
      check('wide table got a scrolling wrapper', after.wideScroller === 'wrapper' && /noresize/.test(after.wideParent), after.wideParent);
      check('body text unchanged (14px)', after.bodyFont === '14px', after.bodyFont);
    } else {
      const same = ['infobox', 'infoboxImg', 'thumb', 'thumbImg', 'wide', 'full', 'floated', 'inline1', 'math', 'header'].filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      check('desktop layout identical before and after', same.length === 0 && after.wrappers === 0 && before.innerWidth === after.innerWidth && before.contentWidth === after.contentWidth, `changed: ${same.join(', ')} wrappers=${after.wrappers}`);
      check('desktop text and menu sizes unchanged', after.bodyFont === before.bodyFont && after.menuItemHeight === before.menuItemHeight, `${before.bodyFont}->${after.bodyFont}, ${before.menuItemHeight}->${after.menuItemHeight}`);
    }
    await context.close();
  }

  // Switched off on this device: nothing but the link.
  {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(MOCK);
    await page.evaluate(() => localStorage.setItem('vector-2022-mobile', 'off'));
    await page.addScriptTag({ path: SCRIPT });
    await page.waitForTimeout(300);
    const off = await page.evaluate(measure);
    console.log('\n== phone-360, switched off on this device');
    check('no errors', errors.length === 0, errors.join(' | '));
    check('desktop viewport kept, no classes, no stylesheet, no wrappers', off.viewport === 'width=1120' && !off.bodyClass && !off.htmlClass && !off.style && off.wrappers === 0, JSON.stringify({ v: off.viewport, w: off.innerWidth }));
    check('link offers to switch it on', off.link === 'Mobile layout: off', off.link);
    // Clicking the link turns it back on and reloads
    // The link sits in the (closed) user menu dropdown, so click it from inside the page.
    await Promise.all([page.waitForNavigation(), page.evaluate(() => document.querySelector('#pt-vector-2022-mobile a').click())]);
    await page.waitForTimeout(300);
    const stored = await page.evaluate(() => localStorage.getItem('vector-2022-mobile'));
    check('click clears the stored flag and reloads', stored === null, String(stored));
    await page.addScriptTag({ path: SCRIPT });
    await page.waitForTimeout(400);
    const on = await page.evaluate(measure);
    check('after the reload the mobile layout is back', on.bodyClass && on.innerWidth === 360 && on.link === 'Mobile layout: on', JSON.stringify({ b: on.bodyClass, w: on.innerWidth, l: on.link }));
    await context.close();
  }

  // Rotation: tablet landscape (fits) -> portrait (overflows) gets wrapped later.
  {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(MOCK);
    await page.addScriptTag({ path: SCRIPT });
    await page.waitForTimeout(300);
    const landscape = await page.evaluate(() => document.getElementById('full').parentElement.className);
    await page.setViewportSize({ width: 600, height: 1024 });
    await page.waitForTimeout(500);
    const portrait = await page.evaluate(() => ({ wideParent: document.getElementById('wide').parentElement.className, scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    console.log('\n== rotate 1024 -> 600');
    check('wide table handled after rotation and page still fits', portrait.scroll <= portrait.inner + 1, JSON.stringify(portrait) + ' landscape full parent=' + landscape);
    await context.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\nScreenshots and results.json: ${OUT}`);
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
