// Small SVG time chart for "edits over time". Columns when there is room,
// otherwise a 2px line with a light area. Hover or arrow keys show a tooltip;
// every value is also in the table under the chart.
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const COLOR = '#004e9f'; // primary; passes the palette checks on the white card
  const GRID = '#e1e3e4';
  const INK_MUTED = '#414753';

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  // Round the axis maximum up to 1/2/5 × 10^n
  function niceMax(max) {
    if (max <= 4) return 4;
    const power = 10 ** Math.floor(Math.log10(max));
    for (const step of [1, 2, 2.5, 5, 10]) {
      if (step * power >= max) return step * power;
    }
    return 10 * power;
  }

  // Column with a 4px rounded top, square at the baseline
  function columnPath(x, y, w, base) {
    const h = base - y;
    if (h <= 0) return '';
    const r = Math.min(4, w / 2, h);
    return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
  }

  function render(container, points, options) {
    const { formatValue, emptyText } = options;
    container.innerHTML = '';
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 240;
    const pad = { top: 12, right: 12, bottom: 28, left: 44 };
    const plotW = Math.max(10, width - pad.left - pad.right);
    const plotH = Math.max(10, height - pad.top - pad.bottom);
    const max = Math.max(0, ...points.map(p => p.value));

    if (points.length === 0 || max === 0) {
      container.innerHTML = `<div class="h-full flex items-center justify-center text-body-md text-on-surface-variant">${window.App.esc(emptyText)}</div>`;
      return () => {};
    }

    const yMax = niceMax(max);
    const band = plotW / points.length;
    const columns = band >= 6;
    const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.label });
    const base = pad.top + plotH;
    const yFor = v => pad.top + plotH - (v / yMax) * plotH;

    // Recessive hairline grid with clean ticks
    for (let i = 0; i <= 4; i++) {
      const value = (yMax / 4) * i;
      const y = Math.round(yFor(value)) + 0.5;
      svg.appendChild(el('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y, stroke: GRID, 'stroke-width': 1 }));
      const label = el('text', { x: pad.left - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: INK_MUTED });
      label.textContent = formatValue(value);
      svg.appendChild(label);
    }

    // About six evenly spaced x labels
    const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 90))));
    points.forEach((p, i) => {
      if (i % every !== 0) return;
      const label = el('text', { x: pad.left + band * (i + 0.5), y: height - 8, 'text-anchor': 'middle', 'font-size': 11, fill: INK_MUTED });
      label.textContent = p.label;
      svg.appendChild(label);
    });

    const marks = [];
    if (columns) {
      const w = Math.min(24, band - 2); // 2px surface gap between neighbours
      points.forEach((p, i) => {
        const x = pad.left + band * i + (band - w) / 2;
        const path = el('path', { d: columnPath(x, yFor(p.value), w, base), fill: COLOR });
        svg.appendChild(path);
        marks.push(path);
      });
    } else {
      const xy = points.map((p, i) => [pad.left + band * (i + 0.5), yFor(p.value)]);
      const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');
      svg.appendChild(el('path', { d: `${line}L${xy[xy.length - 1][0]},${base}L${xy[0][0]},${base}Z`, fill: COLOR, 'fill-opacity': 0.1 }));
      svg.appendChild(el('path', { d: line, fill: 'none', stroke: COLOR, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }

    // Hover layer: a crosshair (line mode) or lifted column, and a tooltip
    const crosshair = el('line', { y1: pad.top, y2: base, stroke: INK_MUTED, 'stroke-width': 1, visibility: 'hidden' });
    const dot = el('circle', { r: 4.5, fill: COLOR, stroke: '#ffffff', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(crosshair);
    svg.appendChild(dot);
    container.appendChild(svg);

    const tip = document.createElement('div');
    tip.className = 'absolute pointer-events-none card px-sm py-xs shadow-lg text-label-md whitespace-nowrap';
    tip.hidden = true;
    const tipValue = document.createElement('strong');
    tipValue.className = 'block text-body-md text-on-surface';
    const tipLabel = document.createElement('span');
    tipLabel.className = 'text-on-surface-variant';
    tip.append(tipValue, tipLabel);
    container.appendChild(tip);

    let active = -1;
    function show(i) {
      active = Math.max(0, Math.min(points.length - 1, i));
      const p = points[active];
      const cx = pad.left + band * (active + 0.5);
      marks.forEach((m, j) => m.setAttribute('fill-opacity', j === active ? '0.75' : '1'));
      if (!columns) {
        crosshair.setAttribute('x1', cx);
        crosshair.setAttribute('x2', cx);
        crosshair.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', cx);
        dot.setAttribute('cy', yFor(p.value));
        dot.setAttribute('visibility', 'visible');
      }
      tipValue.textContent = `${formatValue(p.value)} সম্পাদনা`;
      tipLabel.textContent = p.fullLabel;
      tip.hidden = false;
      const tipW = tip.offsetWidth;
      tip.style.left = `${Math.min(width - tipW, Math.max(0, cx - tipW / 2))}px`;
      tip.style.top = `${Math.max(0, yFor(p.value) - tip.offsetHeight - 10)}px`;
    }
    function hide() {
      active = -1;
      tip.hidden = true;
      crosshair.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      marks.forEach(m => m.setAttribute('fill-opacity', '1'));
    }

    // The whole band is the hit target, not just the painted column
    svg.addEventListener('pointermove', e => {
      const rect = svg.getBoundingClientRect();
      const i = Math.floor((e.clientX - rect.left - pad.left) / band);
      if (i < 0 || i >= points.length) hide();
      else show(i);
    });
    svg.addEventListener('pointerleave', hide);

    const onKey = e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        show(active < 0 ? (e.key === 'ArrowRight' ? 0 : points.length - 1) : active + (e.key === 'ArrowRight' ? 1 : -1));
      } else if (e.key === 'Escape') {
        hide();
      }
    };
    container.addEventListener('keydown', onKey);
    container.addEventListener('blur', hide);
    return () => {
      container.removeEventListener('keydown', onKey);
      container.removeEventListener('blur', hide);
    };
  }

  // Draw and keep redrawing on resize. Returns an update(points) function.
  function timeChart(container, options) {
    let points = [];
    let cleanup = () => {};
    const draw = () => {
      cleanup();
      cleanup = render(container, points, options);
    };
    if (window.ResizeObserver) {
      let lastWidth = 0;
      new ResizeObserver(entries => {
        const w = Math.round(entries[0].contentRect.width);
        if (w !== lastWidth) {
          lastWidth = w;
          draw();
        }
      }).observe(container);
    }
    return next => {
      points = next;
      draw();
    };
  }

  window.App.timeChart = timeChart;
})();
