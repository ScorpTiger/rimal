// Thin layer over native (Android app) vs. browser capabilities.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { FileTransfer } from '@capacitor/file-transfer';
import { registerPlugin } from '@capacitor/core';

// Rimal's own native helpers (android/app/src/main/java/com/rimal/offroad/RimalNativePlugin.java).
const RimalNative = registerPlugin('RimalNative');

const isNative = Capacitor.isNativePlatform();
let wakeLock;

export const native = {
  isNative,
  platform: Capacitor.getPlatform(),

  async keepAwake() {
    try {
      if (isNative) return await KeepAwake.keepAwake();
      if ('wakeLock' in navigator) {
        const req = async () => { try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ } };
        await req();
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') req(); });
      }
    } catch { /* ignore */ }
  },

  /** Save a text file. Returns a human-readable location (native) or null (browser download). */
  async saveText(filename, text) {
    if (isNative) {
      try {
        await Filesystem.writeFile({ path: `Rimal/${filename}`, data: text, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
        return `Documents/Rimal/${filename}`;
      } catch {
        // Fall back to app storage + share sheet (send to USB / Files / WhatsApp, etc.)
        const r = await Filesystem.writeFile({ path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
        try { await Share.share({ title: filename, url: r.uri, dialogTitle: 'Save or send GPX' }); } catch { /* ignore */ }
        return 'share sheet';
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return null;
  },

  /** Installed app version and signing certificate (Android). */
  async appInfo() {
    if (!isNative || Capacitor.getPlatform() !== 'android') return null;
    try { return await RimalNative.appInfo(); } catch { return null; }
  },

  /** Write a large binary file to Documents/Rimal in pieces. Returns { write(u8), close() → where }. */
  async binaryWriter(filename) {
    if (!isNative) { const parts = []; return { write: async (u8) => { parts.push(u8); }, close: async () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(parts)); a.download = filename; a.click(); return 'downloaded'; } }; }
    await this.ensureDownloadPermission();
    const path = `Rimal/${filename}`; let first = true;
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    return {
      write: async (u8) => { if (first) { await Filesystem.writeFile({ path, data: b64(u8), directory: Directory.Documents, recursive: true }); first = false; } else await Filesystem.appendFile({ path, data: b64(u8), directory: Directory.Documents }); },
      close: async () => `Documents/Rimal/${filename}`,
    };
  },

  /** Android 10 and older need storage permission before the download plugin will run. */
  async ensureDownloadPermission() {
    if (!isNative || Capacitor.getPlatform() !== 'android') return true;
    try { const p = await Filesystem.checkPermissions(); if (p.publicStorage === 'granted') return true; const r = await Filesystem.requestPermissions(); return r.publicStorage === 'granted'; } catch { return true; }
  },

  /** Download a file into app cache with progress; returns the native file path. */
  async download(url, name, onProgress) {
    await this.ensureDownloadPermission();
    const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache });
    try { await Filesystem.deleteFile({ path: name, directory: Directory.Cache }); } catch { /* none */ }
    const h = await FileTransfer.addListener('progress', (p) => onProgress?.(p.bytes / (p.contentLength || 1), p.bytes));
    try { await FileTransfer.downloadFile({ url, path: uri, progress: true, connectTimeout: 30000, readTimeout: 120000 }); }
    finally { await h.remove(); }
    return uri;
  },

  /** Hand a downloaded APK to Android's installer. Returns {needsPermission} when the user must allow it first. */
  installApk(path) { return RimalNative.installApk({ path }); },
  /** Open a file (e.g. the PDF manual) in the device's viewer. */
  openFile(path, mime = 'application/pdf') { return RimalNative.openFile({ path, mime }); },

  /** Voice guidance through the device's own text-to-speech engine (no download needed). */
  async speak(text, lang = 'en', rate = 1) {
    if (isNative && Capacitor.getPlatform() === 'android') { try { return await RimalNative.speak({ text, lang, rate }); } catch { return null; } }
    try { const u = new SpeechSynthesisUtterance(text); u.lang = lang.startsWith('ar') ? 'ar-SA' : 'en-GB'; u.rate = rate; speechSynthesis.speak(u); return { languageOk: true }; } catch { return null; }
  },
  stopSpeaking() { if (isNative && Capacitor.getPlatform() === 'android') return RimalNative.stopSpeaking().catch(() => {}); try { speechSynthesis.cancel(); } catch { /* none */ } },

  /** Send a text file through the share menu (Bluetooth, WhatsApp, email, Drive…). */
  async shareText(filename, text) {
    if (!isNative) return this.saveText(filename, text);
    const r = await Filesystem.writeFile({ path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: filename, files: [r.uri], dialogTitle: 'Send ' + filename });
    return 'shared';
  },
};
