const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ─── SIMPLE JSON DATABASE ─────────────────────────────────────────────────────
// Pure JavaScript — no native modules, no compilation. Works on every host.

const DB_PATH = path.join(__dirname, 'data');
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });

function readTable(name) {
  const file = path.join(DB_PATH, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function writeTable(name, data) {
  const file = path.join(DB_PATH, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readMeta() {
  const file = path.join(DB_PATH, 'meta.json');
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeMeta(data) {
  fs.writeFileSync(path.join(DB_PATH, 'meta.json'), JSON.stringify(data, null, 2));
}

function nextId(table) {
  const rows = readTable(table);
  return rows.length === 0 ? 1 : Math.max(...rows.map(r => r.id || 0)) + 1;
}

function dbFindGame(predicate) {
  return readTable('games').find(predicate) || null;
}

function dbUpsertGame(game) {
  const games = readTable('games');
  const idx = games.findIndex(g =>
    (game.igdb_id && g.igdb_id === game.igdb_id) ||
    (game.id && g.id === game.id) ||
    (!game.igdb_id && !game.id && g.title?.toLowerCase() === game.title?.toLowerCase())
  );
  const now = new Date().toISOString();
  if (idx >= 0) {
    games[idx] = { ...games[idx], ...game, updated_at: now };
  } else {
    games.push({ id: nextId('games'), created_at: now, updated_at: now, status: 'unknown', ...game });
  }
  writeTable('games', games);
  return games[idx >= 0 ? idx : games.length - 1];
}

function dbUpsertNews(item) {
  const news = readTable('news');
  const idx = news.findIndex(n => n.reddit_id === item.reddit_id);
  if (idx >= 0) { news[idx] = { ...news[idx], ...item }; }
  else { news.push({ id: nextId('news'), fetched_at: new Date().toISOString(), ...item }); }
  writeTable('news', news);
}

function dbAddWatchlist(session_id, game_id) {
  const wl = readTable('watchlist');
  if (!wl.find(w => w.session_id === session_id && w.game_id === game_id)) {
    wl.push({ id: nextId('watchlist'), session_id, game_id, added_at: new Date().toISOString(), notified: false });
    writeTable('watchlist', wl);
  }
}

function dbRemoveWatchlist(session_id, game_id) {
  writeTable('watchlist', readTable('watchlist').filter(w => !(w.session_id === session_id && w.game_id === game_id)));
}

function dbGetWatchlistGames(session_id) {
  const wl = readTable('watchlist').filter(w => w.session_id === session_id);
  const games = readTable('games');
  return wl.map(w => {
    const g = games.find(g => g.id === w.game_id);
    return g ? { ...g, added_at: w.added_at, notified: w.notified, watch_id: w.id } : null;
  }).filter(Boolean);
}

// ─── IGDB API ─────────────────────────────────────────────────────────────────
let igdbToken = null;
let igdbTokenExpiry = 0;

async function getIgdbToken() {
  if (igdbToken && Date.now() < igdbTokenExpiry) return igdbToken;
  const { IGDB_CLIENT_ID: clientId, IGDB_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) { console.warn('⚠️  IGDB credentials not set'); return null; }
  try {
    const res = await axios.post(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`
    );
    igdbToken = res.data.access_token;
    igdbTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    console.log('✅ IGDB token refreshed');
    return igdbToken;
  } catch (e) {
    console.error('❌ IGDB auth failed:', e.message);
    return null;
  }
}

async function igdbSearch(query, limit = 10) {
  const token = await getIgdbToken();
  if (!token) return [];
  try {
    const res = await axios.post(
      'https://api.igdb.com/v4/games',
      `fields name,slug,cover.url,first_release_date,platforms.name,genres.name,summary;
       search "${query.replace(/"/g, '')}";
       where platforms = (6) & version_parent = null;
       limit ${limit};`,
      { headers: { 'Client-ID': process.env.IGDB_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' } }
    );
    return res.data || [];
  } catch (e) {
    console.error('IGDB search error:', e.message);
    return [];
  }
}

function formatIgdbGame(g) {
  const releaseTs = g.first_release_date ? g.first_release_date * 1000 : null;
  return {
    igdb_id: g.id,
    title: g.name,
    slug: g.slug,
    cover_url: g.cover?.url ? 'https:' + g.cover.url.replace('t_thumb', 't_cover_big') : null,
    release_date: releaseTs ? new Date(releaseTs).toISOString().split('T')[0] : null,
    release_timestamp: releaseTs,
    platforms: g.platforms?.map(p => p.name).join(', ') || null,
    genres: g.genres?.map(g => g.name).join(', ') || null,
    summary: g.summary || null,
  };
}

// ─── REDDIT r/CrackWatch PARSER ───────────────────────────────────────────────
const CRACK_PATTERNS = [
  /^\[CRACKED\]\s*(.+?)(?:\s*[\(\[].+[\)\]])?\s*[-–]\s*(.+)$/i,
  /^\[CRACKED\]\s*(.+)$/i,
  /^(.+?)\s+(?:has been |is now )?cracked\s+by\s+(.+)$/i,
  /^(.+?)\s*[-–]\s*cracked$/i,
];
const UNCRACKED_PATTERNS = [/^\[UNCRACKED\]\s*(.+)/i, /^\[STATUS\]\s*(.+)/i];
const DRM_PATTERNS = {
  'Denuvo': /denuvo/i, 'Steam DRM': /steam\s*drm/i, 'EGS DRM': /epic\s*game|egs/i,
  'VMProtect': /vmprotect/i, 'Arxan': /arxan/i, 'Enigma': /enigma/i, 'FADE': /fade/i,
};

function parseRedditPost(post) {
  const title = post.title || '';
  const flair = (post.link_flair_text || '').toUpperCase();
  let status = 'unknown', gameName = null, crackGroup = null;

  if (flair.includes('CRACKED') || flair.includes('SCENE')) status = 'cracked';
  else if (flair.includes('UNCRACKED') || flair.includes('DENUVO')) status = 'uncracked';

  for (const p of CRACK_PATTERNS) {
    const m = title.match(p);
    if (m) { gameName = m[1]?.trim(); crackGroup = m[2]?.trim(); status = 'cracked'; break; }
  }
  if (!gameName) {
    for (const p of UNCRACKED_PATTERNS) {
      const m = title.match(p);
      if (m) { gameName = m[1]?.trim(); status = 'uncracked'; break; }
    }
  }
  if (!gameName) gameName = title.replace(/^\[.*?\]\s*/, '').trim();

  const fullText = title + ' ' + (post.selftext || '');
  let drm = null;
  for (const [name, pattern] of Object.entries(DRM_PATTERNS)) {
    if (pattern.test(fullText)) { drm = name; break; }
  }

  const createdDate = post.created_utc ? new Date(post.created_utc * 1000).toISOString().split('T')[0] : null;

  let tag = 'scene';
  if (flair.includes('CRACK') || status === 'cracked') tag = 'release';
  else if (drm) tag = 'drm';
  else if (/update|patch/i.test(title)) tag = 'update';
  else if (/bypass|remove/i.test(title)) tag = 'bypass';

  return { gameName, status, crackGroup, drm, createdDate, tag };
}

async function fetchRedditPosts(sort = 'new', limit = 100) {
  try {
    const res = await axios.get(`https://www.reddit.com/r/CrackWatch/${sort}.json?limit=${limit}&t=month`, {
      headers: { 'User-Agent': 'CrackTrack/1.0 (game crack status tracker)' },
      timeout: 15000
    });
    return res.data?.data?.children?.map(c => c.data) || [];
  } catch (e) {
    console.error('Reddit fetch error:', e.message);
    return [];
  }
}

async function syncCrackWatch() {
  console.log('🔄 Syncing r/CrackWatch...');
  const [newPosts, hotPosts] = await Promise.all([fetchRedditPosts('new', 100), fetchRedditPosts('hot', 50)]);
  const seen = new Set();
  const unique = [...newPosts, ...hotPosts].filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });

  let crackedCount = 0, newsCount = 0;

  for (const post of unique) {
    const parsed = parseRedditPost(post);
    const postUrl = `https://reddit.com${post.permalink}`;
    const postDate = post.created_utc ? new Date(post.created_utc * 1000).toISOString().split('T')[0] : null;

    try {
      dbUpsertNews({ reddit_id: post.id, title: post.title, body: (post.selftext || '').slice(0, 2000), url: postUrl, author: post.author, score: post.score || 0, tag: parsed.tag, created_utc: post.created_utc || 0 });
      newsCount++;
    } catch {}

    if (parsed.status === 'cracked' && parsed.gameName?.length > 2) {
      try {
        const existing = dbFindGame(g => g.title?.toLowerCase() === parsed.gameName.toLowerCase());
        const crackTs = post.created_utc ? post.created_utc * 1000 : Date.now();
        if (existing) {
          if (existing.status !== 'cracked') {
            const daysToCrack = existing.release_timestamp ? Math.round((crackTs - existing.release_timestamp) / 86400000) : null;
            dbUpsertGame({ ...existing, status: 'cracked', cracked_date: postDate, crack_group: parsed.crackGroup, days_to_crack: daysToCrack, reddit_post_url: postUrl, reddit_post_title: post.title, drm: parsed.drm || existing.drm });
            crackedCount++;
          }
        } else {
          dbUpsertGame({ title: parsed.gameName, status: 'cracked', cracked_date: postDate, crack_group: parsed.crackGroup, reddit_post_url: postUrl, reddit_post_title: post.title, drm: parsed.drm });
          crackedCount++;
        }
      } catch (e) { console.error('Game upsert error:', e.message); }
    }

    if (parsed.status === 'uncracked' && parsed.gameName?.length > 2) {
      const existing = dbFindGame(g => g.title?.toLowerCase() === parsed.gameName.toLowerCase());
      if (!existing) dbUpsertGame({ title: parsed.gameName, status: 'uncracked', drm: parsed.drm, reddit_post_url: postUrl });
    }
  }

  const meta = readMeta();
  meta.last_reddit_sync = new Date().toISOString();
  writeMeta(meta);
  console.log(`✅ Sync done: ${crackedCount} crack updates, ${newsCount} news items`);
}

async function enrichWithIgdb(batchSize = 20) {
  if (!process.env.IGDB_CLIENT_ID) return;
  console.log('🎮 Enriching with IGDB metadata...');
  const games = readTable('games').filter(g => !g.igdb_id && g.title).slice(0, batchSize);
  for (const game of games) {
    await new Promise(r => setTimeout(r, 350));
    const results = await igdbSearch(game.title, 3);
    if (results.length > 0) {
      const fmt = formatIgdbGame(results[0]);
      const crackedTs = game.cracked_date ? new Date(game.cracked_date).getTime() : null;
      const daysToCrack = fmt.release_timestamp && crackedTs ? Math.round((crackedTs - fmt.release_timestamp) / 86400000) : game.days_to_crack;
      dbUpsertGame({ ...game, ...fmt, days_to_crack: daysToCrack });
    }
  }
  console.log(`✅ IGDB done for ${games.length} games`);
}

// ─── SCHEDULED SYNC ───────────────────────────────────────────────────────────
cron.schedule('0 */2 * * *', async () => { await syncCrackWatch(); await enrichWithIgdb(30); });
setTimeout(async () => { await syncCrackWatch(); await enrichWithIgdb(50); }, 3000);

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', lastSync: readMeta().last_reddit_sync, uptime: process.uptime() });
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });

  let local = readTable('games')
    .filter(g => g.title?.toLowerCase().includes(q))
    .sort((a, b) => (a.title?.toLowerCase() === q ? 0 : 1) - (b.title?.toLowerCase() === q ? 0 : 1) || (b.release_timestamp || 0) - (a.release_timestamp || 0))
    .slice(0, 10);

  if (local.length > 0) return res.json({ results: local.map(formatGameRow), source: 'db' });

  const igdbResults = await igdbSearch(q, 5);
  const formatted = igdbResults.map(g => {
    const fmt = formatIgdbGame(g);
    const crackInfo = dbFindGame(dg => dg.igdb_id === g.id);
    return { ...fmt, status: crackInfo?.status || 'unknown', cracked_date: crackInfo?.cracked_date || null, crack_group: crackInfo?.crack_group || null, days_to_crack: crackInfo?.days_to_crack || null, drm: crackInfo?.drm || null, reddit_post_url: crackInfo?.reddit_post_url || null };
  });
  for (const g of formatted) { if (!dbFindGame(dg => dg.igdb_id === g.igdb_id)) dbUpsertGame(g); }
  res.json({ results: formatted, source: 'igdb' });
});

app.get('/api/game/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const game = dbFindGame(g => g.id === id || g.igdb_id === id);
  if (!game) return res.status(404).json({ error: 'Not found' });
  res.json(formatGameRow(game));
});

app.get('/api/news', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const tag = req.query.tag;
  let news = readTable('news');
  if (tag) news = news.filter(n => n.tag === tag);
  res.json({ news: news.sort((a, b) => (b.created_utc || 0) - (a.created_utc || 0)).slice(0, limit), count: news.length });
});

app.get('/api/recent-cracks', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const games = readTable('games').filter(g => g.status === 'cracked' && g.cracked_date).sort((a, b) => b.cracked_date?.localeCompare(a.cracked_date)).slice(0, limit);
  res.json({ games: games.map(formatGameRow) });
});

app.get('/api/uncracked', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const games = readTable('games').filter(g => g.status === 'uncracked').sort((a, b) => (b.release_timestamp || 0) - (a.release_timestamp || 0)).slice(0, limit);
  res.json({ games: games.map(formatGameRow) });
});

app.get('/api/stats', (req, res) => {
  const games = readTable('games');
  const cracked = games.filter(g => g.status === 'cracked').length;
  const uncracked = games.filter(g => g.status === 'uncracked').length;
  const withDays = games.filter(g => g.days_to_crack > 0 && g.days_to_crack < 3000);
  const avgDaysToCrack = withDays.length ? Math.round(withDays.reduce((s, g) => s + g.days_to_crack, 0) / withDays.length) : null;
  const sorted = [...withDays].sort((a, b) => a.days_to_crack - b.days_to_crack);
  res.json({ total: games.length, cracked, uncracked, avgDaysToCrack, fastestCrack: sorted[0] || null, longestWait: sorted[sorted.length - 1] || null, lastSync: readMeta().last_reddit_sync || null });
});

app.post('/api/watchlist', (req, res) => {
  const { session_id, game_id } = req.body;
  if (!session_id || !game_id) return res.status(400).json({ error: 'Missing fields' });
  dbAddWatchlist(session_id, parseInt(game_id));
  res.json({ ok: true });
});

app.delete('/api/watchlist', (req, res) => {
  const { session_id, game_id } = req.body;
  dbRemoveWatchlist(session_id, parseInt(game_id));
  res.json({ ok: true });
});

app.get('/api/watchlist/:session_id', (req, res) => {
  res.json({ games: dbGetWatchlistGames(req.params.session_id).map(formatGameRow) });
});

app.get('/api/watchlist/:session_id/check', (req, res) => {
  const games = readTable('games');
  const newlyCracked = [];
  const updated = readTable('watchlist').map(w => {
    if (w.session_id !== req.params.session_id || w.notified) return w;
    const game = games.find(g => g.id === w.game_id);
    if (game?.status === 'cracked') { newlyCracked.push(game); return { ...w, notified: true }; }
    return w;
  });
  if (newlyCracked.length > 0) writeTable('watchlist', updated);
  res.json({ newlyCracked: newlyCracked.map(formatGameRow) });
});

app.post('/api/sync', async (req, res) => {
  res.json({ ok: true });
  await syncCrackWatch();
  await enrichWithIgdb(30);
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatGameRow(g) {
  const releaseTs = g.release_timestamp;
  const daysSinceRelease = releaseTs ? Math.round((Date.now() - releaseTs) / 86400000) : null;
  return { id: g.id, igdb_id: g.igdb_id, title: g.title, slug: g.slug, cover_url: g.cover_url, release_date: g.release_date, days_since_release: daysSinceRelease, platforms: g.platforms, genres: g.genres, summary: g.summary, status: g.status || 'unknown', cracked_date: g.cracked_date, crack_group: g.crack_group, days_to_crack: g.days_to_crack, drm: g.drm, reddit_post_url: g.reddit_post_url, reddit_post_title: g.reddit_post_title, updated_at: g.updated_at };
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 CrackTrack API running on port ${PORT}`));
