'use strict';
// FrecklesNight: server del portale video in LAN. Usa solo moduli integrati di Node (+ ffmpeg per anteprime e sottotitoli).
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const BASE = __dirname;
const WEB = path.join(BASE, 'web');
const DATA = path.join(BASE, 'data');
const THUMBS = path.join(DATA, 'thumbs');
const SUBS = path.join(DATA, 'subs');
for (const d of [DATA, THUMBS, SUBS]) fs.mkdirSync(d, { recursive: true });

const config = Object.assign(
  { port: 8787, movies: [], series: [], tmdbKey: '', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
  JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8').replace(/^﻿/, '')) // il BOM di Windows rompe JSON.parse
);

const downloads = require('./arr')(config);

// ---------- persistenza ----------
function loadJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return fallback; }
}
const stores = {};
for (const n of ['progress.json', 'meta.json', 'probe.json']) stores[n] = loadJson(n, {});
const progress = stores['progress.json'];
const meta = stores['meta.json'];
const probes = stores['probe.json'];
const timers = {};
function save(name) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => writeNow(name), 1000);
}
function writeNow(name) {
  clearTimeout(timers[name]);
  const file = path.join(DATA, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(stores[name]));
  fs.renameSync(file + '.tmp', file);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { Object.keys(stores).forEach(writeNow); process.exit(0); });

// ---------- lettura dei nomi dei file ----------
const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm', '.ts']);
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt']);
const MIME = {
  '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.ts': 'video/mp2t',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.vtt': 'text/vtt; charset=utf-8',
};
const JUNK = /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr10|hdr|dv|dovi|blu-?ray|bdrip|bdmux|brrip|bdremux|remux|web-?dl|webrip|webmux|weebdl|dlmux|dvdrip|dvdmux|hdtv|hdrip|x264|x265|h ?26[45]|hevc|avc|ac3|aac|dts|ddp?5|dd5|ita|eng|fra|jap|spa|ger|sub|subs|nueng|nf|amzn|dsnp|upscaled|10 ?bit|multisub|fullhd|mux|repack|proper)\b|[[(]/i;

const hash = s => crypto.createHash('sha1').update(s.toLowerCase()).digest('hex').slice(0, 12);
const tidy = s => s.replace(/^\s*\[[^\]]*\]\s*/, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
const trimSep = s => s.replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, '').trim();
const cutJunk = s => { const m = s.match(JUNK); return m ? s.slice(0, m.index) : s; };

function quality(s) {
  const q = /2160p|\b4k\b|\buhd\b/i.test(s) ? '4K' : /1080p|fullhd/i.test(s) ? '1080p' : /720p/i.test(s) ? '720p' : '';
  const hdr = /\bhdr(10)?\b|\bdv\b|dolby ?vision/i.test(s) ? 'HDR' : '';
  return [q, hdr].filter(Boolean).join(' ');
}
const rank = q => ({ '4K': 3, '1080p': 2, '720p': 1 }[q.split(' ')[0]] || 0) + (q.includes('HDR') ? 0.5 : 0);

function parseMovie(file) {
  const raw = tidy(path.parse(file).name);
  let title = raw, year = null, m;
  const re = /(?:^|[\s([])((?:19|20)\d{2})(?=$|[\s)\]])/g;
  while ((m = re.exec(raw))) {
    if (m.index > 0) { year = +m[1]; title = raw.slice(0, m.index); break; }
  }
  title = trimSep(cutJunk(title));
  if (title.includes(' - ')) title = title.split(' - ')[0];
  return { title: trimSep(title) || raw, year, quality: quality(raw) };
}

function parseEpisode(file) {
  const raw = tidy(path.parse(file).name);
  let s, e, rest;
  const m = raw.match(/\bs(\d{1,2}) ?e(\d{1,3})\b/i) || raw.match(/\b(\d{1,2})x(\d{2,3})\b/i);
  if (m) {
    s = +m[1]; e = +m[2]; rest = raw.slice(m.index + m[0].length);
  } else {
    const sm = path.basename(path.dirname(file)).match(/\b(?:s|stagione|season)\s*(\d{1,2})\b/i);
    s = sm ? +sm[1] : 1;
    const em = raw.match(/(?:\b(?:e|ep|episodio|episode)\s*)?(\d{1,3})\b/i);
    e = em ? +em[1] : 0;
    rest = em ? raw.slice(em.index + em[0].length) : raw;
  }
  return { s, e, title: trimSep(cutJunk(rest)) };
}

// ---------- scansione delle cartelle ----------
async function walk(dir, out = [], depth = 0) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of entries) {
    if (d.name.startsWith('.') || d.name.startsWith('$')) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) { if (depth < 4) await walk(full, out, depth + 1); continue; }
    if (!VIDEO.has(path.extname(d.name).toLowerCase()) || /\bsample\b/i.test(d.name)) continue;
    try { const st = await fsp.stat(full); out.push({ full, size: st.size, mtime: st.mtimeMs }); } catch {}
  }
  return out;
}
const findImage = bases => {
  for (const b of bases) for (const x of IMG_EXT) if (fs.existsSync(b + x)) return b + x;
  return null;
};
const noExt = f => f.slice(0, -path.extname(f).length);

let lib = { movies: [], series: [], scannedAt: 0 };
let fileMap = new Map(); // id -> { path, size, mtime }
let imgMap = new Map();
let seriesDirs = new Map(); // id serie -> cartella

async function scan() {
  const files = new Map(), imgs = new Map();
  const img = p => { if (!p) return null; const k = hash('img:' + p); imgs.set(k, p); return '/img/' + k; };
  const addFile = f => { const fid = hash('file:' + f.full); files.set(fid, { path: f.full, size: f.size, mtime: f.mtime }); return fid; };

  // film: un elemento per titolo+anno, con più versioni se ci sono doppioni
  const groups = new Map();
  for (const root of config.movies) {
    for (const f of await walk(root)) {
      const p = parseMovie(f.full);
      const key = p.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + '|' + (p.year || '');
      const fid = addFile(f);
      const dir = path.dirname(f.full);
      const ownFolder = !config.movies.some(r => path.resolve(r) === path.resolve(dir));
      const poster = findImage([noExt(f.full), ...(ownFolder ? ['poster', 'folder', 'cover'].map(n => path.join(dir, n)) : [])]);
      let g = groups.get(key);
      if (!g) groups.set(key, g = { id: hash('movie:' + key), metaKey: 'movie:' + key, title: p.title, year: p.year, versions: [], added: 0, poster: null });
      g.versions.push({ id: fid, label: p.quality || path.extname(f.full).slice(1).toUpperCase(), rank: rank(p.quality), size: f.size });
      g.added = Math.max(g.added, f.mtime);
      if (poster && !g.poster) g.poster = img(poster);
    }
  }
  // un file senza anno nel nome va con lo stesso titolo che l'anno ce l'ha
  for (const [key, g] of groups) {
    if (!key.endsWith('|')) continue;
    const twin = [...groups.entries()].find(([k]) => k !== key && k.startsWith(key));
    if (twin) { twin[1].versions.push(...g.versions); twin[1].added = Math.max(twin[1].added, g.added); twin[1].poster ||= g.poster; groups.delete(key); }
  }
  const movies = [...groups.values()];
  for (const m of movies) {
    m.versions.sort((a, b) => b.rank - a.rank || b.size - a.size);
    const seen = {};
    for (const v of m.versions) { seen[v.label] = (seen[v.label] || 0) + 1; if (seen[v.label] > 1) v.label += ` (${seen[v.label]})`; delete v.rank; }
  }

  // serie: ogni sottocartella è una serie
  const series = [], sdirs = new Map();
  for (const root of config.series) {
    let dirs;
    try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith('.') || d.name.startsWith('$')) continue;
      const dir = path.join(root, d.name);
      const eps = await walk(dir);
      if (!eps.length) continue;
      let added = 0;
      const list = eps.map(f => {
        const p = parseEpisode(f.full);
        added = Math.max(added, f.mtime);
        return { id: addFile(f), s: p.s, e: p.e, title: p.title, still: img(findImage([noExt(f.full)])), name: path.basename(f.full) };
      }).sort((a, b) => a.s - b.s || a.e - b.e || a.name.localeCompare(b.name));
      const seasons = [];
      for (const ep of list) {
        let se = seasons.find(x => x.n === ep.s);
        if (!se) seasons.push(se = { n: ep.s, episodes: [] });
        delete ep.s; delete ep.name;
        se.episodes.push(ep);
      }
      const title = tidy(d.name);
      sdirs.set(hash('series:' + dir), dir);
      series.push({
        id: hash('series:' + dir), metaKey: 'tv:' + title.toLowerCase(), title, seasons, added,
        poster: img(findImage(['poster', 'folder', 'cover'].map(n => path.join(dir, n)))),
      });
    }
  }

  lib = { movies, series, scannedAt: Date.now() };
  fileMap = files;
  imgMap = imgs;
  seriesDirs = sdirs;
  console.log(`Libreria: ${movies.length} film, ${series.length} serie`);
}


// ---------- eliminazione dal disco ----------
async function removeItem(id) {
  const ids = [], gone = [];
  const kind = seriesDirs.has(id) ? 'series' : 'movie';
  if (seriesDirs.has(id)) {
    const dir = seriesDirs.get(id);
    if (!config.series.some(r => path.resolve(r) === path.dirname(path.resolve(dir)))) throw new Error('cartella non valida');
    const s = lib.series.find(x => x.id === id);
    for (const se of s.seasons) for (const ep of se.episodes) ids.push(ep.id);
    await fsp.rm(dir, { recursive: true, force: true });
    gone.push(path.basename(dir));
  } else {
    const m = lib.movies.find(x => x.id === id);
    if (!m) throw new Error('titolo sconosciuto');
    for (const v of m.versions) {
      const f = fileMap.get(v.id);
      if (!f) continue;
      ids.push(v.id);
      const base = path.basename(noExt(f.path)), dir = path.dirname(f.path);
      for (const n of await fsp.readdir(dir).catch(() => [])) {
        if (n === path.basename(f.path) || (n.startsWith(base + '.') && !VIDEO.has(path.extname(n).toLowerCase()))) await fsp.rm(path.join(dir, n), { force: true });
      }
      // film in una cartella propria: se non resta nessun video, via anche la cartella
      if (!config.movies.some(r => path.resolve(r) === path.resolve(dir)) && !(await walk(dir)).length) { await fsp.rm(dir, { recursive: true, force: true }); gone.push(path.basename(dir)); }
    }
  }
  for (const f of ids) { delete progress[f]; fs.rmSync(thumbPath(f), { force: true }); }
  save('progress.json');
  await downloads.forget(kind, gone);
  await rescan();
}

// ---------- ffmpeg: analisi, anteprime, sottotitoli ----------
function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 64 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').pop())); else resolve(stdout);
    });
  });
}
const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

async function probe(fid) {
  const f = fileMap.get(fid);
  if (!f) return null;
  const sig = f.size + ':' + Math.round(f.mtime);
  if (probes[fid] && probes[fid].sig === sig && probes[fid].video !== undefined) return probes[fid];
  const out = JSON.parse(await run(config.ffprobe, [
    '-v', 'error', '-of', 'json',
    '-show_entries', 'format=duration:stream=index,codec_type,codec_name,color_transfer,width,height,pix_fmt:stream_tags=language,title:stream_disposition=forced,default',
    f.path,
  ], 60000));
  const st = out.streams || [];
  const tag = s => s.tags || {};
  const v = st.find(s => s.codec_type === 'video');
  const info = {
    sig,
    dur: +(out.format && out.format.duration) || 0,
    hdr: !!v && /smpte2084|arib-std-b67/.test(v.color_transfer || ''),
    // serve ai client per capire se sanno decodificare il file o devono chiedere la conversione
    video: v ? { codec: v.codec_name, bits: /10/.test(v.pix_fmt || '') ? 10 : 8, w: v.width || 0, h: v.height || 0 } : null,
    audio: st.filter(s => s.codec_type === 'audio').map(s => ({ lang: tag(s).language || '', title: tag(s).title || '', codec: s.codec_name })),
    subs: st.filter(s => s.codec_type === 'subtitle').map((s, n) => ({
      n, codec: s.codec_name, lang: tag(s).language || '', title: tag(s).title || '',
      forced: !!(s.disposition && s.disposition.forced) || /forced|forzat/i.test(tag(s).title || ''),
      text: TEXT_SUBS.has(s.codec_name),
    })),
  };
  probes[fid] = info;
  save('probe.json');
  return info;
}

const thumbPath = fid => path.join(THUMBS, fid + '.jpg');
const thumbUrl = fid => (fs.existsSync(thumbPath(fid)) ? '/thumb/' + fid : null);
async function makeThumb(fid, wide) {
  const f = fileMap.get(fid), info = await probe(fid);
  const at = Math.floor(info.dur ? info.dur * (wide ? 0.2 : 0.25) : 120);
  const scale = `scale=${wide ? 1280 : 640}:-2`;
  // i file HDR danno colori slavati: li porto in SDR prima di salvare l'immagine
  const vf = info.hdr
    ? `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,${scale}`
    : scale;
  const tmp = thumbPath(fid) + '.tmp.jpg';
  await run(config.ffmpeg, ['-v', 'error', '-y', '-ss', String(at), '-i', f.path, '-frames:v', '1', '-vf', vf, '-q:v', '4', '-update', '1', tmp], 120000);
  fs.renameSync(tmp, thumbPath(fid));
}

let working = false;
const failed = new Set();
async function worker() {
  if (working) return;
  working = true;
  try {
    const jobs = [];
    for (const m of lib.movies) m.versions.forEach((v, i) => jobs.push([v.id, i === 0 ? 'wide' : null]));
    for (const s of lib.series) for (const se of s.seasons) for (const ep of se.episodes) jobs.push([ep.id, 'small']);
    let made = 0;
    for (const [fid, kind] of jobs) {
      if (!fileMap.has(fid) || failed.has(fid)) continue;
      try {
        await probe(fid);
        if (kind && !fs.existsSync(thumbPath(fid))) { await makeThumb(fid, kind === 'wide'); made++; }
      } catch (err) {
        failed.add(fid);
        console.log('ffmpeg non riesce con', path.basename(fileMap.get(fid).path), '-', err.message);
      }
    }
    if (made) console.log(`Anteprime create: ${made}`);
  } finally {
    working = false;
  }
}

// sottotitoli esterni: file .srt/.ass/.vtt accanto al video con lo stesso nome
function sidecars(fid) {
  const f = fileMap.get(fid);
  const dir = path.dirname(f.path), base = path.basename(noExt(f.path)).toLowerCase();
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  return names
    .filter(n => SUB_EXT.has(path.extname(n).toLowerCase()) && n.toLowerCase().startsWith(base))
    .sort()
    .map(n => {
      const extra = noExt(n).slice(base.length).replace(/^[.\s_-]+/, '');
      return { path: path.join(dir, n), lang: (extra.match(/^[a-z]{2,3}\b/i) || [''])[0].toLowerCase(), title: extra || 'Esterni', forced: /forced|forzat/i.test(extra) };
    });
}
const subPath = (fid, key) => path.join(SUBS, `${fid}_${key}.vtt`);
const extracting = new Map();
function extractInternal(fid) {
  if (extracting.has(fid)) return extracting.get(fid);
  const job = (async () => {
    const f = fileMap.get(fid), info = await probe(fid);
    const todo = info.subs.filter(s => s.text && !fs.existsSync(subPath(fid, 'i' + s.n)));
    if (!todo.length) return;
    // una sola lettura del file per estrarre tutte le tracce di testo
    const args = ['-v', 'error', '-y', '-i', f.path];
    for (const s of todo) args.push('-map', `0:s:${s.n}`, '-c:s', 'webvtt', '-f', 'webvtt', subPath(fid, 'i' + s.n) + '.tmp');
    await run(config.ffmpeg, args, 30 * 60000);
    for (const s of todo) fs.renameSync(subPath(fid, 'i' + s.n) + '.tmp', subPath(fid, 'i' + s.n));
  })().finally(() => extracting.delete(fid));
  extracting.set(fid, job);
  return job;
}
async function subtitleFile(fid, key) {
  const out = subPath(fid, key);
  if (fs.existsSync(out)) return out;
  if (key[0] === 'i') {
    await extractInternal(fid);
  } else {
    const sc = sidecars(fid)[+key.slice(1)];
    if (!sc) return null;
    await run(config.ffmpeg, ['-v', 'error', '-y', '-i', sc.path, '-f', 'webvtt', out + '.tmp'], 60000);
    fs.renameSync(out + '.tmp', out);
  }
  return fs.existsSync(out) ? out : null;
}
async function subtitleList(fid) {
  const info = await probe(fid);
  const internal = info.subs.filter(s => s.text).map(s => ({ key: 'i' + s.n, lang: s.lang, title: s.title, forced: s.forced }));
  const external = sidecars(fid).map((s, i) => ({ key: 'x' + i, lang: s.lang, title: s.title, forced: s.forced }));
  const imageOnly = info.subs.filter(s => !s.text).length;
  return { subs: internal.concat(external), audio: info.audio, imageOnly, video: info.video, dur: info.dur };
}

// ---------- conversione al volo ----------
// Per i dispositivi che non decodificano il file originale (HEVC a 10 bit, 4K): H.264 1080p + AAC stereo a partire da `t` secondi.
// Il flusso non si può scorrere: per saltare a un altro punto il client richiede di nuovo con un altro `t`.
// I tempi restano quelli del file originale (-copyts), così sottotitoli e posizione combaciano.
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
let encoder = ['libx264', '-preset', 'veryfast', '-crf', '22'];
// La scheda video converte molto più in fretta del processore: la uso se c'è.
run(config.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], 20000)
  .then(() => { encoder = ['h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0']; }, () => {});

async function transcode(req, res, fid, t) {
  const f = fileMap.get(fid), info = f && await probe(fid);
  if (!info || !info.video) return end(res, 404);
  res.writeHead(200, { 'Content-Type': 'video/x-matroska', 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  const ff = spawn(config.ffmpeg, [
    '-v', 'error', '-ss', String(t), '-copyts', '-i', f.path,
    '-map', '0:v:0', '-map', '0:a?', '-sn',
    '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2," + (info.hdr ? TONEMAP : 'format=yuv420p'),
    '-c:v', ...encoder, '-maxrate', '8M', '-bufsize', '16M', '-g', '48',
    '-c:a', 'aac', '-ac', '2', '-b:a', '160k',
    '-f', 'matroska', 'pipe:1',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ff.stderr.on('data', d => { err = (err + d).slice(-500); });
  ff.on('error', e => { console.error('Conversione non avviata:', e.message); res.destroy(); });
  ff.on('close', code => { if (code && !res.destroyed) console.error('Conversione interrotta:', err.trim()); res.end(); });
  // il client ha chiuso o è saltato altrove. SIGKILL: su Linux ffmpeg fermo a scrivere sulla pipe piena ignora SIGTERM e resta acceso
  res.on('close', () => ff.kill('SIGKILL'));
  ff.stdout.pipe(res);
}

// ---------- copertine e trame da TMDB (facoltativo) ----------
const TIMG = 'https://image.tmdb.org/t/p/';
let enriching = false;
async function tmdb(p, params = {}) {
  const url = new URL('https://api.themoviedb.org/3' + p);
  url.searchParams.set('language', 'it-IT');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = { accept: 'application/json' };
  if (config.tmdbKey.length > 40) headers.authorization = 'Bearer ' + config.tmdbKey;
  else url.searchParams.set('api_key', config.tmdbKey);
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error('TMDB ' + r.status + ' ' + p);
  return r.json();
}
const yearOf = d => (d ? +d.slice(0, 4) || null : null);
const round1 = n => (n ? Math.round(n * 10) / 10 : null);

const SEASON_V = 2; // stagioni: da aumentare quando cambia il modo di leggerle (2 = titoli inglesi di ripiego)
const META_V = 4; // da aumentare quando cambia il modo di cercare: rifà le ricerche una volta
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, ' ').trim();
async function tmdbMovie(title, year) {
  // in config.titles si può mettere direttamente il numero TMDB del film
  if (typeof title === 'number') return tmdbMovieDetails({ id: title });
  // titoli con un numero ("Pirati dei Caraibi 1 La maledizione...") si cercano anche senza e con la sola parte dopo
  const queries = [title];
  const m = title.match(/^(.*?)\s\d\s(.+)$/);
  if (m) queries.push(m[1] + ' ' + m[2], m[2]);
  // il migliore: titolo che inizia come quello del file, anno vicino, con copertina, più popolare
  let hit = null;
  for (const query of queries) {
    const q = norm(query);
    const score = r => {
      const y = yearOf(r.release_date);
      return (r.popularity || 0.1)
        * (norm(r.title).startsWith(q) || norm(r.original_title).startsWith(q) ? 5 : 1)
        * (year && y ? (y === year ? 20 : Math.abs(y - year) <= 1 ? 10 : 1) : 1)
        * (r.poster_path ? 1 : 0.1);
    };
    const searches = year ? [{ query, primary_release_year: year }, { query, year }] : [{ query }];
    let results = [];
    for (const params of searches) results = results.concat((await tmdb('/search/movie', params)).results);
    if (!results.length && year) results = (await tmdb('/search/movie', { query })).results;
    if (results.length) { hit = results.reduce((a, b) => (score(b) > score(a) ? b : a)); break; }
  }
  if (!hit) return { none: true, t: Date.now(), v: META_V };
  return tmdbMovieDetails(hit);
}
async function tmdbMovieDetails(hit) {
  const d = await tmdb('/movie/' + hit.id);
  const overview = d.overview || (await tmdb('/movie/' + hit.id, { language: 'en-US' })).overview;
  return {
    v: META_V, tmdbId: hit.id, title: d.title, year: yearOf(d.release_date), overview, runtime: d.runtime || null,
    genres: d.genres.map(g => g.name), rating: round1(d.vote_average),
    poster: d.poster_path && TIMG + 'w342' + d.poster_path, backdrop: d.backdrop_path && TIMG + 'w1280' + d.backdrop_path,
  };
}
async function tmdbTv(title) {
  const r = await tmdb('/search/tv', { query: title });
  const hit = r.results[0];
  if (!hit) return { none: true, t: Date.now() };
  const d = await tmdb('/tv/' + hit.id);
  return {
    tmdbId: hit.id, title: d.name, year: yearOf(d.first_air_date), overview: d.overview,
    genres: d.genres.map(g => g.name), rating: round1(d.vote_average),
    poster: d.poster_path && TIMG + 'w342' + d.poster_path, backdrop: d.backdrop_path && TIMG + 'w1280' + d.backdrop_path,
  };
}
async function tmdbSeason(tvId, n) {
  try {
    const d = await tmdb(`/tv/${tvId}/season/${n}`);
    const eps = {};
    // Titoli senza traduzione italiana ("Episodio 3"): uso quelli inglesi, se ci sono
    const generic = n => !n || /^(episodio|episode)\s+\d+$/i.test(n.trim());
    let en = {};
    if (d.episodes.some(e => generic(e.name))) {
      try { for (const e of (await tmdb(`/tv/${tvId}/season/${n}`, { language: 'en-US' })).episodes) en[e.episode_number] = e; } catch {}
    }
    for (const e of d.episodes) {
      const alt = en[e.episode_number] || {};
      eps[e.episode_number] = {
        name: generic(e.name) && !generic(alt.name) ? alt.name : e.name,
        overview: e.overview || alt.overview, runtime: e.runtime, still: e.still_path && TIMG + 'w500' + e.still_path,
      };
    }
    return { eps, v: SEASON_V };
  } catch (err) {
    if (/ 404 /.test(err.message)) return { eps: {}, v: SEASON_V };
    throw err;
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function enrich() {
  if (!config.tmdbKey || enriching) return;
  enriching = true;
  const stale = v => !v || (v.none && Date.now() - v.t > 7 * 864e5);
  try {
    for (const m of lib.movies) {
      if (!stale(meta[m.metaKey]) && meta[m.metaKey].v === META_V) continue;
      meta[m.metaKey] = await tmdbMovie((config.titles || {})[m.title] || m.title, m.year); save('meta.json'); await sleep(100);
    }
    for (const s of lib.series) {
      if (stale(meta[s.metaKey])) { meta[s.metaKey] = await tmdbTv(s.title); save('meta.json'); }
      const t = meta[s.metaKey];
      if (!t || t.none) continue;
      for (const se of s.seasons) {
        const k = `season:${t.tmdbId}:${se.n}`;
        if (!meta[k] || meta[k].v !== SEASON_V) { meta[k] = await tmdbSeason(t.tmdbId, se.n); save('meta.json'); await sleep(100); }
      }
    }
  } catch (err) {
    console.log('TMDB non disponibile:', err.message);
  } finally {
    enriching = false;
  }
}

function mergeMovie(m) {
  const t = meta[m.metaKey];
  const out = { ...m, frame: m.versions.map(v => thumbUrl(v.id)).find(Boolean) || null };
  delete out.metaKey;
  if (!t || t.none) return out;
  return { ...out, tmdbId: t.tmdbId, title: t.title || m.title, year: t.year || m.year, overview: t.overview, runtime: t.runtime, genres: t.genres, rating: t.rating, poster: m.poster || t.poster, backdrop: t.backdrop };
}
function mergeSeries(s) {
  const t = meta[s.metaKey];
  const out = { ...s };
  delete out.metaKey;
  const tmdbId = t && !t.none ? t.tmdbId : null;
  out.seasons = s.seasons.map(se => {
    const eps = (tmdbId && (meta[`season:${tmdbId}:${se.n}`] || {}).eps) || {};
    return {
      ...se,
      episodes: se.episodes.map(ep => {
        const x = eps[ep.e] || {};
        return { ...ep, title: x.name || ep.title, overview: x.overview, runtime: x.runtime, still: ep.still || x.still || null, frame: thumbUrl(ep.id) };
      }),
    };
  });
  const firstFrame = out.seasons[0].episodes.map(e => e.frame).find(Boolean) || null;
  out.frame = firstFrame;
  if (!tmdbId) return out;
  return { ...out, tmdbId, title: t.title || s.title, year: t.year, overview: t.overview, genres: t.genres, rating: t.rating, poster: s.poster || t.poster, backdrop: t.backdrop };
}

let scanning = null;
function rescan() {
  scanning = scan().then(() => { enrich(); worker(); }).catch(err => console.error('Scansione fallita:', err));
  return scanning;
}

// ---------- HTTP ----------
function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function end(res, code) { res.writeHead(code); res.end(); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e4) { reject(new Error('body troppo grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  });
}

function sendFile(req, res, file, cache) {
  if (!file) return end(res, 404);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return end(res, 404);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0, last = st.size - 1, code = 200;
    if (m) {
      if (m[1] === '') start = Math.max(0, st.size - (+m[2] || 0));
      else { start = +m[1]; if (m[2]) last = Math.min(+m[2], st.size - 1); }
      if (start >= st.size || start > last) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      code = 206;
    }
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': last - start + 1, 'Cache-Control': cache || 'no-cache' };
    if (code === 206) headers['Content-Range'] = `bytes ${start}-${last}/${st.size}`;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') return res.end();
    const s = fs.createReadStream(file, { start, end: last, highWaterMark: 1 << 20 });
    s.on('error', () => res.destroy());
    res.on('close', () => s.destroy());
    s.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      return end(res, 204);
    }
    if (p === '/api/ping') return json(res, { ok: true });
    if (p.startsWith('/api/dl/')) {
      const sp = new URL(req.url, 'http://x').searchParams;
      const kind = sp.get('kind') === 'series' ? 'series' : 'movie';
      try {
        if (p === '/api/dl/search') return json(res, await downloads.search((sp.get('q') || '').trim(), kind));
        if (p === '/api/dl/queue') return json(res, await downloads.queue());
        if (p === '/api/dl/cancel' && req.method === 'POST') { const b = await readBody(req); return json(res, await downloads.cancel(b.kind === 'series' ? 'series' : 'movie', b.id)); }
        if (p === '/api/dl/add' && req.method === 'POST') { const b = await readBody(req); return json(res, await downloads.add(b.kind === 'series' ? 'series' : 'movie', b.key)); }
      } catch (e) { return json(res, { error: e.message }, 502); }
      return end(res, 404);
    }
    if (p === '/api/library') {
      await scanning;
      return json(res, { movies: lib.movies.map(mergeMovie), series: lib.series.map(mergeSeries), scannedAt: lib.scannedAt, enriching, processing: working });
    }
    if (p === '/api/progress' && req.method === 'POST') {
      const b = await readBody(req);
      if (!fileMap.has(b.id)) return json(res, { error: 'file sconosciuto' }, 404);
      const cur = progress[b.id] || {};
      if (typeof b.watched === 'boolean') {
        progress[b.id] = { pos: 0, dur: cur.dur || 0, t: Date.now(), w: b.watched };
      } else {
        const done = b.dur > 0 && b.pos / b.dur > 0.92;
        progress[b.id] = { pos: done ? 0 : Math.round(b.pos), dur: Math.round(b.dur) || cur.dur || 0, t: Date.now(), w: done || !!cur.w };
      }
      save('progress.json');
      return json(res, progress[b.id]);
    }
    if (p === '/api/delete' && req.method === 'POST') {
      const b = await readBody(req);
      try { await removeItem(String(b.id)); return json(res, { ok: true }); } catch (e) { return json(res, { error: e.message }, 400); }
    }
    if (p === '/api/progress') return json(res, progress);
    if (p === '/api/rescan') { await rescan(); return json(res, { ok: true }); }
    if (p.startsWith('/api/tracks/')) {
      const fid = p.slice(12);
      if (!fileMap.has(fid)) return end(res, 404);
      return json(res, await subtitleList(fid));
    }
    if (p.startsWith('/subs/')) {
      const [, , fid, name] = p.split('/');
      const key = (name || '').replace(/\.vtt$/, '');
      if (!fileMap.has(fid) || !/^[ix]\d+$/.test(key)) return end(res, 404);
      return sendFile(req, res, await subtitleFile(fid, key), 'max-age=86400');
    }
    if (p.startsWith('/transcode/')) return transcode(req, res, p.slice(11), Math.max(0, +new URL(req.url, 'http://x').searchParams.get('t') || 0));
    if (p.startsWith('/media/')) { const f = fileMap.get(p.slice(7)); return sendFile(req, res, f && f.path); }
    if (p.startsWith('/thumb/')) { const fid = p.slice(7); return sendFile(req, res, fileMap.has(fid) ? thumbPath(fid) : null, 'max-age=86400'); }
    if (p.startsWith('/img/')) return sendFile(req, res, imgMap.get(p.slice(5)), 'max-age=86400');
    const file = path.join(WEB, p === '/' ? 'index.html' : p);
    if (!file.startsWith(WEB + path.sep)) return end(res, 403);
    return sendFile(req, res, file);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) end(res, 500); else res.destroy();
  }
});

rescan();
setInterval(rescan, 10 * 60 * 1000);
server.listen(config.port, '0.0.0.0', () => {
  const ips = Object.values(require('os').networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('FrecklesNight attivo su:', ips.map(ip => `http://${ip}:${config.port}`).join('  '));
});
