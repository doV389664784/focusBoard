'use strict';

/**
 * 白名单桥接：渲染层只能看到这几个方法，拿不到 ipcRenderer 本体。
 * 新增能力请在这里显式加一个函数，不要暴露通用 invoke。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,

  load: function () {
    return ipcRenderer.invoke('db:load');
  },

  save: function (data) {
    return ipcRenderer.invoke('db:save', data);
  },

  notify: function (payload) {
    ipcRenderer.send('notify', payload);
  },

  setTrayText: function (text) {
    ipcRenderer.send('tray:update', text);
  },

  info: function () {
    return ipcRenderer.invoke('app:info');
  }
});
