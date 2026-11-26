import { native } from './native.js';
// Offline map packs + automatic updates.
// Packs are published as GitHub releases (see .github/workflows/build-packs.yml):
//   tag  pack-<kind>-<YYYYMMDD>   asset  ksa-<kind>.pmtiles  (or ksa-poi.json)
// kind = map | terrain | satellite | poi
// The newest two versions of every pack are kept on the device: if the new one is damaged or missing an area,
// the previous one is still there and is used automatically.
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import * as store from './storage.js';

export const KINDS = { map: 'Street & track map', terrain: 'Terrain (3D, hillshade, contours)', satellite: 'Satellite overview (zoom 10)', poi: 'Places & POIs (search)', routing: 'Road directions (turn-by-turn on roads)' };
const REGIONS = { nw: 'north-west', ne: 'north-east', sw: 'south-west', se: 'south-east' };
/** Human label for a pack key such as "map" or "satellite-nw". */
export function label(key) {
  const [kind, region] = key.split('-');
  if (kind === 'satellite' && region) return `Satellite, ${REGIONS[region] || region} KSA (zoom 13)`;
  return KINDS[kind] || key;
}
/** Pack key from a stored file name: ksa-satellite-nw-20261124.pmtiles → satellite-nw */
export const keyOfFile = (name, kind) => (/^ksa-/.test(name) ? name.replace(/^ksa-/, '').replace(/\.(pmtiles|json|rrt)$/i, '').replace(/-\d{8}.*$/, '').replace(/^vector$/, 'map') : kind === 'vector' ? 'map' : kind);
export const KEEP_VERSIONS = 2;

export const versionOf = (name) => (name.match(/(\d{8})/) || [])[1] || '00000000';
export function kindOfFile(name, meta = {}) {
  const n = name.toLowerCase();
  if (meta.rimal_kind) return meta.rimal_kind;
  if (/\.rrt$/.test(n) || /routing/.test(n)) return 'routing';
  if (/terrain|dem|elev/.test(n)) return 'terrain';
  if (/sat|imagery|aerial|ortho/.test(n)) return 'satellite';
  return null; // decided from the tile type by the caller
}

function headers(token, binary) {
  const h = { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Ask GitHub which pack versions exist. Returns the newest per kind. */
export async function listRemote(repo, token) {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=40`, { headers: headers(token) });
  if (r.status === 404) throw new Error(token ? 'Repository not found' : 'Repository not found — if it is private, add an access token');
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const releases = await r.json();
  const newest = {};
  for (const rel of releases) {
    const m = rel.tag_name.match(/^pack-(map|terrain|satellite|poi|routing)(?:-([a-z]{2}))?-(\d{8})/);
    if (!m || rel.draft) continue;
    const asset = rel.assets.find((a) => /\.(pmtiles|json|rrt)$/.test(a.name));
    if (!asset) continue;
    const [, kind, region, version] = m;
    const key = region ? `${kind}-${region}` : kind;
    if (!newest[key] || newest[key].version < version) {
      newest[key] = { key, kind, region, version, size: asset.size, name: asset.name, url: token ? asset.url : asset.browser_download_url, notes: rel.name, published: rel.published_at };
    }
  }
  return newest;
}

/** Download one pack version into on-device storage. Returns the stored file name. */
export async function download(item, token, onProgress, signal) {
  const ext = item.name.endsWith('.json') ? 'json' : item.name.endsWith('.rrt') ? 'rrt' : 'pmtiles';
  const file = `ksa-${item.key || item.kind}-${item.version}.${ext}`;
  let stream;
  let cleanup = async () => {};
  if (Capacitor.isNativePlatform()) {
    // Native streaming download to app cache (no CORS, follows GitHub's redirect), then copy into app storage.
    const path = `dl/${file}`;
    await Filesystem.mkdir({ path: 'dl', directory: Directory.Cache, recursive: true }).catch(() => {});
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {});
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    const h = await FileTransfer.addListener('progress', (p) => onProgress?.(0.9 * (p.bytes / (p.contentLength || item.size || 1)), p.bytes));
    try {
      await native.ensureDownloadPermission();
      await FileTransfer.downloadFile({ url: item.url, path: uri, progress: true, headers: headers(token, true), connectTimeout: 30000, readTimeout: 120000 });
    } finally { await h.remove(); }
    const res = await fetch(Capacitor.convertFileSrc(uri));
    if (!res.ok || !res.body) throw new Error('could not read the downloaded file');
    stream = res.body;
    cleanup = () => Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {});
  } else {
    const r = await fetch(item.url, { headers: token ? headers(token, true) : {}, signal });
    if (!r.ok) throw new Error(`Download failed (${r.status})`);
    stream = r.body;
  }
  try {
    if (ext === 'json') {
      const text = await new Response(stream).text();
      const data = JSON.parse(text);
      await store.put('kv', { version: item.version, data }, `poi:${item.version}`);
    } else {
      await store.writeStreamToOPFS(file, stream, Capacitor.isNativePlatform() ? 0 : item.size, (p) => onProgress?.(Capacitor.isNativePlatform() ? 0.9 + 0.1 * p : p));
    }
  } finally { await cleanup(); }
  return file;
}

/** Delete all but the newest KEEP_VERSIONS files of each kind. `files` = [{name, kind}] */
export async function prune(files) {
  // Group by pack (kind + region), so each regional satellite pack keeps its own previous version.
  const byKind = {};
  for (const f of files) if (f.kind) (byKind[keyOfFile(f.name, f.kind)] ||= []).push(f);
  const removed = [];
  for (const list of Object.values(byKind)) {
    list.sort((a, b) => versionOf(b.name).localeCompare(versionOf(a.name)));
    for (const f of list.slice(KEEP_VERSIONS)) {
      if (!/\d{8}/.test(f.name)) continue; // never auto-delete files the user imported by hand
      await store.deleteMapFile(f.name); removed.push(f.name);
    }
  }
  // POI versions live in IndexedDB
  const kv = await store.getAllKeys('kv');
  const pois = kv.filter((k) => String(k).startsWith('poi:')).sort().reverse();
  for (const k of pois.slice(KEEP_VERSIONS)) { await store.del('kv', k); removed.push(k); }
  return removed;
}

export async function latestPOI() {
  const keys = (await store.getAllKeys('kv')).filter((k) => String(k).startsWith('poi:')).sort().reverse();
  for (const k of keys) { const v = await store.get('kv', k); if (v?.data?.length) return v; }
  return null;
}

export function connectionOk(policy) {
  if (policy === 'off') return false;
  if (navigator.onLine === false) return false;
  const c = navigator.connection;
  if (policy === 'wifi' && c && c.type && ['cellular', 'bluetooth', 'wimax'].includes(c.type)) return false;
  if (c && c.saveData && policy === 'wifi') return false;
  return true;
}
