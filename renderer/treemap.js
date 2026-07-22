'use strict';

/*
 * Treemap עצמאי (אלגוריתם squarified) — ללא תלויות חיצוניות.
 * מרנדר ריבועים בגודל יחסי לגודל הפריט, לחיצה = צלילה פנימה.
 */
(function () {
  const PALETTE = [
    '#4f93ff', '#35c46a', '#ffb020', '#ff7ab6', '#9b6dff',
    '#33c9d6', '#ff8a5c', '#7ec24f', '#e05c8a', '#5c9dff'
  ];

  // ---------- Squarified layout ----------
  function worst(row, length, scale) {
    const sum = row.reduce((a, v) => a + v, 0) * scale;
    const rowMax = Math.max(...row) * scale;
    const rowMin = Math.min(...row) * scale;
    const s2 = sum * sum;
    const l2 = length * length;
    return Math.max((l2 * rowMax) / s2, s2 / (l2 * rowMin));
  }

  // מחזיר מערך מלבנים {x,y,w,h,index} עבור ערכי values בתוך rect.
  function squarify(values, rect) {
    const result = new Array(values.length);
    const totalValue = values.reduce((a, v) => a + v.value, 0);
    if (totalValue <= 0) return result;

    const area = rect.w * rect.h;
    const scale = area / totalValue;

    let x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    let i = 0;
    const items = values.map((v, idx) => ({ value: v.value, index: idx }));

    while (i < items.length) {
      const shortSide = Math.min(w, h);
      const row = [];
      let rowVals = [];
      let start = i;

      // בנה שורה שממזערת את יחס הצורה
      while (i < items.length) {
        const candidate = rowVals.concat(items[i].value);
        if (rowVals.length === 0 ||
            worst(candidate, shortSide, scale) <= worst(rowVals, shortSide, scale)) {
          rowVals = candidate;
          row.push(items[i]);
          i++;
        } else {
          break;
        }
      }

      // פרוס את השורה לאורך הצד הקצר
      const rowSum = rowVals.reduce((a, v) => a + v, 0);
      const rowArea = rowSum * scale;
      if (w >= h) {
        // עמודה בצד — רוחב = rowArea / h
        const colW = rowArea / h;
        let cy = y;
        for (let k = 0; k < row.length; k++) {
          const cellH = (row[k].value * scale) / colW;
          result[row[k].index] = { x, y: cy, w: colW, h: cellH, index: row[k].index };
          cy += cellH;
        }
        x += colW;
        w -= colW;
      } else {
        // שורה למעלה — גובה = rowArea / w
        const rowH = rowArea / w;
        let cx = x;
        for (let k = 0; k < row.length; k++) {
          const cellW = (row[k].value * scale) / rowH;
          result[row[k].index] = { x: cx, y, w: cellW, h: rowH, index: row[k].index };
          cx += cellW;
        }
        y += rowH;
        h -= rowH;
      }
      void start;
    }
    return result;
  }

  // ---------- Render ----------
  function render(container, items, options) {
    options = options || {};
    const formatSize = options.formatSize || ((b) => b + ' B');
    const onClick = options.onClick || function () {};
    const highlightBytes = options.highlightBytes || Infinity;

    container.innerHTML = '';
    const W = container.clientWidth;
    const H = container.clientHeight;
    if (W < 5 || H < 5) return;

    // סנן פריטים עם גודל 0 ומיין יורד
    const data = items
      .filter((it) => it.size > 0)
      .sort((a, b) => b.size - a.size);

    if (data.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'אין נתונים להצגה';
      container.appendChild(empty);
      return;
    }

    const rects = squarify(
      data.map((d) => ({ value: d.size })),
      { x: 0, y: 0, w: W, h: H }
    );

    data.forEach((item, idx) => {
      const r = rects[idx];
      if (!r || r.w <= 0 || r.h <= 0) return;

      const tile = document.createElement('div');
      tile.className = 'tm-tile';
      tile.style.right = r.x + 'px';   // RTL: מיקום מימין
      tile.style.top = r.y + 'px';
      tile.style.width = Math.max(0, r.w - 1) + 'px';
      tile.style.height = Math.max(0, r.h - 1) + 'px';
      tile.style.background = PALETTE[idx % PALETTE.length];

      if (item.type === 'dir' && item.size >= highlightBytes) {
        tile.classList.add('highlight');
      }

      // תווית רק אם יש מספיק מקום
      if (r.w > 46 && r.h > 26) {
        const label = document.createElement('div');
        label.className = 'tm-label';
        const name = document.createElement('span');
        name.className = 'tm-name';
        name.textContent = iconFor(item.type) + ' ' + item.name;
        const size = document.createElement('span');
        size.className = 'tm-size';
        size.textContent = formatSize(item.size);
        label.appendChild(name);
        label.appendChild(size);
        tile.appendChild(label);
      }

      tile.title = item.name + ' — ' + formatSize(item.size);

      if (item.type === 'dir') {
        tile.addEventListener('click', () => onClick(item));
      } else {
        tile.style.cursor = 'default';
      }

      container.appendChild(tile);
    });
  }

  function iconFor(type) {
    switch (type) {
      case 'dir': return '📁';
      case 'file': return '📄';
      case 'files-here': return '📄';
      case 'files-bucket': return '🗂️';
      case 'more-bucket': return '➕';
      default: return '';
    }
  }

  window.Treemap = { render, iconFor };
})();
