const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ─── JSON DATABASE ────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data');
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });

function readTable(name) {
  const file = path.join(DB_PATH, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeTable(name, data) {
  fs.writeFileSync(path.join(DB_PATH, `${name}.json`), JSON.stringify(data, null, 2));
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

// Fetch a page of PC games released between two Unix timestamps from IGDB
async function igdbFetchPage(afterTs, beforeTs, offset = 0, limit = 500) {
  const token = await getIgdbToken();
  if (!token) return [];
  try {
    const res = await axios.post(
      'https://api.igdb.com/v4/games',
      `fields name,slug,cover.url,first_release_date,platforms.name,genres.name,summary;
       where platforms = (6) & version_parent = null
         & first_release_date >= ${Math.floor(afterTs / 1000)}
         & first_release_date <= ${Math.floor(beforeTs / 1000)}
         & first_release_date != null
         & category = 0;
       sort first_release_date desc;
       limit ${limit};
       offset ${offset};`,
      { headers: { 'Client-ID': process.env.IGDB_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' } }
    );
    return res.data || [];
  } catch (e) {
    console.error('IGDB bulk fetch error:', e.message);
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

// ─── BULK HISTORICAL IGDB IMPORT (10 years) ───────────────────────────────────
// Runs once on first startup, then never again. Fetches all PC games from
// Jan 2015 to now in yearly chunks so we don't slam the API.

async function bulkImportHistory() {
  const meta = readMeta();
  if (meta.history_imported) {
    console.log('📚 Historical import already done, skipping');
    return;
  }
  if (!process.env.IGDB_CLIENT_ID) {
    console.warn('⚠️  Skipping historical import — no IGDB credentials');
    return;
  }

  console.log('📚 Starting 10-year historical IGDB import...');
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - 10; // go back 10 years
  let totalImported = 0;

  for (let year = currentYear; year >= startYear; year--) {
    const afterTs = new Date(`${year}-01-01T00:00:00Z`).getTime();
    const beforeTs = new Date(`${year}-12-31T23:59:59Z`).getTime();

    console.log(`  📅 Fetching ${year}...`);
    let offset = 0;
    let pageCount = 0;

    // IGDB max limit is 500, paginate up to 3 pages per year (1500 games/year max)
    while (pageCount < 3) {
      await new Promise(r => setTimeout(r, 500)); // rate limit: 4 req/sec max
      const page = await igdbFetchPage(afterTs, beforeTs, offset, 500);
      if (!page.length) break;

      for (const g of page) {
        const fmt = formatIgdbGame(g);
        // Only insert if not already in DB — don't overwrite crack info
        const existing = dbFindGame(dg => dg.igdb_id === fmt.igdb_id);
        if (!existing) {
          dbUpsertGame({ ...fmt, status: 'unknown' });
          totalImported++;
        }
      }

      if (page.length < 500) break; // last page
      offset += 500;
      pageCount++;
    }
  }

  meta.history_imported = true;
  meta.history_import_date = new Date().toISOString();
  meta.history_total = totalImported;
  writeMeta(meta);
  console.log(`✅ Historical import complete: ${totalImported} games added`);
}

// ─── REDDIT r/CrackWatch PARSER ───────────────────────────────────────────────
const CRACK_PATTERNS = [
  /^\[CRACKED\]\s*(.+?)(?:\s*[\(\[].+[\)\]])?\s*[-–]\s*(.+)$/i,
  /^\[CRACKED\]\s*(.+)$/i,
  /^(.+?)\s+(?:has been |is now )?cracked\s+by\s+(.+)$/i,
  /^(.+?)\s*[-–]\s*cracked$/i,
];
const UNCRACKED_PATTERNS = [/^\[UNCRACKED\]\s*(.+)/i, /^\[STATUS\]\s*(.+)/i];

// NEW: Hypervisor bypass patterns — posts about VM/hypervisor DRM bypasses
const HYPERVISOR_PATTERNS = [
  /hypervisor/i,
  /hyper-?v/i,
  /vm\s*bypass/i,
  /virtual\s*machine\s*bypass/i,
  /vmware.*bypass/i,
  /bypass.*hypervisor/i,
  /anti[\s-]?vm.*bypass/i,
  /\[hypervisor\s*bypass\]/i,
  /hv\s*bypass/i,
];

const DRM_PATTERNS = {
  'Denuvo': /denuvo/i,
  'Steam DRM': /steam\s*drm/i,
  'EGS DRM': /epic\s*game|egs/i,
  'VMProtect': /vmprotect/i,
  'Arxan': /arxan/i,
  'Enigma': /enigma/i,
  'FADE': /fade/i,
};

// Extract a clean scene filename from a Reddit post title
// Scene filenames look like: Game.Name.v1.0-GROUPNAME or Game_Name-SKIDROW
function extractSceneFilename(title) {
  // Match typical scene release name patterns
  const scenePattern = /([A-Za-z0-9._-]{10,}(?:v[\d.]+|Build[\d]+|Update|DLC|REPACK|FitGirl|EMPRESS|SKIDROW|CODEX|PLAZA|CPY|RUNE|TiNYiSO|P2P|GOG|MULTI\d+)[A-Za-z0-9._-]*)/i;
  const m = title.match(scenePattern);
  if (m) return m[1];

  // Fallback: anything after a dash that looks like a group tag
  const groupPattern = /[-–]\s*([A-Z0-9]{3,12})\s*$/;
  const gm = title.match(groupPattern);
  if (gm) return gm[1];

  return null;
}

function parseRedditPost(post) {
  const title = post.title || '';
  const flair = (post.link_flair_text || '').toUpperCase();
  const selftext = post.selftext || '';
  const fullText = title + ' ' + selftext;

  let status = 'unknown', gameName = null, crackGroup = null;

  // Check for hypervisor bypass FIRST (highest priority check)
  const isHypervisorBypass = HYPERVISOR_PATTERNS.some(p => p.test(fullText)) ||
    flair.includes('HYPERVISOR') || flair.includes('HV BYPASS');

  if (isHypervisorBypass) {
    status = 'hypervisor_bypass';
    // Still try to extract game name
    gameName = title.replace(/^\[.*?\]\s*/, '').replace(/hypervisor\s*bypass/i, '').replace(/[-–].*$/, '').trim();
  } else {
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
  }

  let drm = null;
  for (const [name, pattern] of Object.entries(DRM_PATTERNS)) {
    if (pattern.test(fullText)) { drm = name; break; }
  }

  const sceneFilename = extractSceneFilename(title);
  const createdDate = post.created_utc ? new Date(post.created_utc * 1000).toISOString().split('T')[0] : null;

  // News tag
  let tag = 'scene';
  if (isHypervisorBypass) tag = 'bypass';
  else if (flair.includes('CRACK') || status === 'cracked') tag = 'release';
  else if (drm) tag = 'drm';
  else if (/update|patch/i.test(title)) tag = 'update';
  else if (/bypass|remove/i.test(title)) tag = 'bypass';

  return { gameName, status, crackGroup, drm, sceneFilename, createdDate, tag, isHypervisorBypass };
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

// Also search Reddit specifically for hypervisor bypass posts
async function fetchHypervisorPosts() {
  try {
    const res = await axios.get(
      `https://www.reddit.com/r/CrackWatch/search.json?q=hypervisor+bypass&restrict_sr=1&sort=new&limit=50`,
      { headers: { 'User-Agent': 'CrackTrack/1.0 (game crack status tracker)' }, timeout: 15000 }
    );
    return res.data?.data?.children?.map(c => c.data) || [];
  } catch (e) {
    console.error('Hypervisor search error:', e.message);
    return [];
  }
}

async function syncCrackWatch() {
  console.log('🔄 Syncing r/CrackWatch...');
  const [newPosts, hotPosts, hvPosts] = await Promise.all([
    fetchRedditPosts('new', 100),
    fetchRedditPosts('hot', 50),
    fetchHypervisorPosts(),
  ]);

  const seen = new Set();
  const unique = [...newPosts, ...hotPosts, ...hvPosts].filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id); return true;
  });

  let crackedCount = 0, newsCount = 0, hvCount = 0;

  for (const post of unique) {
    const parsed = parseRedditPost(post);
    const postUrl = `https://reddit.com${post.permalink}`;
    const postDate = post.created_utc ? new Date(post.created_utc * 1000).toISOString().split('T')[0] : null;

    // Save to news table
    try {
      dbUpsertNews({
        reddit_id: post.id,
        title: post.title,
        body: (post.selftext || '').slice(0, 2000),
        url: postUrl,
        author: post.author,
        score: post.score || 0,
        tag: parsed.tag,
        created_utc: post.created_utc || 0,
        is_hypervisor: parsed.isHypervisorBypass,
      });
      newsCount++;
    } catch {}

    // Handle hypervisor bypass posts
    if (parsed.isHypervisorBypass && parsed.gameName?.length > 2) {
      try {
        const existing = dbFindGame(g => g.title?.toLowerCase() === parsed.gameName.toLowerCase());
        if (existing) {
          dbUpsertGame({
            ...existing,
            status: 'hypervisor_bypass',
            hypervisor_post_url: postUrl,
            hypervisor_post_title: post.title,
            drm: parsed.drm || existing.drm,
            scene_filename: parsed.sceneFilename || existing.scene_filename,
          });
        } else {
          dbUpsertGame({
            title: parsed.gameName,
            status: 'hypervisor_bypass',
            hypervisor_post_url: postUrl,
            hypervisor_post_title: post.title,
            drm: parsed.drm,
            scene_filename: parsed.sceneFilename,
          });
        }
        hvCount++;
      } catch (e) { console.error('HV upsert error:', e.message); }
    }

    // Handle cracked games
    if (parsed.status === 'cracked' && parsed.gameName?.length > 2) {
      try {
        const existing = dbFindGame(g => g.title?.toLowerCase() === parsed.gameName.toLowerCase());
        const crackTs = post.created_utc ? post.created_utc * 1000 : Date.now();
        if (existing) {
          if (existing.status !== 'cracked') {
            const daysToCrack = existing.release_timestamp ? Math.round((crackTs - existing.release_timestamp) / 86400000) : null;
            dbUpsertGame({
              ...existing,
              status: 'cracked',
              cracked_date: postDate,
              crack_group: parsed.crackGroup,
              days_to_crack: daysToCrack,
              reddit_post_url: postUrl,
              reddit_post_title: post.title,
              scene_filename: parsed.sceneFilename || existing.scene_filename,
              drm: parsed.drm || existing.drm,
            });
            crackedCount++;
          }
        } else {
          dbUpsertGame({
            title: parsed.gameName,
            status: 'cracked',
            cracked_date: postDate,
            crack_group: parsed.crackGroup,
            reddit_post_url: postUrl,
            reddit_post_title: post.title,
            scene_filename: parsed.sceneFilename,
            drm: parsed.drm,
          });
          crackedCount++;
        }
      } catch (e) { console.error('Game upsert error:', e.message); }
    }

    // Handle uncracked games
    if (parsed.status === 'uncracked' && parsed.gameName?.length > 2) {
      const existing = dbFindGame(g => g.title?.toLowerCase() === parsed.gameName.toLowerCase());
      if (!existing) {
        dbUpsertGame({ title: parsed.gameName, status: 'uncracked', drm: parsed.drm, reddit_post_url: postUrl, scene_filename: parsed.sceneFilename });
      }
    }
  }

  const meta = readMeta();
  meta.last_reddit_sync = new Date().toISOString();
  writeMeta(meta);
  console.log(`✅ Sync done: ${crackedCount} cracks, ${hvCount} hypervisor bypasses, ${newsCount} news items`);
}

async function enrichWithIgdb(batchSize = 20) {
  if (!process.env.IGDB_CLIENT_ID) return;
  const games = readTable('games').filter(g => !g.igdb_id && g.title).slice(0, batchSize);
  if (!games.length) return;
  console.log(`🎮 Enriching ${games.length} games with IGDB metadata...`);
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
  console.log(`✅ IGDB enrichment done`);
}

// ─── SCHEDULED JOBS ───────────────────────────────────────────────────────────
cron.schedule('0 */2 * * *', async () => { await syncCrackWatch(); await enrichWithIgdb(30); });

// Startup sequence — history import first (one-time), then live sync
setTimeout(async () => {
  await syncCrackWatch();          // fast — gets latest Reddit posts
  await enrichWithIgdb(50);
  await bulkImportHistory();       // slow — runs once, imports 10 years of IGDB data
}, 3000);

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const meta = readMeta();
  res.json({ status: 'ok', lastSync: meta.last_reddit_sync, historyImported: !!meta.history_imported, historyTotal: meta.history_total, uptime: process.uptime() });
});

// GET /api/search?q=
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });

  // Search all games in DB (now includes 10 years of history)
  let local = readTable('games')
    .filter(g => g.title?.toLowerCase().includes(q))
    .sort((a, b) =>
      (a.title?.toLowerCase() === q ? 0 : 1) - (b.title?.toLowerCase() === q ? 0 : 1) ||
      (b.release_timestamp || 0) - (a.release_timestamp || 0)
    )
    .slice(0, 15);

  if (local.length > 0) return res.json({ results: local.map(formatGameRow), source: 'db' });

  // Live IGDB fallback
  const igdbResults = await igdbSearch(q, 5);
  const formatted = igdbResults.map(g => {
    const fmt = formatIgdbGame(g);
    const crackInfo = dbFindGame(dg => dg.igdb_id === g.id);
    return {
      ...fmt,
      status: crackInfo?.status || 'unknown',
      cracked_date: crackInfo?.cracked_date || null,
      crack_group: crackInfo?.crack_group || null,
      days_to_crack: crackInfo?.days_to_crack || null,
      drm: crackInfo?.drm || null,
      reddit_post_url: crackInfo?.reddit_post_url || null,
      hypervisor_post_url: crackInfo?.hypervisor_post_url || null,
      scene_filename: crackInfo?.scene_filename || null,
    };
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
  if (tag === 'bypass') news = news.filter(n => n.tag === 'bypass' || n.is_hypervisor);
  else if (tag) news = news.filter(n => n.tag === tag);
  res.json({ news: news.sort((a, b) => (b.created_utc || 0) - (a.created_utc || 0)).slice(0, limit) });
});

// Only show 20 most recent on homepage — full history available via search
app.get('/api/recent-cracks', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const games = readTable('games')
    .filter(g => g.status === 'cracked' && g.cracked_date)
    .sort((a, b) => b.cracked_date?.localeCompare(a.cracked_date))
    .slice(0, limit);
  res.json({ games: games.map(formatGameRow) });
});

app.get('/api/uncracked', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const games = readTable('games')
    .filter(g => g.status === 'uncracked')
    .sort((a, b) => (b.release_timestamp || 0) - (a.release_timestamp || 0))
    .slice(0, limit);
  res.json({ games: games.map(formatGameRow) });
});

// NEW: Hypervisor bypass games endpoint
app.get('/api/hypervisor', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const games = readTable('games')
    .filter(g => g.status === 'hypervisor_bypass')
    .sort((a, b) => (b.release_timestamp || 0) - (a.release_timestamp || 0))
    .slice(0, limit);
  res.json({ games: games.map(formatGameRow) });
});

app.get('/api/stats', (req, res) => {
  const games = readTable('games');
  const cracked = games.filter(g => g.status === 'cracked').length;
  const uncracked = games.filter(g => g.status === 'uncracked').length;
  const hypervisor = games.filter(g => g.status === 'hypervisor_bypass').length;
  const withDays = games.filter(g => g.days_to_crack > 0 && g.days_to_crack < 3000);
  const avgDaysToCrack = withDays.length ? Math.round(withDays.reduce((s, g) => s + g.days_to_crack, 0) / withDays.length) : null;
  const sorted = [...withDays].sort((a, b) => a.days_to_crack - b.days_to_crack);
  const meta = readMeta();
  res.json({
    total: games.length, cracked, uncracked, hypervisor, avgDaysToCrack,
    fastestCrack: sorted[0] || null,
    longestWait: sorted[sorted.length - 1] || null,
    lastSync: meta.last_reddit_sync || null,
    historyImported: !!meta.history_imported,
  });
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
  const newlyCracked = [], newlyBypassed = [];
  const updated = readTable('watchlist').map(w => {
    if (w.session_id !== req.params.session_id || w.notified) return w;
    const game = games.find(g => g.id === w.game_id);
    if (game?.status === 'cracked') { newlyCracked.push(game); return { ...w, notified: true }; }
    if (game?.status === 'hypervisor_bypass') { newlyBypassed.push(game); return { ...w, notified: true }; }
    return w;
  });
  if (newlyCracked.length + newlyBypassed.length > 0) writeTable('watchlist', updated);
  res.json({ newlyCracked: newlyCracked.map(formatGameRow), newlyBypassed: newlyBypassed.map(formatGameRow) });
});

async function runSync(res) {
  res.json({ ok: true, message: 'Sync started — check /api/health in a minute to confirm' });
  await syncCrackWatch();
  await enrichWithIgdb(30);
}
app.post('/api/sync', (req, res) => runSync(res));
app.get('/api/sync', (req, res) => runSync(res));

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatGameRow(g) {
  const releaseTs = g.release_timestamp;
  const daysSinceRelease = releaseTs ? Math.round((Date.now() - releaseTs) / 86400000) : null;
  return {
    id: g.id,
    igdb_id: g.igdb_id,
    title: g.title,                          // clean IGDB game name
    scene_filename: g.scene_filename || null, // raw scene release filename
    slug: g.slug,
    cover_url: g.cover_url,
    release_date: g.release_date,
    days_since_release: daysSinceRelease,
    platforms: g.platforms,
    genres: g.genres,
    summary: g.summary,
    status: g.status || 'unknown',
    cracked_date: g.cracked_date,
    crack_group: g.crack_group,
    days_to_crack: g.days_to_crack,
    drm: g.drm,
    reddit_post_url: g.reddit_post_url,
    reddit_post_title: g.reddit_post_title,
    hypervisor_post_url: g.hypervisor_post_url || null,
    hypervisor_post_title: g.hypervisor_post_title || null,
    updated_at: g.updated_at,
  };
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 CrackTrack API running on port ${PORT}`));
