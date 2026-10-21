/**
 * 存储适配层：优先走 Electron 主进程（IPC），否则退回 localStorage，
 * 再不行就纯内存 —— 保证 index.html 用浏览器直接打开也能完整体验。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.FB = root.FB || {}).store = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LS_KEY = 'focusboard.data.v1';

  function hasElectron() {
    return !!(typeof window !== 'undefined' && window.api && typeof window.api.load === 'function');
  }

  function lsAvailable() {
    try {
      const k = '__fb_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  function electronBackend(api) {
    return {
      name: 'electron',
      load: function () {
        return api.load();
      },
      save: function (data) {
        return api.save(data);
      }
    };
  }

  function localStorageBackend() {
    return {
      name: 'localStorage',
      load: function () {
        try {
          const raw = window.localStorage.getItem(LS_KEY);
          return Promise.resolve(raw ? JSON.parse(raw) : null);
        } catch (e) {
          return Promise.resolve(null);
        }
      },
      save: function (data) {
        try {
          window.localStorage.setItem(LS_KEY, JSON.stringify(data));
          return Promise.resolve(true);
        } catch (e) {
          return Promise.resolve(false);
        }
      }
    };
  }

  function memoryBackend() {
    let stash = null;
    return {
      name: 'memory',
      load: function () { return Promise.resolve(stash); },
      save: function (data) { stash = data; return Promise.resolve(true); }
    };
  }

  function create() {
    if (hasElectron()) return electronBackend(window.api);
    if (lsAvailable()) return localStorageBackend();
    return memoryBackend();
  }

  return { create: create, LS_KEY: LS_KEY };
});
