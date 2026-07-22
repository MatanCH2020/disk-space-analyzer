'use strict';

// ---------- State ----------
const state = {
  drives: [],
  scans: {},            // אינדקס סריקות שמורות (מ-list-scans)
  navStack: [],         // מסלול הצמתים מהשורש ועד הצומת הנוכחי
  scanRoot: null,       // שורש הסריקה הנוכחית (הכונן)
  driveId: null,
  displayName: '',
  prevRoot: null,       // סריקה קודמת להשוואה
  prevMeta: null,
  viewMode: 'browse',   // browse | biggest | changes
  sortMode: 'size-desc',
  thresholdGB: 40,
  minSizeGB: 0,
  scanning: false,
  hasResults: false,
  lastResultRoot: null
};

const GB = 1024 ** 3;

// ---------- Elements ----------
const el = {
  viewHome: document.getElementById('view-home'),
  viewScanning: document.getElementById('view-scanning'),
  viewResults: document.getElementById('view-results'),
  drivesList: document.getElementById('drives-list'),
  btnHome: document.getElementById('btn-home'),
  btnBackResults: document.getElementById('btn-back-results'),
  btnRefresh: document.getElementById('btn-refresh-drives'),
  btnCancelScan: document.getElementById('btn-cancel-scan'),
  scanTitle: document.getElementById('scan-title'),
  scanCount: document.getElementById('scan-count'),
  scanPath: document.getElementById('scan-path'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  tabChanges: document.getElementById('tab-changes'),
  scanMeta: document.getElementById('scan-meta'),
  modeBrowse: document.getElementById('mode-browse'),
  modeFlat: document.getElementById('mode-flat'),
  breadcrumb: document.getElementById('breadcrumb'),
  currentName: document.getElementById('current-name'),
  currentSize: document.getElementById('current-size'),
  sortSelect: document.getElementById('sort-select'),
  minsizeSlider: document.getElementById('minsize-slider'),
  minsizeValue: document.getElementById('minsize-value'),
  thresholdSlider: document.getElementById('threshold-slider'),
  thresholdValue: document.getElementById('threshold-value'),
  treemap: document.getElementById('treemap'),
  itemsList: document.getElementById('items-list'),
  flatTitle: document.getElementById('flat-title'),
  flatHint: document.getElementById('flat-hint'),
  flatListHead: document.getElementById('flat-list-head'),
  flatList: document.getElementById('flat-list'),
  toast: document.getElementById('toast')
};

// ---------- Utils ----------
function formatSize(bytes) {
  bytes = Number(bytes) || 0;
  const TB = 1024 ** 4, MB = 1024 ** 2, KB = 1024;
  if (bytes >= TB) return (bytes / TB).toFixed(2) + ' TB';
  if (bytes >= GB) return (bytes / GB).toFixed(2) + ' GB';
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB';
  if (bytes >= KB) return (bytes / KB).toFixed(0) + ' KB';
  return bytes + ' B';
}
function thresholdBytes() { return state.thresholdGB * GB; }
function sanitizeId(id) { return String(id).replace(/[^A-Za-z0-9]/g, '') || 'x'; }

function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'הרגע';
  const m = Math.floor(s / 60); if (m < 60) return 'לפני ' + m + ' דק׳';
  const h = Math.floor(m / 60); if (h < 24) return 'לפני ' + h + ' שע׳';
  const d = Math.floor(h / 24); if (d === 1) return 'אתמול';
  if (d < 30) return 'לפני ' + d + ' ימים';
  const mo = Math.floor(d / 30); if (mo < 12) return 'לפני ' + mo + ' חוד׳';
  return 'לפני יותר משנה';
}

function showView(name) {
  el.viewHome.hidden = name !== 'home';
  el.viewScanning.hidden = name !== 'scanning';
  el.viewResults.hidden = name !== 'results';
  el.btnHome.hidden = name === 'home';
  el.btnBackResults.hidden = !(name === 'home' && state.hasResults);
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

// ---------- Drives (home) ----------
async function loadDrives() {
  // מציגים placeholder רק כשאין נתונים ב-cache — למנוע הבהוב בעת רענון
  if (!state.drives.length) {
    el.drivesList.innerHTML = '<div class="empty-state">טוען כוננים…</div>';
  }
  const [drives, scans] = await Promise.all([window.api.listDrives(), window.api.listScans()]);
  state.drives = drives;
  state.scans = scans || {};
  renderDrives();
}

// מעבר למסך הבית עם רענון כוננים + סטטוס סריקות (ומקום פנוי מעודכן)
function goHome() {
  showView('home');
  loadDrives();
}

function renderDrives() {
  el.drivesList.innerHTML = '';
  if (!state.drives.length) {
    el.drivesList.innerHTML = '<div class="empty-state">לא נמצאו כוננים</div>';
    return;
  }

  const fixed = state.drives.filter((d) => d.driveType === 3);
  if (fixed.length > 1) {
    const allCard = document.createElement('div');
    allCard.className = 'drive-card';
    allCard.innerHTML =
      '<div class="drive-top"><span class="drive-name">🖥️ כל הכוננים</span></div>' +
      '<div class="drive-label">סרוק את כל הכוננים הקבועים יחד</div>';
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = '🔍 סרוק הכל';
    btn.addEventListener('click', () => scanAll(fixed));
    allCard.appendChild(btn);
    el.drivesList.appendChild(allCard);
  }

  state.drives.forEach((d) => {
    const pct = d.total > 0 ? (d.used / d.total) * 100 : 0;
    const fillClass = pct >= 90 ? 'full' : pct >= 75 ? 'warn' : '';
    const scan = state.scans[sanitizeId(d.id)];

    const card = document.createElement('div');
    card.className = 'drive-card';

    const top = document.createElement('div');
    top.className = 'drive-top';
    top.innerHTML =
      '<span class="drive-name">💽 ' + d.id + '</span>' +
      '<span class="drive-type">' + d.typeName + '</span>';

    const label = document.createElement('div');
    label.className = 'drive-label';
    label.textContent = d.label ? d.label : 'ללא תווית';

    const bar = document.createElement('div');
    bar.className = 'drive-bar';
    bar.innerHTML = '<div class="drive-bar-fill ' + fillClass +
      '" style="width:' + pct.toFixed(1) + '%"></div>';

    const stats = document.createElement('div');
    stats.className = 'drive-stats';
    stats.innerHTML =
      '<span class="used-txt">בשימוש ' + formatSize(d.used) +
      ' (' + pct.toFixed(0) + '%)</span>' +
      '<span>פנוי ' + formatSize(d.free) + '</span>';

    const lastscan = document.createElement('div');
    if (scan) {
      lastscan.className = 'drive-lastscan';
      lastscan.textContent = '✓ נסרק ' + relativeTime(scan.scannedAt) + ' · ' + formatSize(scan.totalSize);
    } else {
      lastscan.className = 'drive-lastscan none';
      lastscan.textContent = 'טרם נסרק';
    }

    const btns = document.createElement('div');
    btns.className = 'drive-btns';
    if (scan) {
      const showBtn = document.createElement('button');
      showBtn.className = 'btn btn-ghost';
      showBtn.textContent = '📂 הצג אחרונות';
      showBtn.addEventListener('click', () => showCached(d.id));
      const rescanBtn = document.createElement('button');
      rescanBtn.className = 'btn btn-primary';
      rescanBtn.textContent = '🔄 סרוק מחדש';
      rescanBtn.addEventListener('click', () => scanSingle(d));
      btns.appendChild(showBtn);
      btns.appendChild(rescanBtn);
    } else {
      const scanBtn = document.createElement('button');
      scanBtn.className = 'btn btn-primary';
      scanBtn.textContent = '🔍 סרוק כונן זה';
      scanBtn.addEventListener('click', () => scanSingle(d));
      btns.appendChild(scanBtn);
    }

    card.appendChild(top);
    card.appendChild(label);
    card.appendChild(bar);
    card.appendChild(stats);
    card.appendChild(lastscan);
    card.appendChild(btns);
    el.drivesList.appendChild(card);
  });
}

// ---------- Scanning ----------
function startScanningUI(title) {
  state.scanning = true;
  el.scanTitle.textContent = title;
  el.scanCount.textContent = '0 קבצים נסרקו';
  el.scanPath.textContent = '';
  showView('scanning');
}

async function scanSingle(drive) {
  startScanningUI('סורק את ' + drive.id + ' …');
  const res = await window.api.scanStart(drive.path);
  if (!state.scanning) return; // בוטל
  state.scanning = false;
  if (!res.ok) {
    toast('הסריקה נכשלה: ' + (res.error || 'שגיאה'));
    showView('home');
    return;
  }
  const tree = res.tree;
  tree.driveId = drive.id;
  tree.displayName = drive.id + (drive.label ? ' (' + drive.label + ')' : '');
  tree.scannedAt = new Date().toISOString();
  await openTree(tree, { save: true });
}

async function scanAll(fixedDrives) {
  startScanningUI('סורק את כל הכוננים…');
  const roots = [];
  let totalSize = 0;
  for (const d of fixedDrives) {
    if (!state.scanning) return;
    el.scanTitle.textContent = 'סורק את ' + d.id + ' …';
    const res = await window.api.scanStart(d.path);
    if (!state.scanning) return;
    if (res.ok && res.tree) {
      const dn = d.id + (d.label ? ' (' + d.label + ')' : '');
      res.tree.displayName = dn;
      res.tree.name = d.id + '\\';
      res.tree.driveId = d.id;
      const scannedAt = new Date().toISOString();
      res.tree.scannedAt = scannedAt;
      await window.api.saveScan({
        driveId: d.id, displayName: dn, rootPath: d.path,
        totalSize: res.tree.size, scannedAt, tree: res.tree
      });
      roots.push(res.tree);
      totalSize += res.tree.size;
    }
  }
  state.scanning = false;
  state.scans = await window.api.listScans();
  if (!roots.length) {
    toast('הסריקה נכשלה');
    showView('home');
    return;
  }
  const virtualRoot = {
    name: 'כל הכוננים', displayName: 'כל הכוננים', path: null,
    size: totalSize, type: 'dir', children: roots
  };
  await openTree(virtualRoot, { save: false });
}

async function showCached(driveId) {
  const res = await window.api.loadScan(driveId);
  if (!res.ok) { toast('לא נמצאה סריקה שמורה'); return; }
  const tree = res.tree;
  tree.driveId = res.meta.driveId;
  tree.displayName = res.meta.displayName || tree.name;
  tree.scannedAt = res.meta.scannedAt;
  await openTree(tree, { save: false });
}

async function cancelScan() {
  state.scanning = false;
  await window.api.scanCancel();
  goHome();
}

// ---------- Open results ----------
async function openTree(root, opts) {
  opts = opts || {};
  state.navStack = [root];
  state.scanRoot = root;
  state.driveId = root.driveId || null;
  state.displayName = root.displayName || root.name;
  state.hasResults = true;
  state.lastResultRoot = root;
  state.prevRoot = null;
  state.prevMeta = null;

  if (state.driveId) {
    if (opts.save) {
      // להשוואה: הסריקה השמורה הנוכחית (לפני שנדרוס אותה) היא ה"קודמת"
      const prev = await window.api.loadScan(state.driveId);
      if (prev.ok) { state.prevRoot = prev.tree; state.prevMeta = prev.meta; }
      await window.api.saveScan({
        driveId: state.driveId, displayName: state.displayName,
        rootPath: root.path, totalSize: root.size,
        scannedAt: root.scannedAt || new Date().toISOString(), tree: root
      });
      state.scans = await window.api.listScans();
    } else {
      const prev = await window.api.loadPrevScan(state.driveId);
      if (prev && prev.ok) { state.prevRoot = prev.tree; state.prevMeta = prev.meta; }
    }
  }

  el.tabChanges.hidden = !state.prevRoot;
  el.scanMeta.textContent = root.scannedAt ? 'נסרק ' + relativeTime(root.scannedAt) : '';
  showView('results');
  setMode('browse');
}

// ---------- Tabs / modes ----------
function setMode(mode) {
  if (mode === 'changes' && !state.prevRoot) mode = 'browse';
  state.viewMode = mode;
  el.tabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  el.modeBrowse.hidden = mode !== 'browse';
  el.modeFlat.hidden = mode === 'browse';
  if (mode === 'browse') renderCurrent();
  else if (mode === 'biggest') renderBiggest();
  else if (mode === 'changes') renderChanges();
}

// ---------- Browse mode ----------
function currentNode() { return state.navStack[state.navStack.length - 1]; }

function drillInto(node) {
  if (node.type !== 'dir' || !node.children || !node.children.length) return;
  state.navStack.push(node);
  renderCurrent();
}
function navigateTo(index) {
  state.navStack = state.navStack.slice(0, index + 1);
  renderCurrent();
}

function applySortFilter(children) {
  const minBytes = state.minSizeGB * GB;
  let out = children.slice();
  if (minBytes > 0) out = out.filter((c) => c.size >= minBytes);
  if (state.sortMode === 'size-asc') out.sort((a, b) => a.size - b.size);
  else if (state.sortMode === 'name-asc') out.sort((a, b) => a.name.localeCompare(b.name, 'he'));
  else out.sort((a, b) => b.size - a.size);
  return out;
}

function renderCurrent() {
  const node = currentNode();

  el.breadcrumb.innerHTML = '';
  state.navStack.forEach((n, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '‹';
      el.breadcrumb.appendChild(sep);
    }
    const crumb = document.createElement('span');
    const isCurrent = i === state.navStack.length - 1;
    crumb.className = 'crumb' + (isCurrent ? ' current' : '');
    crumb.textContent = i === 0 ? (n.displayName || n.name) : n.name;
    if (!isCurrent) crumb.addEventListener('click', () => navigateTo(i));
    el.breadcrumb.appendChild(crumb);
  });

  el.currentName.textContent = node.displayName || node.name;
  el.currentSize.textContent = 'סה"כ ' + formatSize(node.size);

  const children = applySortFilter(node.children || []);

  window.Treemap.render(el.treemap, children, {
    formatSize,
    highlightBytes: thresholdBytes(),
    onClick: (item) => drillInto(item)
  });

  renderList(children, node.size);
}

function renderList(children, totalSize) {
  el.itemsList.innerHTML = '';
  if (!children.length) {
    el.itemsList.innerHTML = '<div class="empty-state">אין פריטים להצגה</div>';
    return;
  }
  const thBytes = thresholdBytes();

  children.forEach((item) => {
    const pct = totalSize > 0 ? (item.size / totalSize) * 100 : 0;
    const isDir = item.type === 'dir';
    const isHighlight = isDir && item.size >= thBytes;
    const canDrill = isDir && item.children && item.children.length > 0;

    const row = document.createElement('div');
    row.className = 'item-row' + (canDrill ? ' clickable' : '') + (isHighlight ? ' highlight' : '');

    const nameCell = document.createElement('div');
    nameCell.className = 'item-name';
    const icon = document.createElement('span');
    icon.className = 'item-icon';
    icon.textContent = window.Treemap.iconFor(item.type);
    const nameText = document.createElement('span');
    nameText.className = 'item-name-text';
    nameText.textContent = item.name;
    nameCell.appendChild(icon);
    nameCell.appendChild(nameText);

    const sizeCell = document.createElement('div');
    sizeCell.className = 'item-size';
    sizeCell.textContent = formatSize(item.size);

    const pctCell = document.createElement('div');
    pctCell.className = 'item-pct-wrap';
    pctCell.innerHTML =
      '<div class="item-pct-bar"><div class="item-pct-fill ' +
      (isHighlight ? 'highlight' : '') + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
      '<span class="item-pct-text">' + pct.toFixed(1) + '%</span>';

    const actCell = document.createElement('div');
    actCell.className = 'item-actions';
    if (item.type !== 'more-bucket' && item.path) {
      actCell.appendChild(makeOpenBtn(item.path));
    }

    if (canDrill) row.addEventListener('click', () => drillInto(item));

    row.appendChild(nameCell);
    row.appendChild(sizeCell);
    row.appendChild(pctCell);
    row.appendChild(actCell);
    el.itemsList.appendChild(row);
  });
}

function makeOpenBtn(targetPath) {
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-ghost';
  btn.textContent = '📂 פתח בסייר';
  btn.title = 'פתח את המיקום ב-Windows Explorer';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openInExplorer(targetPath);
  });
  return btn;
}

// ---------- Flatten / navigation helpers ----------
function flattenDirs(root) {
  const out = [];
  (function walk(n) {
    out.push(n);
    for (const c of (n.children || [])) if (c.type === 'dir') walk(c);
  })(root);
  return out;
}

function findPathTo(root, target) {
  const t = String(target).toLowerCase();
  const stack = [root];
  let node = root;
  if (String(node.path).toLowerCase() === t) return stack;
  while (true) {
    let next = null;
    for (const c of (node.children || [])) {
      if (c.type !== 'dir') continue;
      const cp = String(c.path).toLowerCase();
      if (cp === t) { stack.push(c); return stack; }
      if (t.startsWith(cp + '\\')) { next = c; break; }
    }
    if (!next) return null;
    stack.push(next);
    node = next;
  }
}

function jumpTo(targetPath) {
  const stack = findPathTo(state.scanRoot, targetPath);
  if (!stack) { toast('התיקייה לא נמצאה בעץ'); return; }
  state.navStack = stack;
  setMode('browse');
}

// ---------- Biggest folders (flat) ----------
function renderBiggest() {
  el.flatTitle.textContent = 'התיקיות הכי גדולות ב־' + state.displayName;
  el.flatHint.textContent = 'לחיצה על שורה קופצת לתיקייה בעץ · פתח בסייר למחיקה ידנית';
  el.flatListHead.innerHTML =
    '<span>תיקייה</span><span>גודל</span><span>% מהכונן</span><span></span>';

  const rootSize = state.scanRoot.size || 1;
  const dirs = flattenDirs(state.scanRoot).filter((n) => n !== state.scanRoot && n.size > 0);
  dirs.sort((a, b) => b.size - a.size);
  const top = dirs.slice(0, 40);

  el.flatList.innerHTML = '';
  if (!top.length) { el.flatList.innerHTML = '<div class="empty-state">אין נתונים</div>'; return; }

  top.forEach((n) => {
    const pct = (n.size / rootSize) * 100;
    const row = document.createElement('div');
    row.className = 'flat-row';

    const pathCell = document.createElement('div');
    pathCell.className = 'flat-path';
    const name = document.createElement('div');
    name.className = 'fp-name';
    name.textContent = '📁 ' + n.name;
    const dir = document.createElement('div');
    dir.className = 'fp-dir';
    dir.textContent = n.path;
    pathCell.appendChild(name);
    pathCell.appendChild(dir);

    const sizeCell = document.createElement('div');
    sizeCell.className = 'flat-size';
    sizeCell.textContent = formatSize(n.size);

    const pctCell = document.createElement('div');
    pctCell.textContent = pct.toFixed(1) + '%';

    const actCell = document.createElement('div');
    actCell.className = 'item-actions';
    if (n.path) actCell.appendChild(makeOpenBtn(n.path));

    row.addEventListener('click', () => jumpTo(n.path));
    row.appendChild(pathCell);
    row.appendChild(sizeCell);
    row.appendChild(pctCell);
    row.appendChild(actCell);
    el.flatList.appendChild(row);
  });
}

// ---------- Changes vs previous scan ----------
function renderChanges() {
  el.flatTitle.textContent = 'שינויים מאז הסריקה הקודמת';
  el.flatHint.textContent = state.prevMeta
    ? 'סריקה קודמת: ' + relativeTime(state.prevMeta.scannedAt) + ' · מסונן לשינויים מעל 50MB'
    : '';
  el.flatListHead.innerHTML =
    '<span>תיקייה</span><span>גודל נוכחי</span><span>שינוי</span><span></span>';

  const MIN_DELTA = 50 * 1024 * 1024;
  const prevMap = new Map();
  for (const n of flattenDirs(state.prevRoot)) prevMap.set(String(n.path).toLowerCase(), n);

  const changes = [];
  const seen = new Set();
  for (const n of flattenDirs(state.scanRoot)) {
    if (n === state.scanRoot) continue; // מדלגים על שורש הכונן עצמו
    const key = String(n.path).toLowerCase();
    seen.add(key);
    const prevNode = prevMap.get(key);
    const delta = n.size - (prevNode ? prevNode.size : 0);
    if (Math.abs(delta) < MIN_DELTA) continue;
    changes.push({ node: n, delta, isNew: prevNode === undefined, exists: true });
  }
  // תיקיות שנמחקו (היו בקודמת, אין כעת) → מקום שפונה
  const rootKey = String(state.scanRoot.path).toLowerCase();
  for (const [key, pnode] of prevMap) {
    if (key === rootKey) continue;
    if (!seen.has(key) && pnode.size >= MIN_DELTA) {
      changes.push({ node: { name: pnode.name, path: pnode.path, size: 0 }, delta: -pnode.size, removed: true, exists: false });
    }
  }

  changes.sort((a, b) => b.delta - a.delta);
  const top = changes.slice(0, 60);

  el.flatList.innerHTML = '';
  if (!top.length) {
    el.flatList.innerHTML = '<div class="empty-state">לא נמצאו שינויים משמעותיים</div>';
    return;
  }

  top.forEach((ch) => {
    const n = ch.node;
    const row = document.createElement('div');
    row.className = 'flat-row';

    const pathCell = document.createElement('div');
    pathCell.className = 'flat-path';
    const name = document.createElement('div');
    name.className = 'fp-name';
    name.textContent = (ch.removed ? '🗑️ ' : '📁 ') + n.name;
    const dir = document.createElement('div');
    dir.className = 'fp-dir';
    dir.textContent = n.path;
    pathCell.appendChild(name);
    pathCell.appendChild(dir);

    const sizeCell = document.createElement('div');
    sizeCell.className = 'flat-size';
    sizeCell.textContent = ch.removed ? '—' : formatSize(n.size);

    const deltaCell = document.createElement('div');
    deltaCell.className = 'flat-size ' +
      (ch.isNew ? 'delta-new' : ch.delta > 0 ? 'delta-up' : 'delta-down');
    deltaCell.textContent = ch.isNew ? 'חדש +' + formatSize(ch.delta)
      : (ch.delta > 0 ? '▲ +' : '▼ −') + formatSize(Math.abs(ch.delta));

    const actCell = document.createElement('div');
    actCell.className = 'item-actions';
    if (ch.exists && n.path) actCell.appendChild(makeOpenBtn(n.path));

    if (ch.exists) row.addEventListener('click', () => jumpTo(n.path));
    else row.style.cursor = 'default';

    row.appendChild(pathCell);
    row.appendChild(sizeCell);
    row.appendChild(deltaCell);
    row.appendChild(actCell);
    el.flatList.appendChild(row);
  });
}

async function openInExplorer(targetPath) {
  const res = await window.api.openInExplorer(targetPath);
  if (!res.ok) toast('לא ניתן לפתוח את המיקום');
}

// ---------- Progress listener ----------
window.api.onScanProgress((data) => {
  if (!data) return;
  if (data.phase === 'parse') {
    el.scanCount.textContent = 'מעבד תוצאות…';
  } else if (typeof data.filesScanned === 'number') {
    el.scanCount.textContent = data.filesScanned.toLocaleString('he-IL') + ' קבצים נסרקו';
  }
  if (data.currentPath) el.scanPath.textContent = data.currentPath;
  else if (data.phase === 'done') el.scanPath.textContent = '';
});

// ---------- Event wiring ----------
el.btnHome.addEventListener('click', goHome);
el.btnBackResults.addEventListener('click', () => {
  if (!state.hasResults) return;
  showView('results');
  setMode(state.viewMode || 'browse');
});
el.btnRefresh.addEventListener('click', loadDrives);
el.btnCancelScan.addEventListener('click', cancelScan);

el.tabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

el.sortSelect.addEventListener('change', (e) => {
  state.sortMode = e.target.value;
  if (state.viewMode === 'browse') renderCurrent();
});
el.minsizeSlider.addEventListener('input', (e) => {
  state.minSizeGB = Number(e.target.value);
  el.minsizeValue.textContent = state.minSizeGB;
  if (state.viewMode === 'browse') renderCurrent();
});
el.thresholdSlider.addEventListener('input', (e) => {
  state.thresholdGB = Number(e.target.value);
  el.thresholdValue.textContent = state.thresholdGB;
  if (state.viewMode === 'browse') renderCurrent();
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!el.viewResults.hidden && state.viewMode === 'browse') renderCurrent();
  }, 150);
});

// ---------- Init ----------
loadDrives();
