'use strict';
// Ricerca e richiesta di film/serie tramite Radarr e Sonarr (scheda "Scarica").
// Le chiavi API restano sul PC: si leggono dai config.xml dei container e non vanno mai alla TV.
const fs = require('fs');
const path = require('path');

module.exports = function arr(config) {
  const cfg = Object.assign({
    dir: '/home/vaith/Server/arr',
    radarr: 'http://127.0.0.1:7878',
    sonarr: 'http://127.0.0.1:8989',
  }, config.arr);
  const apps = { movie: { name: 'radarr', url: cfg.radarr }, series: { name: 'sonarr', url: cfg.sonarr } };
  const cache = {};

  function key(app) {
    try {
      const xml = fs.readFileSync(path.join(cfg.dir, 'config', app.name, 'config.xml'), 'utf8');
      return /<ApiKey>([^<]+)<\/ApiKey>/.exec(xml)[1];
    } catch { throw new Error(`Non trovo la chiave di ${app.name}`); }
  }
  async function call(kind, p, opts = {}) {
    const app = apps[kind];
    const r = await fetch(app.url + '/api/v3' + p, {
      method: opts.method || 'GET',
      headers: { 'X-Api-Key': key(app), 'content-type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeout || 20000),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) {
      const msg = Array.isArray(data) ? data.map(e => e.errorMessage).join(' ') : (data && data.message) || text.slice(0, 120);
      throw new Error(msg || 'errore ' + r.status);
    }
    return data;
  }
  // cartella e profilo qualità: prendo i primi configurati (si cambiano da Radarr/Sonarr)
  async function defaults(kind) {
    const c = cache[kind];
    if (c && Date.now() - c.t < 60000) return c.v;
    const [roots, profiles] = await Promise.all([call(kind, '/rootfolder'), call(kind, '/qualityprofile')]);
    if (!roots.length || !profiles.length) throw new Error('Cartella o profilo qualità non configurati');
    const v = { rootFolderPath: roots.slice().sort((a, b) => b.freeSpace - a.freeSpace)[0].path, // il disco con più spazio libero: i due dischi si riempiono in modo bilanciato
       qualityProfileId: (profiles.find(p => p.name === (cfg.profile || 'Any')) || profiles[0]).id };
    if (kind === 'series') {
      const langs = await call(kind, '/languageprofile').catch(() => []);
      if (langs.length) v.languageProfileId = langs[0].id;
    }
    cache[kind] = { t: Date.now(), v };
    return v;
  }
  const poster = it => {
    const im = (it.images || []).find(i => i.coverType === 'poster');
    return im && im.remoteUrl ? im.remoteUrl.replace('/original/', '/w342/') : null;
  };

  async function search(q, kind) {
    if (!q || q.length < 2) return [];
    const list = await call(kind, (kind === 'movie' ? '/movie/lookup' : '/series/lookup') + '?term=' + encodeURIComponent(q));
    return list.slice(0, 18).map(it => ({
      kind,
      key: kind === 'movie' ? it.tmdbId : it.tvdbId,
      title: it.title, year: it.year || null, overview: it.overview || '',
      poster: poster(it),
      added: !!it.id,
      hasFile: kind === 'movie' ? !!it.hasFile : !!(it.statistics && it.statistics.episodeFileCount),
      seasons: kind === 'series' ? (it.statistics ? it.statistics.seasonCount : (it.seasons || []).filter(s => s.seasonNumber > 0).length) : undefined,
    })).filter(x => x.key);
  }

  async function add(kind, id) {
    try { return await addNew(kind, id); }
    catch (e) { if (/already been added/i.test(e.message)) return { already: true }; throw e; }
  }
  async function addNew(kind, id) {
    id = +id;
    if (!id) throw new Error('titolo non valido');
    const d = await defaults(kind);
    if (kind === 'movie') {
      const m = await call(kind, '/movie/lookup/tmdb?tmdbId=' + id);
      if (m.id) return { title: m.title, already: true };
      await call(kind, '/movie', { method: 'POST', body: Object.assign(m, d, { monitored: true, minimumAvailability: 'released', addOptions: { searchForMovie: true } }) });
      return { title: m.title };
    }
    const s = (await call(kind, '/series/lookup?term=' + encodeURIComponent('tvdb:' + id)))[0];
    if (!s) throw new Error('serie non trovata');
    if (s.id) return { title: s.title, already: true };
    await call(kind, '/series', { method: 'POST', body: Object.assign(s, d, { monitored: true, seasonFolder: true, addOptions: { monitor: 'all', searchForMissingEpisodes: true } }) });
    return { title: s.title };
  }

  async function queue() {
    const out = [];
    for (const kind of ['movie', 'series']) {
      try {
        const q = await call(kind, '/queue?pageSize=50&includeMovie=true&includeSeries=true&includeEpisode=true', { timeout: 8000 });
        for (const r of q.records || []) {
          const size = r.size || 0;
          const base = kind === 'movie' ? (r.movie && r.movie.title) : (r.series && r.series.title);
          const ep = kind === 'series' && r.episode ? ` S${r.episode.seasonNumber}E${r.episode.episodeNumber}` : '';
          out.push({ kind, id: r.id, title: (base || r.title) + ep, pct: size ? Math.round((1 - (r.sizeleft || 0) / size) * 100) : 0, status: r.trackedDownloadState || r.status, eta: r.timeleft || '' });
        }
      } catch { /* app spenta: ignoro */ }
    }
    return out;
  }

  // Annulla uno scaricamento: lo toglie dalla coda e dal client che lo sta scaricando.
  // Da solo non basta, perché Radarr/Sonarr lo cercherebbero di nuovo: il film che non ha ancora un file esce da Radarr
  // (così si può richiedere più avanti), l'episodio smette di essere seguito.
  async function cancel(kind, id) {
    id = +id;
    const q = await call(kind, '/queue?pageSize=200');
    const r = (q.records || []).find(x => x.id === id);
    if (!r) throw new Error('scaricamento non più in coda');
    await call(kind, `/queue/${id}?removeFromClient=true&blocklist=false`, { method: 'DELETE' });
    if (kind === 'movie' && r.movieId) {
      const m = await call(kind, '/movie/' + r.movieId);
      if (!m.hasFile) await call(kind, `/movie/${r.movieId}?deleteFiles=false&addImportExclusion=false`, { method: 'DELETE' });
    }
    if (kind === 'series' && r.episodeId) await call(kind, '/episode/monitor', { method: 'PUT', body: { episodeIds: [r.episodeId], monitored: false } });
    return { ok: true };
  }

  // Dopo un'eliminazione dal disco: il titolo esce anche da Radarr/Sonarr, altrimenti lo riscaricherebbero.
  // Lo riconosco dal nome della cartella, che è lo stesso dentro e fuori dai container. App spenta: ignoro.
  async function forget(kind, folders) {
    if (!folders.length) return;
    const names = new Set(folders), what = kind === 'movie' ? '/movie' : '/series';
    try {
      for (const it of await call(kind, what, { timeout: 8000 })) {
        if (!names.has(path.posix.basename(it.path || ''))) continue;
        await call(kind, `${what}/${it.id}?deleteFiles=false&addImportExclusion=false`, { method: 'DELETE' });
      }
    } catch { /* la cancellazione dal disco è già fatta */ }
  }

  return { search, add, queue, cancel, forget };
};
