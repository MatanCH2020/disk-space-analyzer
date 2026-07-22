'use strict';

/*
 * מנוע סריקה מבוסס robocopy (מובנה ב-Windows).
 * robocopy במצב רשימה (/L) מונה את כל הקבצים עם הגדלים בפעולה מקבילית (/MT),
 * הרבה יותר מהר מ-stat פר קובץ. אנחנו רק צוברים גודל פר תיקייה ובונים עץ.
 */

const { parentPort, workerData } = require('worker_threads');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const MAX_CHILDREN = 400;

// נרמול נתיב השורש
let rootPath = workerData.rootPath;
if (/^[A-Za-z]:$/.test(rootPath)) rootPath += '\\';
let normRoot = rootPath;
if (normRoot.length > 3 && normRoot.endsWith('\\')) normRoot = normRoot.slice(0, -1);
const rootKey = normRoot.toLowerCase();

const logFile = path.join(os.tmpdir(), 'storage_scan_' + process.pid + '_' + Date.now() + '.log');
const nullDest = path.join(os.tmpdir(), '__storage_scan_null__');

let child = null;
let cancelled = false;
let progressTimer = null;

// ---------- ביטול מ-main ----------
parentPort.on('message', (msg) => {
  if (msg && msg.cancel) {
    cancelled = true;
    stopProgress();
    if (child) { try { child.kill(); } catch (_) {} }
    setTimeout(() => { cleanupTemp(); process.exit(0); }, 200);
  }
});

function stopProgress() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function cleanupTemp() {
  try { fs.unlinkSync(logFile); } catch (_) {}
}

// ---------- מעקב התקדמות: קריאת בייטים חדשים מהלוג וספירת שורות ----------
let progressOffset = 0;
let filesSeen = 0;
let lastPathSeen = normRoot;
const LINE_RE = /^\s*(\d+)\s+([A-Za-z]:.+)$/;

function pollProgress() {
  fs.stat(logFile, (err, st) => {
    if (err || st.size <= progressOffset) return;
    // גודל קובץ UTF-16LE תמיד זוגי → יישור בטוח
    const start = progressOffset;
    const end = st.size - 1;
    progressOffset = st.size;
    let chunk = '';
    const stream = fs.createReadStream(logFile, { start, end, encoding: 'utf16le' });
    stream.on('data', (d) => { chunk += d; });
    stream.on('error', () => {});
    stream.on('end', () => {
      let count = 0;
      let lastLine = '';
      let from = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === '\n') {
          count++;
          lastLine = chunk.slice(from, i);
          from = i + 1;
        }
      }
      filesSeen += count;
      const m = LINE_RE.exec(lastLine.replace(/\r$/, ''));
      if (m) lastPathSeen = path.dirname(m[2]);
      parentPort.postMessage({
        type: 'progress',
        phase: 'scan',
        filesScanned: filesSeen,
        currentPath: lastPathSeen
      });
    });
  });
}

// ---------- בניית עץ תיקיות ----------
const nodes = new Map(); // key: lowercased path → node
function ensureDir(dir) {
  const key = dir.toLowerCase();
  let n = nodes.get(key);
  if (n) return n;
  n = { name: path.basename(dir) || dir, path: dir, ownSize: 0, size: 0, children: [] };
  nodes.set(key, n);
  if (key !== rootKey && dir.length > normRoot.length) {
    const parent = ensureDir(path.dirname(dir));
    parent.children.push(n);
  }
  return n;
}

function finalize(node) {
  let total = node.ownSize || 0;
  for (const child of node.children) {
    finalize(child);
    total += child.size;
  }
  if (node.ownSize > 0) {
    node.children.push({
      name: 'קבצים בתיקייה זו',
      path: node.path,
      size: node.ownSize,
      type: 'files-here'
    });
  }
  node.size = total;
  delete node.ownSize;

  node.children.sort((a, b) => b.size - a.size);
  if (node.children.length > MAX_CHILDREN) {
    const kept = node.children.slice(0, MAX_CHILDREN);
    const rest = node.children.slice(MAX_CHILDREN);
    let restSize = 0;
    for (const r of rest) restSize += r.size;
    kept.push({
      name: rest.length + ' פריטים נוספים',
      path: node.path,
      size: restSize,
      type: 'more-bucket',
      itemCount: rest.length
    });
    node.children = kept;
  }
  node.type = 'dir';
}

// ---------- פענוח הלוג ובניית התוצאה ----------
function parseAndFinish() {
  stopProgress();
  const root = ensureDir(normRoot);

  const rl = readline.createInterface({
    input: fs.createReadStream(logFile, { encoding: 'utf16le' }),
    crlfDelay: Infinity
  });

  let fileCount = 0;
  rl.on('line', (line) => {
    const m = LINE_RE.exec(line);
    if (!m) return;
    const size = Number(m[1]);
    if (!(size >= 0)) return;
    const filePath = m[2].replace(/\s+$/, '');
    const dir = path.dirname(filePath);
    ensureDir(dir).ownSize += size;
    fileCount++;
  });

  rl.on('close', () => {
    if (cancelled) { cleanupTemp(); return; }
    finalize(root);
    root.name = normRoot;
    parentPort.postMessage({
      type: 'progress', phase: 'done', filesScanned: fileCount, currentPath: ''
    });
    parentPort.postMessage({ type: 'done', tree: root });
    cleanupTemp();
  });

  rl.on('error', (e) => {
    parentPort.postMessage({ type: 'error', error: 'שגיאת קריאת לוג: ' + String(e && e.message) });
    cleanupTemp();
  });
}

// ---------- הרצה ----------
const args = [
  normRoot, nullDest,
  '/L', '/E', '/BYTES', '/NJH', '/NJS', '/NDL', '/NC', '/FP', '/NP',
  '/R:0', '/W:0', '/MT:32', '/UNILOG:' + logFile
];

try {
  child = spawn('robocopy', args, { windowsHide: true });

  child.on('error', (err) => {
    stopProgress();
    parentPort.postMessage({ type: 'error', error: 'לא ניתן להריץ robocopy: ' + err.message });
    cleanupTemp();
  });

  child.on('close', (code) => {
    stopProgress();
    if (cancelled) { cleanupTemp(); return; }
    // robocopy: קוד >=16 = שגיאה קטלנית; אחרת יש נתונים (גם אם חלק מהתיקיות נחסמו)
    if (code >= 16) {
      // ננסה בכל זאת לפענח אם נכתב לוג
      if (!fs.existsSync(logFile)) {
        parentPort.postMessage({ type: 'error', error: 'robocopy נכשל (קוד ' + code + ')' });
        return;
      }
    }
    parseAndFinish();
  });

  // מעקב התקדמות כל 500ms
  progressTimer = setInterval(pollProgress, 500);
} catch (e) {
  parentPort.postMessage({ type: 'error', error: String(e && e.message ? e.message : e) });
  cleanupTemp();
}
