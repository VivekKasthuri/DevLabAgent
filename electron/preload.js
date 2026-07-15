// electron/preload.js — Context bridge for safe IPC
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getAppPath:  ()     => ipcRenderer.invoke('get-app-path'),
  openFolder:  ()     => ipcRenderer.invoke('open-folder'),
  getPlatform: ()     => ipcRenderer.invoke('get-platform'),
  platform: process.platform,
});
