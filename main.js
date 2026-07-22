'use strict';

// הגדלת מאגר ה-I/O threads של libuv (משותף לכל התהליך כולל workers) — לפני כל שימוש ב-fs.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '24';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');

let mainWindow = null;
let activeWorker = null;

// ---------- אחסון סריקות שמורות ----------
const SCANS_DIR = path.join(app.getPath('userData'), 'scans');
const INDEX_FILE = path.join(SCANS_DIR, 'index.json');

function ensureScansDir() {
  try { fs.mkdirSync(SCANS_DIR, { recursive: true }); } catch (_) {}
}
function sanitizeId(id) {
  return String(id).replace(/[^A-Za-z0-9]/g, '') || 'x';
}
function scanFilePath(driveId, prev) {
  return path.join(SCANS_DIR, sanitizeId(driveId) + (prev ? '.prev' : '') + '.json');
}
function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeIndex(idx) {
  try { fs.writeFileSync(INDEX_FILE, JSON.stringify(idx), 'utf8'); } catch (_) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f1419',
    title: 'ניהול אחסון',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    terminateWorker();
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- מניית כוננים דרך PowerShell ----------
function listDrives() {
  return new Promise((resolve) => {
    // Get-CimInstance Win32_LogicalDisk → DeviceID, Size, FreeSpace, VolumeName, DriveType
    const psScript =
      'Get-CimInstance Win32_LogicalDisk | ' +
      'Select-Object DeviceID, Size, FreeSpace, VolumeName, DriveType | ' +
      'ConvertTo-Json -Compress';

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          let parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed)) parsed = [parsed];
          const driveTypeName = (t) => {
            switch (Number(t)) {
              case 2: return 'נשלף';       // Removable
              case 3: return 'קבוע';        // Local disk
              case 4: return 'רשת';         // Network
              case 5: return 'תקליטור';     // CD-ROM
              default: return 'אחר';
            }
          };
          const drives = parsed
            .filter((d) => d && d.DeviceID)
            .map((d) => {
              const size = Number(d.Size) || 0;
              const free = Number(d.FreeSpace) || 0;
              return {
                id: d.DeviceID,               // "C:"
                path: d.DeviceID + '\\',      // "C:\"
                label: d.VolumeName || '',
                total: size,
                free: free,
                used: Math.max(0, size - free),
                typeName: driveTypeName(d.DriveType),
                driveType: Number(d.DriveType)
              };
            })
            // רק כוננים עם קיבולת אמיתית (מסנן כונני רשת/תקליטור ריקים)
            .filter((d) => d.total > 0);
          resolve(drives);
        } catch (e) {
          resolve([]);
        }
      }
    );
  });
}

ipcMain.handle('list-drives', async () => {
  return await listDrives();
});

// ---------- פתיחה בסייר Windows ----------
ipcMain.handle('open-in-explorer', async (_evt, targetPath) => {
  if (!targetPath || typeof targetPath !== 'string') return { ok: false };
  try {
    // showItemInFolder מסמן את הפריט בתוך התיקייה המכילה אותו
    shell.showItemInFolder(targetPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ---------- שמירה/טעינה של סריקות ----------
// שומר עץ סריקה לכונן, ומגלגל את הסריקה הקודמת (עבור השוואה).
ipcMain.handle('save-scan', async (_evt, payload) => {
  try {
    ensureScansDir();
    const { driveId, displayName, rootPath, totalSize, scannedAt, tree } = payload;
    const curFile = scanFilePath(driveId, false);
    const prevFile = scanFilePath(driveId, true);

    // גלגול: הסריקה הנוכחית הופכת ל"קודמת"
    let hadPrev = false;
    if (fs.existsSync(curFile)) {
      try { fs.copyFileSync(curFile, prevFile); hadPrev = true; } catch (_) {}
    }

    fs.writeFileSync(curFile, JSON.stringify({ meta: { driveId, displayName, rootPath, totalSize, scannedAt }, tree }), 'utf8');

    const idx = readIndex();
    idx[sanitizeId(driveId)] = { driveId, displayName, rootPath, totalSize, scannedAt, hasPrev: hadPrev || (idx[sanitizeId(driveId)] && idx[sanitizeId(driveId)].hasPrev) || false };
    writeIndex(idx);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('list-scans', async () => {
  return readIndex();
});

ipcMain.handle('load-scan', async (_evt, driveId) => {
  try {
    const data = JSON.parse(fs.readFileSync(scanFilePath(driveId, false), 'utf8'));
    return { ok: true, meta: data.meta, tree: data.tree };
  } catch (e) {
    return { ok: false, error: 'לא נמצאה סריקה שמורה' };
  }
});

ipcMain.handle('load-prev-scan', async (_evt, driveId) => {
  try {
    const data = JSON.parse(fs.readFileSync(scanFilePath(driveId, true), 'utf8'));
    return { ok: true, meta: data.meta, tree: data.tree };
  } catch (e) {
    return { ok: false };
  }
});

// ---------- סריקה דרך worker_thread ----------
function terminateWorker() {
  if (activeWorker) {
    const w = activeWorker;
    activeWorker = null;
    // בקשה מסודרת לעצור (הורגת את robocopy ומנקה קבצים זמניים), ואז terminate כגיבוי
    try { w.postMessage({ cancel: true }); } catch (_) {}
    setTimeout(() => { try { w.terminate(); } catch (_) {} }, 800);
  }
}

ipcMain.handle('scan-cancel', async () => {
  terminateWorker();
  return { ok: true };
});

ipcMain.handle('scan-start', async (_evt, rootPath) => {
  terminateWorker();

  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'scanner-worker.js'), {
      workerData: { rootPath },
      env: { ...process.env, UV_THREADPOOL_SIZE: '24' }
    });
    activeWorker = worker;

    worker.on('message', (msg) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (msg.type === 'progress') {
        mainWindow.webContents.send('scan-progress', msg);
      } else if (msg.type === 'done') {
        mainWindow.webContents.send('scan-progress', { type: 'progress', done: true });
        resolve({ ok: true, tree: msg.tree });
        if (activeWorker === worker) activeWorker = null;
      } else if (msg.type === 'error') {
        resolve({ ok: false, error: msg.error });
        if (activeWorker === worker) activeWorker = null;
      }
    });

    worker.on('error', (err) => {
      resolve({ ok: false, error: String(err && err.message ? err.message : err) });
      if (activeWorker === worker) activeWorker = null;
    });

    worker.on('exit', (code) => {
      if (activeWorker === worker) activeWorker = null;
      if (code !== 0) {
        resolve({ ok: false, error: 'הסריקה הופסקה או נכשלה (קוד ' + code + ')' });
      }
    });
  });
});
