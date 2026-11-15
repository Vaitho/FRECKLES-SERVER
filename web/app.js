'use strict';
// FrecklesNight: interfaccia per TV, si usa col telecomando (frecce, OK, Indietro) o col puntatore.

const app = document.getElementById('app');
const S = { lib: null, prog: {}, stack: [], screen: null, player: null, pref: {}, season: {}, feat: null, lastBack: 0 };

// ---------- utilità ----------
const $ = sel => app.querySelector(sel);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = (p, body) => fetch(p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
const pad2 = n => String(n).padStart(2, '0');
const fmt = sec => { sec = Math.max(0, Math.floor(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return (h ? h + ':' + pad2(m) : m) + ':' + pad2(sec % 60); };
const fmtMin = min => { min = Math.round(min); return min >= 60 ? Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + (min % 60) + ' min' : '') : min + ' min'; };
const clock = d => pad2(d.getHours()) + ':' + pad2(d.getMinutes());
const byTitle = list => list.slice().sort((a, b) => a.title.localeCompare(b.title, 'it'));
const hue = s => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
// url = immagine vera (copertina, still); frame = fotogramma estratto dal video, con il titolo sopra
function art(title, url, cls, frame, label) {
  if (url) return `<div class="${cls}" style="background-image:url('${esc(url)}')"></div>`;
  const text = label == null ? title : label;
  if (frame) return `<div class="${cls} framed" style="background-image:url('${esc(frame)}')">${text ? `<span>${esc(text)}</span>` : ''}</div>`;
  const h = hue(title);
  return `<div class="${cls} gen" style="--h:${h};--h2:${(h + 40) % 360}"><span>${esc(text)}</span></div>`;
}
function bg(item) {
  const img = item.backdrop || item.frame;
  if (img) return `<div class="bg" style="background-image:url('${esc(img)}')"></div>`;
  return `<div class="bg gen" style="--h:${hue(item.title)}"></div>`;
}
let toastTimer;
function toast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function hideToast() { clearTimeout(toastTimer); document.getElementById('toast').classList.remove('show'); }
const LANG = {
  it: 'Italiano', ita: 'Italiano', en: 'Inglese', eng: 'Inglese', ja: 'Giapponese', jpn: 'Giapponese', jap: 'Giapponese',
  fr: 'Francese', fra: 'Francese', fre: 'Francese', es: 'Spagnolo', spa: 'Spagnolo', de: 'Tedesco', ger: 'Tedesco', deu: 'Tedesco',
  pt: 'Portoghese', por: 'Portoghese', ru: 'Russo', rus: 'Russo', zh: 'Cinese', chi: 'Cinese', zho: 'Cinese', ko: 'Coreano', kor: 'Coreano',
  nl: 'Olandese', dut: 'Olandese', ar: 'Arabo', ara: 'Arabo', pl: 'Polacco', pol: 'Polacco', sv: 'Svedese', swe: 'Svedese',
};
const langName = code => LANG[(code || '').toLowerCase()] || (code && code !== 'und' ? code.toUpperCase() : '');
const isIta = code => /^it/i.test(code || '');

// ---------- dati ----------
async function load() {
  const [lib, prog] = await Promise.all([api('/api/library'), api('/api/progress')]);
  S.lib = lib; S.prog = prog;
  S.byId = new Map(); S.fileCtx = new Map();
  for (const m of lib.movies) {
    m.kind = 'movie'; S.byId.set(m.id, m);
    for (const v of m.versions) S.fileCtx.set(v.id, { item: m, version: v });
  }
  for (const s of lib.series) {
    s.kind = 'series'; s.flat = []; S.byId.set(s.id, s);
    for (const se of s.seasons) for (const ep of se.episodes) { ep.season = se.n; s.flat.push(ep); S.fileCtx.set(ep.id, { item: s, ep }); }
  }
  // mentre il server scarica copertine e trame, ricarica ogni tanto
  if (lib.enriching || lib.processing) setTimeout(softReload, 20000);
}
async function softReload() {
  try { await load(); } catch { return; }
  if (!S.player && S.screen && S.screen.name !== 'player') rerender();
}

const P = id => S.prog[id];
const resumable = id => { const p = P(id); return !!p && p.pos > 30 && (!p.dur || p.pos < p.dur * 0.92); };
const watched = id => !!(P(id) && P(id).w);
function chosenVersion(m) {
  return m.versions.find(v => v.id === S.pref[m.id]) || m.versions.find(v => resumable(v.id)) || m.versions[0];
}
function seriesTarget(s) {
  let last = null;
  for (const ep of s.flat) { const p = P(ep.id); if (p && (!last || p.t > P(last.id).t)) last = ep; }
  if (!last) return { ep: s.flat[0], pos: 0, fresh: true };
  if (resumable(last.id)) return { ep: last, pos: P(last.id).pos, resume: true };
  if (watched(last.id)) {
    const nx = s.flat[s.flat.indexOf(last) + 1];
    return nx ? { ep: nx, pos: 0, next: true } : { ep: s.flat[0], pos: 0, done: true };
  }
  return { ep: last, pos: 0 };
}
function isWatched(it) {
  return it.kind === 'movie' ? it.versions.some(v => watched(v.id)) : it.flat.every(e => watched(e.id));
}
function pctOf(it) {
  if (it.kind !== 'movie') return 0;
  const v = it.versions.find(x => resumable(x.id));
  return v && P(v.id).dur ? P(v.id).pos / P(v.id).dur * 100 : 0;
}
function continueItems() {
  const out = [];
  for (const m of S.lib.movies) {
    const v = m.versions.find(x => resumable(x.id));
    if (v) out.push({ item: m, file: v.id, pos: P(v.id).pos, dur: P(v.id).dur, t: P(v.id).t });
  }
  for (const s of S.lib.series) {
    const tg = seriesTarget(s);
    if (tg.fresh || tg.done) continue;
    const t = Math.max.apply(null, s.flat.map(e => (P(e.id) ? P(e.id).t : 0)));
    const p = P(tg.ep.id);
    out.push({ item: s, ep: tg.ep, file: tg.ep.id, pos: tg.pos, dur: p ? p.dur : 0, t, next: tg.next });
  }
  return out.sort((a, b) => b.t - a.t);
}
const epLabel = ep => `S${ep.season} E${ep.e}`;

// ---------- focus e navigazione col telecomando ----------
let focused = null;
function focus(el, scroll = true) {
  if (!el) return;
  if (focused) focused.classList.remove('on');
  focused = el; el.classList.add('on');
  S.focusKey = el.dataset.key;
  const row = el.closest('[data-row]');
  if (row) row._last = el.dataset.key;
  if (el.dataset.ep) showEpInfo(el.dataset.arg);
  if (scroll) scrollToEl(el);
}
function showEpInfo(file) {
  const box = document.getElementById('epinfo');
  const ctx = S.fileCtx.get(file);
  if (!box || !ctx || !ctx.ep) return;
  const ep = ctx.ep, p = P(ep.id);
  const bits = [epLabel(ep)];
  if (ep.runtime) bits.push(fmtMin(ep.runtime));
  if (watched(ep.id)) bits.push('Visto');
  else if (resumable(ep.id)) bits.push('Riprendi da ' + fmt(p.pos));
  box.innerHTML = `<b>${esc(ep.title || 'Episodio ' + ep.e)}</b><div class="meta">${esc(bits.join(' · '))}</div>${ep.overview ? `<p>${esc(ep.overview)}</p>` : ''}`;
}
function scrollToEl(el) {
  const track = el.closest('.track');
  if (track) {
    const padL = parseFloat(getComputedStyle(track).paddingLeft);
    const left = el.offsetLeft, right = left + el.offsetWidth;
    let x = track.scrollLeft;
    if (left - padL < x) x = left - padL;
    else if (right + padL > x + track.clientWidth) x = right + padL - track.clientWidth;
    if (x !== track.scrollLeft) track.scrollTo({ left: x, behavior: 'smooth' });
  }
  const scr = el.closest('.screen');
  if (!scr) return;
  if (el.dataset.top != null) return scr.scrollTo({ top: 0, behavior: 'smooth' });
  const box = (el.closest('.row') || el).getBoundingClientRect();
  const view = scr.getBoundingClientRect();
  const margin = view.height * 0.12;
  if (box.top < view.top + margin) scr.scrollBy({ top: box.top - view.top - margin, behavior: 'smooth' });
  else if (box.bottom > view.bottom - margin) scr.scrollBy({ top: box.bottom - view.bottom + margin, behavior: 'smooth' });
}
function move(dir) {
  const all = Array.prototype.filter.call(app.querySelectorAll('.f'), e => e.offsetParent !== null);
  if (!focused || !document.body.contains(focused)) return focus(all[0]);
  const c = focused.getBoundingClientRect();
  let best = null, score = Infinity;
  for (const el of all) {
    if (el === focused) continue;
    const r = el.getBoundingClientRect();
    let main, cross;
    if (dir === 'left' || dir === 'right') {
      if (r.bottom <= c.top + 2 || r.top >= c.bottom - 2) continue; // solo sulla stessa riga
      main = dir === 'left' ? c.left - r.right : r.left - c.right;
      cross = Math.abs((r.top + r.bottom) / 2 - (c.top + c.bottom) / 2);
    } else {
      main = dir === 'up' ? c.top - r.bottom : r.top - c.bottom;
      cross = Math.max(0, r.left - c.right, c.left - r.right);
    }
    if (main < -4) continue;
    const sc = main + cross * 4;
    if (sc < score) { score = sc; best = el; }
  }
  if (!best) return;
  if (dir === 'up' || dir === 'down') {
    // tornando su una riga, riprende dalla card dove eri rimasto
    const row = best.closest('[data-row]');
    if (row && row !== focused.closest('[data-row]') && row._last) {
      const prev = row.querySelector(`[data-key="${CSS.escape(row._last)}"]`);
      if (prev) best = prev;
    }
  }
  focus(best);
}
app.addEventListener('mouseover', e => { const el = e.target.closest('.f'); if (el && el !== focused) focus(el, false); });
app.addEventListener('click', e => { const el = e.target.closest('.f'); if (el) activate(el); });

// ---------- schermate ----------
function scrollerTop() { const s = $('.screen'); return s ? s.scrollTop : 0; }
function pushCurrent() {
  if (S.screen && S.screen.name !== 'player') S.stack.push({ name: S.screen.name, params: S.screen.params, key: S.focusKey, scroll: scrollerTop() });
}
function go(name, params) { pushCurrent(); show(name, params); }
function show(name, params = {}, key, scroll) {
  S.screen = { name, params };
  focused = null;
  app.innerHTML = SCREENS[name](params);
  const scr = $('.screen');
  if (scr && scroll) scr.scrollTop = scroll;
  const el = (key && app.querySelector(`[data-key="${CSS.escape(key)}"]`)) || app.querySelector('[data-default]') || app.querySelector('.f');
  focus(el, !scroll);
  if (el && scroll) { const t = el.closest('.track'); if (t) scrollToEl(el); }
}
function rerender(key) { show(S.screen.name, S.screen.params, key || S.focusKey, scrollerTop()); }
function back() {
  const prev = S.stack.pop();
  if (prev) return show(prev.name, prev.params, prev.key, prev.scroll);
  if (S.screen.name !== 'home') return show('home');
  if (Date.now() - S.lastBack < 2000) return window.close();
  S.lastBack = Date.now();
  toast('Premi di nuovo Indietro per uscire');
}

function nav(cur) {
  const b = (k, label, extra = '') => `<div class="navb f${cur === k ? ' cur' : ''}${extra}" data-key="nav:${k}" data-act="nav" data-arg="${k}" data-top>${label}</div>`;
  return `<nav class="top"><div class="logo">Freckles<span>Night</span></div>${b('home', 'Home')}${b('movies', 'Film')}${b('series', 'Serie TV')}${b('dl', 'Scarica')}${b('rescan', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Aggiorna', ' end')}</nav>`;
}
function row(title, cards, key) {
  return cards ? `<section class="row" data-row="${key}"><h2>${esc(title)}</h2><div class="track">${cards}</div></section>` : '';
}
function posterCard(it, rk) {
  const pct = pctOf(it);
  return `<div class="card f" data-key="${rk}:${it.id}" data-act="detail" data-arg="${it.id}">
    ${art(it.title, it.poster, 'poster', it.frame)}
    ${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    ${isWatched(it) ? '<div class="ok">✓</div>' : ''}
    ${it.poster ? `<div class="cap">${esc(it.title)}</div>` : ''}
  </div>`;
}
function contCard(c) {
  const it = c.item;
  const sub = c.ep ? (c.next ? 'Prossimo: ' : '') + epLabel(c.ep) + (c.ep.title ? ' · ' + c.ep.title : '') : (c.dur ? 'Mancano ' + fmtMin((c.dur - c.pos) / 60) : '');
  const pct = c.dur ? Math.min(100, c.pos / c.dur * 100) : 0;
  return `<div class="card wide f" data-key="c:${it.id}" data-act="play" data-arg="${c.file}" data-pos="${c.pos}">
    ${c.ep ? art(it.title, c.ep.still, 'thumb', c.ep.frame || it.frame, '') : art(it.title, it.backdrop, 'thumb', it.frame, '')}
    ${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
    <div class="cap"><b>${esc(it.title)}</b>${esc(sub)}</div>
  </div>`;
}
function metaLine(it, quality) {
  const parts = [];
  if (it.year) parts.push(`<span>${it.year}</span>`);
  if (it.kind === 'series') parts.push(`<span>${it.seasons.length} stagion${it.seasons.length === 1 ? 'e' : 'i'} · ${it.flat.length} episodi</span>`);
  if (it.runtime) parts.push(`<span>${fmtMin(it.runtime)}</span>`);
  if (quality) parts.push(`<span class="q">${esc(quality)}</span>`);
  if (it.rating) parts.push(`<span class="star">★ ${it.rating}</span>`);
  return `<div class="meta">${parts.join('')}</div>`;
}
function playLabel(it) {
  if (it.kind === 'movie') {
    const v = chosenVersion(it);
    return resumable(v.id) ? { text: 'Riprendi da ' + fmt(P(v.id).pos), file: v.id, pos: P(v.id).pos } : { text: 'Riproduci', file: v.id, pos: 0 };
  }
  const tg = seriesTarget(it);
  const what = epLabel(tg.ep);
  const text = tg.resume ? `Riprendi ${what}` : tg.next ? `Prossimo: ${what}` : tg.done ? 'Riguarda da capo' : `Riproduci ${what}`;
  return { text, file: tg.ep.id, pos: tg.pos };
}

const SCREENS = {};

SCREENS.home = () => {
  const lib = S.lib;
  if (!lib.movies.length && !lib.series.length) {
    return `<div class="screen">${nav('home')}<div class="splash"><p>Non ho trovato video.<br>Controlla le cartelle in config.json sul PC e premi Aggiorna.</p></div></div>`;
  }
  const cont = continueItems();
  const all = lib.movies.concat(lib.series);
  if (!S.feat || !S.byId.has(S.feat)) {
    const pool = all.filter(i => i.backdrop);
    S.feat = (pool.length ? pool : all)[Math.floor(Math.random() * (pool.length || all.length))].id;
  }
  const feat = cont.length ? cont[0].item : S.byId.get(S.feat);
  const pl = playLabel(feat);
  const quality = feat.kind === 'movie' ? chosenVersion(feat).label : '';
  const recent = all.slice().sort((a, b) => b.added - a.added).slice(0, 20);
  const uhd = lib.movies.filter(m => m.versions.some(v => /4K/.test(v.label)));
  return `<div class="screen home">
    ${nav('home')}
    <div class="hero">${bg(feat)}<div class="shade"></div>
      <div class="info">
        <div class="kicker">${cont.length ? 'Continua a guardare' : feat.kind === 'series' ? 'Serie TV' : 'Film'}</div>
        <h1 class="title">${esc(feat.title)}</h1>
        ${metaLine(feat, quality)}
        ${feat.overview ? `<p class="ov">${esc(feat.overview)}</p>` : ''}
        <div class="actions">
          <div class="btn primary f" data-key="hero:play" data-act="play" data-arg="${pl.file}" data-pos="${pl.pos}" data-default data-top>${esc(pl.text)}</div>
          <div class="btn f" data-key="hero:info" data-act="detail" data-arg="${feat.id}" data-top>Dettagli</div>
        </div>
      </div>
    </div>
    ${row('Continua a guardare', cont.map(contCard).join(''), 'cont')}
    ${row('Aggiunti di recente', recent.map(i => posterCard(i, 'r')).join(''), 'recent')}
    ${row('Serie TV', byTitle(lib.series).map(i => posterCard(i, 's')).join(''), 'series')}
    ${row('Film', byTitle(lib.movies).map(i => posterCard(i, 'm')).join(''), 'movies')}
    ${row('In 4K', byTitle(uhd).map(i => posterCard(i, 'k')).join(''), 'uhd')}
  </div>`;
};

SCREENS.grid = ({ kind }) => {
  const items = byTitle(kind === 'movies' ? S.lib.movies : S.lib.series);
  return `<div class="screen">${nav(kind)}
    <h1 class="page-title">${kind === 'movies' ? 'Film' : 'Serie TV'}<span>${items.length}</span></h1>
    <div class="grid">${items.map(i => posterCard(i, 'g')).join('')}</div>
  </div>`;
};

SCREENS.detail = ({ id }) => {
  const it = S.byId.get(id);
  if (!it) return `<div class="screen"><div class="splash"><p>Titolo non trovato.</p></div></div>`;
  const pl = playLabel(it);
  const head = (quality, extraButtons) => `${bg(it)}<div class="shade"></div>
    <div class="info">
      <div class="kicker">${it.kind === 'series' ? 'Serie TV' : 'Film'}</div>
      <h1 class="title">${esc(it.title)}</h1>
      ${metaLine(it, quality)}
      ${it.genres && it.genres.length ? `<div class="genres">${esc(it.genres.join(' · '))}</div>` : ''}
      ${it.overview ? `<p class="ov">${esc(it.overview)}</p>` : ''}
      <div class="actions">
        <div class="btn primary f" data-key="d:play" data-act="play" data-arg="${pl.file}" data-pos="${pl.pos}" data-default data-top>${esc(pl.text)}</div>
        ${extraButtons}
        <div class="btn danger f${S.confirmDel === it.id ? ' armed' : ''}" data-key="d:del" data-act="del" data-arg="${it.id}" data-top>${S.confirmDel === it.id ? 'Premi OK per confermare' : 'Elimina'}</div>
      </div>`;

  if (it.kind === 'movie') {
    const v = chosenVersion(it);
    const extra = (pl.pos ? `<div class="btn f" data-key="d:restart" data-act="play" data-arg="${v.id}" data-pos="0" data-top>Dall'inizio</div>` : '') +
      `<div class="btn f" data-key="d:watched" data-act="toggleWatched" data-arg="${it.id}" data-top>${isWatched(it) ? 'Visto' : 'Segna come visto'}</div>`;
    const versions = it.versions.length > 1
      ? `<div class="chips" data-row="ver"><span>Versione</span>${it.versions.map(x => `<div class="chip f${x.id === v.id ? ' sel' : ''}" data-key="v:${x.id}" data-act="version" data-arg="${it.id}|${x.id}" data-top>${esc(x.label)} · ${(x.size / 1e9).toFixed(1)} GB</div>`).join('')}</div>`
      : '';
    return `<div class="screen"><div class="detail">${head(v.label, extra)}${versions}</div></div></div>`;
  }

  const tg = seriesTarget(it);
  const cur = S.season[it.id] != null ? S.season[it.id] : tg.ep.season;
  const season = it.seasons.find(s => s.n === cur) || it.seasons[0];
  const seasons = it.seasons.length > 1
    ? `<div class="chips seasons" data-row="seasons">${it.seasons.map(s => `<div class="chip f${s.n === season.n ? ' sel' : ''}" data-key="s:${s.n}" data-act="season" data-arg="${it.id}|${s.n}">Stagione ${s.n}</div>`).join('')}</div>`
    : `<div class="chips seasons"><span>Stagione ${season.n}</span></div>`;
  const eps = season.episodes.map(ep => {
    const p = P(ep.id);
    const pct = resumable(ep.id) && p.dur ? p.pos / p.dur * 100 : 0;
    const sub = watched(ep.id) ? 'Visto' : ep.runtime ? fmtMin(ep.runtime) : '';
    return `<div class="card wide f" data-key="e:${ep.id}" data-act="play" data-arg="${ep.id}" data-ep="1" data-pos="${resumable(ep.id) ? p.pos : 0}">
      ${art('Episodio ' + ep.e, ep.still, 'thumb', ep.frame, '')}
      ${pct ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      ${watched(ep.id) ? '<div class="ok">✓</div>' : ''}
      <div class="cap"><b>${ep.e}. ${esc(ep.title || 'Episodio ' + ep.e)}</b>${esc(sub)}</div>
    </div>`;
  }).join('');
  return `<div class="screen"><div class="detail">${head('', '')}</div>${seasons}${row('Episodi', eps, 'eps')}<div id="epinfo"></div></div></div>`;
};

// ---------- azioni ----------
const ACTIONS = {
  nav(k) {
    if (k === 'rescan') return ACTIONS.rescan();
    S.stack = [];
    if (k === 'dl') return openDl();
    show(k === 'home' ? 'home' : 'grid', { kind: k });
  },
  async rescan() {
    toast('Aggiorno la libreria…', 10000);
    try { await api('/api/rescan'); await load(); rerender(); toast('Libreria aggiornata'); } catch { toast('Il PC non risponde'); }
  },
  detail(id) { go('detail', { id }); },
  async del(id) {
    if (S.confirmDel !== id) {
      S.confirmDel = id; rerender('d:del');
      clearTimeout(S.confirmT); S.confirmT = setTimeout(() => { if (S.confirmDel === id) { S.confirmDel = null; if (S.screen && S.screen.name === 'detail') rerender('d:del'); } }, 6000);
      return;
    }
    S.confirmDel = null; toast('Elimino dal PC…', 30000);
    try {
      await api('/api/delete', { id });
      await load(); S.stack = []; show('home'); toast('Eliminato');
    } catch { toast('Eliminazione non riuscita'); rerender('d:del'); }
  },
  play(file, el) { startPlayer(file, +(el && el.dataset.pos) || 0); },
  version(arg) { const [id, file] = arg.split('|'); S.pref[id] = file; rerender('v:' + file); },
  season(arg) { const [id, n] = arg.split('|'); S.season[id] = +n; rerender('s:' + n); },
  async toggleWatched(id) {
    const m = S.byId.get(id);
    const value = !isWatched(m);
    const files = value ? [chosenVersion(m).id] : m.versions.map(v => v.id);
    try {
      for (const f of files) S.prog[f] = await api('/api/progress', { id: f, watched: value });
      rerender('d:watched');
    } catch { toast('Il PC non risponde'); }
  },
};
function activate(el) { const fn = ACTIONS[el.dataset.act]; if (fn) fn(el.dataset.arg, el); }


// ---------- scheda Scarica (ricerca su Radarr/Sonarr) ----------
S.dl = { kind: 'movie', q: '', results: null, queue: [], busy: false, err: '' };
const DL_STATUS = { downloading: 'In download', importPending: 'In importazione', importing: 'In importazione', paused: 'In pausa', queued: 'In coda' };
function dlCard(r, i) {
  const tag = r.hasFile ? 'Già in libreria' : r.added ? 'Richiesto' : '';
  return `<div class="card f" data-key="r:${i}" data-act="dlAdd" data-arg="${i}">
    ${art(r.title, r.poster, 'poster')}
    ${tag ? `<div class="ok tagd">${tag}</div>` : ''}
    <div class="cap"><b>${esc(r.title)}</b>${r.year || ''}${r.seasons ? ' · ' + r.seasons + ' stag.' : ''}</div>
  </div>`;
}
SCREENS.dl = () => {
  const d = S.dl;
  const res = d.busy ? '<div class="splash small"><div class="spinner"></div></div>'
    : d.err ? `<p class="dlmsg">${esc(d.err)}</p>`
    : d.results == null ? '<p class="dlmsg">Scrivi il titolo e premi OK sulla tastiera per cercare.</p>'
    : !d.results.length ? '<p class="dlmsg">Nessun risultato.</p>'
    : `<div class="grid">${d.results.map(dlCard).join('')}</div>`;
  const q = d.queue.map(x => `<div class="dlrow"><b>${esc(x.title)}</b><span>${esc(DL_STATUS[x.status] || x.status || '')}${x.eta && x.pct < 100 ? ' · ' + esc(x.eta.replace(/^00:/, '').replace(/^(\d+)\.(\d+):(\d+).*/, '$1 g $2 h')) : ''}</span><div class="dlbar"><i style="width:${x.pct}%"></i></div><em>${x.pct}%</em></div>`).join('');
  return `<div class="screen">${nav('dl')}
    <h1 class="page-title">Scarica</h1>
    <div class="chips dlbar0" data-row="dlk">
      <div class="chip f${d.kind === 'movie' ? ' sel' : ''}" data-key="dl:movie" data-act="dlKind" data-arg="movie" data-top>Film</div>
      <div class="chip f${d.kind === 'series' ? ' sel' : ''}" data-key="dl:series" data-act="dlKind" data-arg="series">Serie TV</div>
      <input id="dlq" class="dlinput f" data-key="dl:q" data-act="dlFocus" type="text" placeholder="Cerca ${d.kind === 'movie' ? 'un film' : 'una serie'}…" value="${esc(d.q)}" autocomplete="off" spellcheck="false">
    </div>
    ${res}
    ${q ? `<h2 class="dlh">In download</h2><div class="dllist">${q}</div>` : ''}
  </div>`;
};
async function refreshQueue() {
  try { S.dl.queue = await fetch('/api/dl/queue').then(r => r.json()); } catch { return; }
  if (S.screen && S.screen.name === 'dl' && !S.dl.busy && document.activeElement.tagName !== 'INPUT') rerender();
}
function openDl() { S.dl.err = ''; show('dl', {}, 'dl:q'); refreshQueue(); }
async function dlSearch() {
  const q = $('#dlq').value.trim();
  S.dl.q = q;
  if (q.length < 2) return;
  S.dl.busy = true; S.dl.err = ''; rerender('dl:q');
  try {
    const r = await fetch('/api/dl/search?kind=' + S.dl.kind + '&q=' + encodeURIComponent(q)).then(r => r.json());
    if (r.error) throw new Error(r.error);
    S.dl.results = r;
  } catch (e) { S.dl.results = null; S.dl.err = 'Ricerca non riuscita: ' + e.message; }
  S.dl.busy = false;
  rerender(S.dl.results && S.dl.results.length ? 'r:0' : 'dl:q');
}
Object.assign(ACTIONS, {
  dlKind(k) { if (S.dl.kind !== k) { S.dl.kind = k; S.dl.results = null; S.dl.err = ''; } rerender('dl:' + k); },
  dlFocus() { const i = $('#dlq'); i.focus(); try { i.setSelectionRange(i.value.length, i.value.length); } catch {} },
  async dlAdd(i) {
    const r = S.dl.results[+i];
    if (!r || r.added) return toast(r && r.hasFile ? 'È già in libreria' : 'È già stato richiesto');
    toast('Aggiungo «' + r.title + '»…', 10000);
    try {
      const x = await api('/api/dl/add', { kind: r.kind, key: r.key });
      if (x.error) throw new Error(x.error);
      r.added = true;
      toast('Richiesto: ' + r.title + '. Cerco il download…', 4000);
      refreshQueue(); setTimeout(refreshQueue, 8000);
      rerender('r:' + i);
    } catch (e) { toast('Non riuscito: ' + e.message, 5000); }
  },
});
setInterval(() => { if (S.screen && S.screen.name === 'dl') refreshQueue(); }, 15000);

// ---------- lettore ----------

function startPlayer(file, pos) {
  const ctx = S.fileCtx.get(file);
  if (!ctx) return;
  if (S.player) stopVideo(); else pushCurrent();
  S.screen = { name: 'player' };
  const it = ctx.item, ep = ctx.ep;
  const sub = ep ? `Stagione ${ep.season} · Episodio ${ep.e}${ep.title ? ' · ' + ep.title : ''}` : [it.year, ctx.version.label].filter(Boolean).join(' · ');
  app.innerHTML = `<div class="player loading">
    <video id="v" preload="auto"></video>
    <div class="spinner"></div>
    <div class="osd">
      <div class="top"><h2>${esc(it.title)}</h2><div class="sub">${esc(sub)}</div></div>
      <div class="pstate">❚❚</div>
      <div class="bottom">
        <div class="pbar"><div class="buf"></div><div class="fill"></div><div class="knob"></div></div>
        <div class="times"><span class="tcur">0:00</span><span class="tend"></span></div>
        <div class="hints"><span>OK pausa</span><span>Frecce: salta</span><span>Su: audio e sottotitoli</span><span>Indietro esci</span></div>
      </div>
    </div>
    <div class="subtitle"></div>
    ${ep ? '<div class="btn on nextbtn">Prossimo episodio</div>' : ''}
    <div class="layer"></div>
  </div>`;
  const v = $('#v');
  const p = S.player = { v, file, ctx, saved: 0, seekTo: null, streak: 0, lastSeek: 0, panel: null, ended: false, tracks: null, sub: null };
  api('/api/tracks/' + file).then(t => { if (S.player === p) { p.tracks = t; autoSubs(); } }).catch(() => {});
  p.subTimer = setInterval(drawCue, 150);
  const root = $('.player');
  v.addEventListener('loadedmetadata', () => { if (pos > 0) v.currentTime = pos; pickItalian(); }, { once: true });
  v.addEventListener('waiting', () => root.classList.add('loading'));
  v.addEventListener('playing', () => { root.classList.remove('loading'); root.classList.remove('paused'); osd(); });
  v.addEventListener('canplay', () => root.classList.remove('loading'));
  v.addEventListener('pause', () => { if (!p.ended) { root.classList.add('paused'); osd(true); saveProgress(); } });
  const nextBtn = $('.nextbtn');
  if (nextBtn) nextBtn.addEventListener('click', skipToNext);
  v.addEventListener('timeupdate', () => {
    updateOsd();
    // negli ultimi 90 secondi di un episodio (non nei corti) propone il successivo
    p.nearEnd = !!nextBtn && !p.ended && !!nextEpisode() && v.duration > 600 && v.duration - v.currentTime <= 90;
    root.classList.toggle('near-end', p.nearEnd);
    if (Date.now() - p.saved > 10000) saveProgress();
  });
  v.addEventListener('ended', onEnded);
  v.addEventListener('error', () => {
    if (S.player !== p) return;
    root.classList.remove('loading');
    const code = v.error ? v.error.code : '?';
    $('.layer').innerHTML = `<div class="perr"><b>La TV non riesce a riprodurre questo file</b><p>Il formato video o audio potrebbe non essere supportato (errore ${code}).<br>Premi Indietro per tornare.</p></div>`;
  });
  v.src = '/media/' + file;
  v.play().catch(() => {});
  osd();
}

function stopVideo() {
  const p = S.player;
  if (!p) return;
  clearTimeout(p.hideTimer); clearTimeout(p.seekTimer); clearInterval(p.countdown); clearInterval(p.subTimer);
  p.v.pause();
  p.v.removeAttribute('src');
  p.v.load();
  S.player = null;
}
function saveProgress(force) {
  const p = S.player;
  if (!p) return;
  const v = p.v, dur = v.duration;
  if (!dur || !isFinite(dur)) return;
  const pos = force != null ? force : (p.seekTo != null ? p.seekTo : v.currentTime);
  p.saved = Date.now();
  const done = pos / dur > 0.92;
  const prev = S.prog[p.file] || {};
  S.prog[p.file] = { pos: done ? 0 : pos, dur, t: Date.now(), w: done || !!prev.w };
  api('/api/progress', { id: p.file, pos, dur }).catch(() => {});
}
async function closePlayer() {
  saveProgress();
  stopVideo();
  const prev = S.stack.pop() || { name: 'home', params: {} };
  try { S.prog = await api('/api/progress'); } catch {}
  show(prev.name, prev.params, prev.key, prev.scroll);
}

function osd(sticky) {
  const p = S.player;
  if (!p) return;
  const el = $('.osd');
  el.classList.add('show');
  updateOsd();
  clearTimeout(p.hideTimer);
  if (!sticky) p.hideTimer = setTimeout(() => { if (S.player && !S.player.v.paused && S.player.seekTo == null) el.classList.remove('show'); }, 4000);
}
function updateOsd() {
  const p = S.player;
  if (!p) return;
  const v = p.v, dur = isFinite(v.duration) ? v.duration : 0;
  const t = p.seekTo != null ? p.seekTo : v.currentTime;
  const pct = dur ? t / dur * 100 : 0;
  $('.pbar .fill').style.width = pct + '%';
  $('.pbar .knob').style.left = pct + '%';
  if (dur && v.buffered.length) $('.pbar .buf').style.width = v.buffered.end(v.buffered.length - 1) / dur * 100 + '%';
  const cur = $('.tcur');
  cur.textContent = fmt(t);
  cur.className = 'tcur' + (p.seekTo != null ? ' seek' : '');
  $('.tend').textContent = dur ? `-${fmt(dur - t)} · fine alle ${clock(new Date(Date.now() + (dur - t) * 1000))}` : '';
}
function seek(dir, big) {
  const p = S.player, v = p.v;
  if (!isFinite(v.duration)) return;
  const now = Date.now();
  p.streak = now - p.lastSeek < 700 ? p.streak + 1 : 0;
  p.lastSeek = now;
  const step = big ? 60 : p.streak > 8 ? 60 : p.streak > 3 ? 30 : 10;
  const base = p.seekTo != null ? p.seekTo : v.currentTime;
  p.seekTo = Math.max(0, Math.min(v.duration - 3, base + dir * step));
  osd();
  clearTimeout(p.seekTimer);
  p.seekTimer = setTimeout(() => { v.currentTime = p.seekTo; p.seekTo = null; osd(); }, 650);
}
function pickItalian() {
  const t = S.player && S.player.v.audioTracks;
  if (!t || t.length < 2) return;
  let ita = -1;
  for (let i = 0; i < t.length; i++) if (/^it/i.test(t[i].language || '') || /ital/i.test(t[i].label || '')) { ita = i; break; }
  if (ita >= 0 && !t[ita].enabled) for (let i = 0; i < t.length; i++) t[i].enabled = i === ita;
}
// ---------- sottotitoli ----------
function parseVtt(txt) {
  const ts = s => { const m = s.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d+)/); return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : 0; };
  const cues = [];
  for (const block of txt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.indexOf('-->') >= 0);
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const text = esc(lines.slice(i + 1).join('\n').replace(/\{[^}]*\}/g, '').replace(/<(?!\/?i>)[^>]+>/g, '').trim())
      .replace(/&lt;(\/?)i&gt;/g, '<$1i>').replace(/\n/g, '<br>');
    if (text) cues.push({ s: ts(a), e: ts(z.trim().split(/\s/)[0]), text });
  }
  return cues;
}
function drawCue() {
  const p = S.player;
  if (!p) return;
  const box = $('.subtitle');
  let html = '';
  if (p.sub) {
    const t = p.v.currentTime;
    html = p.sub.cues.filter(c => c.s <= t && t < c.e).map(c => `<span>${c.text}</span>`).join('<br>');
  }
  if (box && box._html !== html) { box._html = html; box.innerHTML = html; }
}
function subLabel(s) {
  const lang = langName(s.lang) || 'Sottotitoli';
  const title = (s.title || '').trim();
  const generic = !title || /^(sub )?(italian|italiano|english|inglese|ita|eng)$/i.test(title) || title.toLowerCase() === lang.toLowerCase();
  return lang + (generic ? '' : ' · ' + title) + (s.forced && !/forced|forzat/i.test(title) ? ' · Forzati' : '');
}
const subOrder = s => (isIta(s.lang) ? 0 : /^en/i.test(s.lang) ? 1 : 2);
function autoSubs() {
  const p = S.player, list = p.tracks.subs;
  const pref = S.subPref;
  if (pref === 'off') return;
  const pick = pref
    ? list.find(s => s.lang === pref.lang && s.forced === pref.forced && s.title === pref.title) || list.find(s => s.lang === pref.lang && s.forced === pref.forced)
    : list.find(s => s.forced && isIta(s.lang)); // di default: solo i forzati in italiano
  if (pick) loadSub(pick.key, true);
}
function loadSub(key, quiet) {
  const p = S.player;
  if (!key) { p.sub = null; drawCue(); return; }
  const slow = setTimeout(() => { if (!quiet) toast('Preparo i sottotitoli…', 120000); }, 700);
  fetch(`/subs/${p.file}/${key}.vtt`)
    .then(r => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
    .then(txt => {
      if (S.player !== p) return;
      p.sub = { key, cues: parseVtt(txt) };
      if (!quiet) hideToast();
      drawCue();
    })
    .catch(() => { if (!quiet && S.player === p) toast('Sottotitoli non disponibili'); })
    .finally(() => clearTimeout(slow));
}

// ---------- menu audio e sottotitoli ----------
function openTracks() {
  const p = S.player, at = p.v.audioTracks;
  const items = [{ h: 'Sottotitoli' }];
  if (!p.tracks) items.push({ note: 'Caricamento…' });
  else {
    items.push({ type: 'sub', key: null, label: 'Disattivati', cur: !p.sub });
    p.tracks.subs.slice().sort((a, b) => subOrder(a) - subOrder(b))
      .forEach(s => items.push({ type: 'sub', key: s.key, s, label: subLabel(s), cur: !!p.sub && p.sub.key === s.key }));
    if (!p.tracks.subs.length && p.tracks.imageOnly) items.push({ note: 'Solo sottotitoli in formato immagine, non supportati' });
  }
  if (at && at.length > 1) {
    items.push({ h: 'Audio' });
    const info = p.tracks && p.tracks.audio.length === at.length ? p.tracks.audio : null;
    for (let i = 0; i < at.length; i++) {
      const a = info ? info[i] : { lang: at[i].language, title: at[i].label };
      const label = [langName(a.lang), a.title].filter(Boolean).join(' · ') || 'Traccia ' + (i + 1);
      items.push({ type: 'audio', i, label, cur: at[i].enabled });
    }
  }
  const first = items.findIndex(x => x.cur);
  p.panel = { kind: 'tracks', items, i: first >= 0 ? first : items.findIndex(x => x.type) };
  renderTracks();
  osd(true);
}
function renderTracks() {
  const p = S.player, pn = p.panel;
  $('.layer').innerHTML = `<div class="panel tracks">${pn.items.map((x, i) =>
    x.h ? `<h3>${esc(x.h)}</h3>` : x.note ? `<div class="note">${esc(x.note)}</div>`
      : `<div class="it${x.cur ? ' cur' : ''}${i === pn.i ? ' on' : ''}">${x.cur ? '✓ ' : ''}${esc(x.label)}</div>`).join('')}</div>`;
  const on = $('.panel .on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function moveTracks(d) {
  const pn = S.player.panel, n = pn.items.length;
  let i = pn.i;
  for (let k = 0; k < n; k++) { i = (i + d + n) % n; if (pn.items[i].type) break; }
  pn.i = i;
  renderTracks();
}
function chooseTrack() {
  const p = S.player, x = p.panel.items[p.panel.i];
  if (!x || !x.type) return;
  if (x.type === 'sub') {
    S.subPref = x.key ? { lang: x.s.lang, forced: x.s.forced, title: x.s.title } : 'off';
    loadSub(x.key);
  } else {
    const at = p.v.audioTracks;
    for (let i = 0; i < at.length; i++) at[i].enabled = i === x.i;
  }
  closePanel();
}
function closePanel() { S.player.panel = null; $('.layer').innerHTML = ''; osd(); }

function nextEpisode() {
  const { item, ep } = S.player.ctx;
  return ep ? item.flat[item.flat.indexOf(ep) + 1] : null;
}
function skipToNext() {
  const nx = nextEpisode();
  if (!nx) return;
  saveProgress(S.player.v.duration); // salta i titoli di coda: l'episodio conta come visto
  startPlayer(nx.id, 0);
}
function onEnded() {
  const p = S.player;
  p.ended = true;
  saveProgress(p.v.duration);
  const nx = nextEpisode();
  if (!nx) return closePlayer();
  let n = 10;
  p.panel = { kind: 'next', file: nx.id };
  const draw = () => {
    $('.layer').innerHTML = `<div class="panel nextup"><h3>Prossimo episodio tra ${n}</h3><b>${epLabel(nx)}${nx.title ? ' · ' + esc(nx.title) : ''}</b><p>OK per iniziare subito, Indietro per uscire</p><div class="btn on">Riproduci</div></div>`;
  };
  draw();
  p.countdown = setInterval(() => { n--; if (n <= 0) startPlayer(nx.id, 0); else draw(); }, 1000);
}

function playerKey(k) {
  const p = S.player, v = p.v;
  if (p.panel && p.panel.kind === 'next') {
    if (k === 'ok' || k === 'play') startPlayer(p.panel.file, 0);
    else if (k === 'back' || k === 'stop') closePlayer();
    return;
  }
  if (p.panel) {
    if (k === 'up') moveTracks(-1);
    else if (k === 'down') moveTracks(1);
    else if (k === 'ok') chooseTrack();
    else if (k === 'back' || k === 'left' || k === 'right') closePanel();
    return;
  }
  if ($('.perr')) { if (k === 'back' || k === 'ok' || k === 'stop') closePlayer(); return; }
  if (p.nearEnd && k === 'ok') return skipToNext();
  switch (k) {
    case 'ok': case 'playpause': if (v.paused) v.play(); else v.pause(); break;
    case 'play': v.play(); break;
    case 'pause': v.pause(); break;
    case 'left': seek(-1); break;
    case 'right': seek(1); break;
    case 'rw': seek(-1, true); break;
    case 'ff': seek(1, true); break;
    case 'up': openTracks(); break;
    case 'down': osd(); break;
    case 'back': case 'stop': closePlayer(); break;
  }
}

// ---------- tasti ----------
const KEYS = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 461: 'back', 27: 'back', 8: 'back', 415: 'play', 19: 'pause', 413: 'stop', 417: 'ff', 412: 'rw', 179: 'playpause', 32: 'playpause' };
document.addEventListener('keydown', e => {
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT') {
    // tastiera attiva: Invio cerca, Indietro la chiude; il resto va al campo di testo
    if (e.keyCode === 13) { e.preventDefault(); ae.blur(); dlSearch(); }
    else if (e.keyCode === 461 || e.keyCode === 27) { e.preventDefault(); ae.blur(); }
    return;
  }
  const k = KEYS[e.keyCode];
  if (!k) return;
  e.preventDefault();
  if (S.player) return playerKey(k);
  if (!S.lib) { if (k === 'ok') start(); else if (k === 'back') window.close(); return; }
  if (k === 'back') return back();
  if (k === 'ok') return focused && activate(focused);
  if (k === 'left' || k === 'right' || k === 'up' || k === 'down') return move(k);
});

// ---------- avvio ----------
async function start() {
  app.innerHTML = '<div class="splash"><div class="logo big">Freckles<span>Night</span></div><div class="spinner"></div></div>';
  try {
    await load();
    show('home');
  } catch {
    app.innerHTML = '<div class="splash"><div class="logo big">Freckles<span>Night</span></div><p>Non riesco a leggere la libreria dal PC.<br>Premi OK per riprovare.</p></div>';
  }
}
start();
