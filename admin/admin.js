'use strict';
// Pannello di controllo di FrecklesNight: processo separato dal server video, così resta raggiungibile anche quando quello è fermo.
// Solo moduli integrati di Node. Non tiene timer né storico: legge lo stato soltanto quando la pagina lo chiede.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HOST = process.env.ADMIN_HOST || '127.0.0.1'; // 0.0.0.0 per aprirlo anche dagli altri dispositivi di casa
const PORT = +process.env.ADMIN_PORT || 8788;
const UNIT = 'frecklesnight.service';
const APP = path.join(__dirname, '..');

function appConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}
const sh = (bin, args, timeout = 5000) => new Promise(resolve => {
  execFile(bin, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? '' : stdout));
});
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// ---------- servizio ----------
async function service() {
  const out = await sh('systemctl', ['--user', 'show', UNIT, '-p', 'ActiveState,SubState,MainPID,MemoryCurrent,CPUUsageNSec,NRestarts,UnitFileState']);
  const p = Object.fromEntries(out.trim().split('\n').map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  const pid = +p.MainPID || 0;
  let since = 0;
  try { if (pid) since = fs.statSync('/proc/' + pid).ctimeMs; } catch {}
  return {
    state: p.ActiveState || 'unknown', sub: p.SubState || '', pid, since,
    mem: +p.MemoryCurrent || 0, cpuNs: +p.CPUUsageNSec || 0, restarts: +p.NRestarts || 0, enabled: p.UnitFileState === 'enabled',
  };
}

// ---------- sistema ----------
function system(cfg) {
  const cpu = read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const mi = Object.fromEntries(read('/proc/meminfo').split('\n').filter(Boolean).map(l => { const m = l.match(/^(\w+):\s+(\d+)/); return m ? [m[1], +m[2] * 1024] : ['', 0]; }));
  let temp = null;
  try {
    for (const h of fs.readdirSync('/sys/class/hwmon')) {
      const d = '/sys/class/hwmon/' + h;
      if (read(d + '/name').trim() !== 'coretemp') continue;
      const t = fs.readdirSync(d).filter(n => /^temp\d+_input$/.test(n)).map(n => +read(d + '/' + n) / 1000);
      if (t.length) temp = Math.round(Math.max(...t));
    }
  } catch {}
  const disks = [];
  // una riga per disco: più cartelle sullo stesso disco contano una volta sola
  const add = (label, p) => {
    let dir = p;
    while (dir !== '/' && !fs.existsSync(dir)) dir = path.dirname(dir); // cartella non ancora creata: guardo il disco che la conterrà
    if (dir === '/' && p !== '/') return disks.push({ label, path: p, missing: true });
    try {
      const s = fs.statfsSync(dir), total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      if (total && !disks.some(d => d.total === total && d.free === free)) disks.push({ label, path: p, total, free });
    } catch { disks.push({ label, path: p, missing: true }); }
  };
  add('Sistema', '/');
  for (const p of [...(cfg.movies || []), ...(cfg.series || [])]) add('Disco video ' + disks.length, p);
  let rx = 0, tx = 0;
  for (const l of read('/proc/net/dev').split('\n').slice(2)) {
    const m = l.trim().split(/[:\s]+/);
    if (m.length < 10 || m[0] === 'lo') continue;
    rx += +m[1]; tx += +m[9];
  }
  return {
    host: os.hostname(), uptime: os.uptime(), load: os.loadavg()[0], cores: os.cpus().length,
    cpu: { idle: cpu[3] + (cpu[4] || 0), total: cpu.reduce((a, b) => a + b, 0) },
    mem: { total: mi.MemTotal || 0, avail: mi.MemAvailable || 0 },
    temp, disks, net: { rx, tx },
  };
}

// ---------- chi è collegato e cosa sta guardando ----------
async function connections(port) {
  const out = await sh('ss', ['-Htni', 'state', 'established', '( sport = :' + port + ' )']);
  const conns = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      const peer = line.trim().split(/\s+/).pop();
      const i = peer.lastIndexOf(':');
      cur = { ip: peer.slice(0, i).replace(/^\[?(::ffff:)?|\]$/g, ''), port: peer.slice(i + 1), sent: 0 };
      if (cur.ip !== '127.0.0.1' && cur.ip !== '::1') conns.push(cur); // esclude i controlli di questo pannello
    } else if (cur) {
      const m = line.match(/bytes_acked:(\d+)/);
      if (m) cur.sent = +m[1];
    }
  }
  return conns;
}
function activity(pid, cfg) {
  const roots = [...(cfg.movies || []), ...(cfg.series || [])];
  const playing = new Set(), jobs = [];
  if (!pid) return { playing: [], jobs };
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      try {
        const t = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (roots.some(r => t.startsWith(r + '/'))) playing.add(path.basename(t));
      } catch {}
    }
  } catch {}
  for (const c of read(`/proc/${pid}/task/${pid}/children`).trim().split(/\s+/).filter(Boolean)) {
    const args = read(`/proc/${c}/cmdline`).split('\0');
    if (!/ffmpeg|ffprobe/.test(path.basename(args[0] || ''))) continue;
    const i = args.indexOf('-i'), ss = args.indexOf('-ss');
    jobs.push({
      kind: args.includes('pipe:1') ? 'Conversione' : /ffprobe/.test(args[0]) ? 'Analisi' : args.includes('webvtt') ? 'Sottotitoli' : 'Anteprima',
      file: path.basename(i >= 0 ? args[i + 1] : args[args.length - 2] || ''), from: ss >= 0 ? +args[ss + 1] : 0,
    });
  }
  return { playing: [...playing], jobs };
}

// ---------- il server video risponde? ----------
function appGet(port, p, timeout) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, ms: Date.now() - t0, body: b }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false }));
  });
}
let libCache = null; // la libreria pesa: basta rileggerla ogni mezzo minuto
async function library(port) {
  if (libCache && Date.now() - libCache.t < 30000) return libCache.v;
  const r = await appGet(port, '/api/library', 20000);
  if (!r.ok) return null;
  try {
    const l = JSON.parse(r.body);
    const v = {
      movies: l.movies.length, series: l.series.length,
      episodes: l.series.reduce((n, s) => n + s.seasons.reduce((k, se) => k + se.episodes.length, 0), 0),
      scannedAt: l.scannedAt, enriching: l.enriching, processing: l.processing,
    };
    libCache = { t: Date.now(), v };
    return v;
  } catch { return null; }
}

async function stats() {
  const cfg = appConfig(), port = cfg.port || 8787;
  const [svc, conns, ping] = await Promise.all([service(), connections(port), appGet(port, '/api/ping', 1500)]);
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal);
  return {
    t: Date.now(), port, url: `http://${lan ? lan.address : 'localhost'}:${port}`,
    service: svc, ping: ping.ok ? ping.ms : null,
    system: system(cfg), conns, ...activity(svc.pid, cfg),
    library: ping.ok ? await library(port) : null,
  };
}

// ---------- HTTP ----------
function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const ACTIONS = { start: ['start'], stop: ['stop'], restart: ['restart'] };

http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    // aperto solo su questo PC: rifiuta le pagine di altri siti che provano a chiamarlo dal browser
    if (HOST === '127.0.0.1' && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); return res.end(); }
    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    if (p === '/icon.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(path.join(APP, 'webos', 'icon.png')).pipe(res);
    }
    if (p === '/api/stats') return json(res, await stats());
    if (p === '/api/log') {
      const out = await sh('journalctl', ['--user', '-u', UNIT, '-n', '120', '--no-pager', '-o', 'short-iso']);
      return json(res, { lines: out.trim().split('\n').filter(Boolean) });
    }
    if (p.startsWith('/api/do/') && req.method === 'POST') {
      if (req.headers['x-freckles'] !== '1') return json(res, { error: 'richiesta non valida' }, 403);
      const a = p.slice(8), port = appConfig().port || 8787;
      libCache = null;
      if (ACTIONS[a]) { await sh('systemctl', ['--user', ...ACTIONS[a], UNIT], 20000); return json(res, { ok: true }); }
      if (a === 'rescan') { const r = await appGet(port, '/api/rescan', 120000); return json(res, { ok: r.ok }, r.ok ? 200 : 502); }
      return json(res, { error: 'azione sconosciuta' }, 404);
    }
    res.writeHead(404); res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, { error: err.message }, 500); else res.destroy();
  }
}).listen(PORT, HOST, () => console.log(`Pannello FrecklesNight su http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
