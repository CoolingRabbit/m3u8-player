(() => {
  'use strict';

  const DATABASE_NAME = 'm3u8-player-logs';
  const DATABASE_VERSION = 1;
  const MAX_VISIBLE_ENTRIES = 500;

  function localDay(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function localTimestamp(date) {
    return `${localDay(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  }

  function printableDetails(details) {
    if (details === undefined || details === null || details === '') return '';
    if (typeof details === 'string') return details;
    try {
      return JSON.stringify(details, (_, value) => {
        if (value instanceof Error) return value.message;
        return value;
      });
    } catch {
      return String(details);
    }
  }

  function formatEntry(entry) {
    const details = printableDetails(entry.details);
    return `[${localTimestamp(new Date(entry.timestamp))}] [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}${details ? ` | ${details}` : ''}`;
  }

  class DailyLogger {
    constructor(handlers = {}) {
      this.handlers = handlers;
      this.database = null;
      this.directory = null;
      this.entries = [];
      this.pending = [];
      this.currentDay = localDay();
      this.flushTimer = null;
      this.flushing = false;
      this.writeBlocked = false;
      this.diskError = '';
      this.supportsDirectories = typeof window.showDirectoryPicker === 'function';
    }

    async init() {
      try {
        this.database = await this.openDatabase();
        await Promise.all([this.loadToday(), this.restoreDirectory()]);
      } catch (error) {
        console.warn('日志本地数据库不可用', error);
      }
      this.updateStatus();
      this.notify();
    }

    openDatabase() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('entries')) {
            const entries = database.createObjectStore('entries', { keyPath: 'id' });
            entries.createIndex('day', 'day', { unique: false });
          }
          if (!database.objectStoreNames.contains('preferences')) {
            database.createObjectStore('preferences');
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('日志数据库升级被其他页面阻塞'));
      });
    }

    requestToPromise(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    async loadToday() {
      if (!this.database) return;
      const transaction = this.database.transaction('entries', 'readonly');
      const request = transaction.objectStore('entries').index('day').getAll(IDBKeyRange.only(this.currentDay));
      this.entries = (await this.requestToPromise(request))
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-MAX_VISIBLE_ENTRIES);
    }

    async restoreDirectory() {
      if (!this.database || !this.supportsDirectories) return;
      const transaction = this.database.transaction('preferences', 'readonly');
      const handle = await this.requestToPromise(transaction.objectStore('preferences').get('directory'));
      if (!handle) return;
      const permission = await handle.queryPermission({ mode: 'readwrite' });
      if (permission === 'granted') this.directory = handle;
    }

    saveEntry(entry) {
      if (!this.database) return;
      try {
        const transaction = this.database.transaction('entries', 'readwrite');
        transaction.objectStore('entries').put(entry);
        transaction.onerror = () => {
          console.warn('日志写入本地数据库失败', transaction.error);
          this.updateStatus('日志数据库写入失败，可手动下载当前日志');
        };
      } catch (error) {
        console.warn('日志写入本地数据库失败', error);
      }
    }

    log(category, message, details = null, level = 'info') {
      const now = new Date();
      const day = localDay(now);
      if (day !== this.currentDay) {
        this.currentDay = day;
        this.entries = [];
        this.loadToday().then(() => this.notify()).catch((error) => console.warn('读取当日日志失败', error));
      }
      const entry = {
        id: globalThis.crypto?.randomUUID?.() || `${now.getTime()}-${Math.random().toString(16).slice(2)}`,
        day,
        timestamp: now.toISOString(),
        level,
        category,
        message: String(message),
        details
      };
      this.entries.push(entry);
      if (this.entries.length > MAX_VISIBLE_ENTRIES) this.entries.shift();
      this.pending.push(entry);
      if (this.pending.length > 10000) this.pending.shift();
      this.saveEntry(entry);
      this.notify();
      if (this.directory && !this.writeBlocked) this.scheduleFlush();
    }

    scheduleFlush() {
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), 700);
    }

    async flush() {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      if (!this.directory || !this.pending.length || this.flushing || this.writeBlocked) return;
      this.flushing = true;
      const batch = this.pending.splice(0);
      try {
        const groups = new Map();
        batch.forEach((entry) => {
          const lines = groups.get(entry.day) || [];
          lines.push(formatEntry(entry));
          groups.set(entry.day, lines);
        });
        for (const [day, lines] of groups) {
          await this.appendText(`m3u8-player-${day}.txt`, `${lines.join('\r\n')}\r\n`);
        }
        this.diskError = '';
        this.updateStatus();
      } catch (error) {
        this.pending.unshift(...batch);
        this.writeBlocked = true;
        this.diskError = error.message || String(error);
        console.warn('TXT 日志写入失败', error);
        this.updateStatus();
      } finally {
        this.flushing = false;
        if (this.pending.length && this.directory && !this.writeBlocked) this.scheduleFlush();
      }
    }

    async appendText(fileName, text) {
      const handle = await this.directory.getFileHandle(fileName, { create: true });
      const file = await handle.getFile();
      const stream = await handle.createWritable({ keepExistingData: true });
      try {
        await stream.write({ type: 'write', position: file.size, data: text });
      } finally {
        await stream.close();
      }
    }

    async chooseDirectory() {
      if (!this.supportsDirectories) throw new Error('当前浏览器不支持目录写入，请使用最新版 Edge 或 Chrome，或直接下载 TXT');
      const handle = await window.showDirectoryPicker({ id: 'm3u8-player-logs', mode: 'readwrite' });
      const permission = await handle.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') throw new Error('未获得所选目录的读写权限');
      this.directory = handle;
      this.writeBlocked = false;
      this.diskError = '';
      if (this.database) {
        const transaction = this.database.transaction('preferences', 'readwrite');
        transaction.objectStore('preferences').put(handle, 'directory');
      }
      this.updateStatus();
      await this.flush();
      return `m3u8-player-${this.currentDay}.txt`;
    }

    async downloadToday() {
      let entries = this.entries;
      if (this.database) {
        const transaction = this.database.transaction('entries', 'readonly');
        const request = transaction.objectStore('entries').index('day').getAll(IDBKeyRange.only(this.currentDay));
        entries = await this.requestToPromise(request);
      }
      entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      const text = entries.map(formatEntry).join('\r\n') + (entries.length ? '\r\n' : '');
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `m3u8-player-${this.currentDay}.txt`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return entries.length;
    }

    updateStatus(override = '') {
      let text = override;
      if (!text && this.diskError) text = 'TXT 写入失败，请重新选择目录或手动下载';
      if (!text && this.directory) text = `本地数据库 + 每日 TXT 自动保存（${this.directory.name}）`;
      if (!text && !this.database) text = '当前会话暂存，可手动下载当日 TXT';
      if (!text && this.supportsDirectories) text = '已保存到浏览器，选择目录后按天写入 TXT';
      if (!text) text = '已保存到浏览器，可手动下载当日 TXT';
      this.handlers.onStatus?.(text);
    }

    notify() {
      this.handlers.onChange?.([...this.entries]);
    }
  }

  window.DailyLogger = DailyLogger;
})();
