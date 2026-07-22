'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // מחזיר רשימת כוננים עם total/free/used
  listDrives: () => ipcRenderer.invoke('list-drives'),

  // מתחיל סריקה של נתיב; מחזיר { ok, tree } כשמסתיים
  scanStart: (rootPath) => ipcRenderer.invoke('scan-start', rootPath),

  // מבטל סריקה פעילה
  scanCancel: () => ipcRenderer.invoke('scan-cancel'),

  // פותח פריט בסייר Windows (מסמן אותו בתיקייה המכילה)
  openInExplorer: (targetPath) => ipcRenderer.invoke('open-in-explorer', targetPath),

  // שמירה/טעינה של סריקות
  saveScan: (payload) => ipcRenderer.invoke('save-scan', payload),
  listScans: () => ipcRenderer.invoke('list-scans'),
  loadScan: (driveId) => ipcRenderer.invoke('load-scan', driveId),
  loadPrevScan: (driveId) => ipcRenderer.invoke('load-prev-scan', driveId),

  // האזנה להתקדמות הסריקה
  onScanProgress: (callback) => {
    const listener = (_evt, data) => callback(data);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.removeListener('scan-progress', listener);
  },

  // גרסה ועדכונים
  getVersion: () => ipcRenderer.invoke('get-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (callback) => {
    const listener = (_evt, data) => callback(data);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  }
});
