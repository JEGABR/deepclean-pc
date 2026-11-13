const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deepCleanAPI', {
  getSystemStatus: () => ipcRenderer.invoke('get-system-status'),
  cancelScan: () => ipcRenderer.invoke('cancel-scan'),
  getInstalledPrograms: (options) => ipcRenderer.invoke('get-installed-programs', options),
  uninstallProgram: (appInfo) => ipcRenderer.invoke('uninstall-program', appInfo),
  forceRemoveProgram: (appInfo) => ipcRenderer.invoke('force-remove-program', appInfo),
  runExecutable: (exePath) => ipcRenderer.invoke('run-executable', exePath),
  scanGhostPrograms: () => ipcRenderer.invoke('scan-ghost-programs'),
  scanUnusedFiles: (options) => ipcRenderer.invoke('scan-unused-files', options),
  scanSystemJunk: () => ipcRenderer.invoke('scan-system-junk'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  revealInExplorer: (targetPath) => ipcRenderer.invoke('reveal-in-explorer', targetPath),
  deleteItemsPermanently: (payload) => ipcRenderer.invoke('delete-items-permanently', payload),
  migrateBetweenDrives: (payload) => ipcRenderer.invoke('migrate-between-drives', payload),
  onScanProgress: (callback) => {
    ipcRenderer.removeAllListeners('scan-progress');
    ipcRenderer.on('scan-progress', (_event, data) => callback(data));
  }
});
