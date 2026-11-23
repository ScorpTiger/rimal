// Writes large map files into the Origin Private File System from a worker, using sync access handles.
// Android WebView (Chrome < ~121) refuses createWritable() on the main thread, but supports this path.
let handle = null, dir = null, name = null;

self.onmessage = async (e) => {
  const { id, op, data } = e.data;
  try {
    if (op === 'open') {
      const root = await navigator.storage.getDirectory();
      dir = await root.getDirectoryHandle('maps', { create: true });
      name = data.name;
      const fh = await dir.getFileHandle(name, { create: true });
      handle = await fh.createSyncAccessHandle();
      handle.truncate(0);
      self.postMessage({ id, ok: true });
    } else if (op === 'write') {
      const n = handle.write(new Uint8Array(data.buf), { at: data.at });
      self.postMessage({ id, ok: true, n });
    } else if (op === 'close') {
      handle.flush(); const size = handle.getSize(); handle.close(); handle = null;
      self.postMessage({ id, ok: true, size });
    } else if (op === 'abort') {
      try { handle?.close(); } catch { /* ignore */ }
      handle = null;
      if (dir && name) await dir.removeEntry(name).catch(() => {});
      self.postMessage({ id, ok: true });
    } else if (op === 'rename') {
      // move() is not available everywhere: copy through a second access handle.
      const src = await (await dir.getFileHandle(data.from)).createSyncAccessHandle();
      const dst = await (await dir.getFileHandle(data.to, { create: true })).createSyncAccessHandle();
      dst.truncate(0);
      const size = src.getSize(), buf = new Uint8Array(8 * 1024 * 1024);
      for (let at = 0; at < size; at += buf.length) {
        const n = src.read(buf, { at });
        dst.write(n === buf.length ? buf : buf.subarray(0, n), { at });
      }
      dst.flush(); src.close(); dst.close();
      await dir.removeEntry(data.from);
      self.postMessage({ id, ok: true, size });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: `${err.name}: ${err.message}` });
  }
};
