// Thin layer over native (Android app) vs. browser capabilities.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { KeepAwake } from '@capacitor-community/keep-awake';

const isNative = Capacitor.isNativePlatform();
let wakeLock;

export const native = {
  isNative,

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
};
