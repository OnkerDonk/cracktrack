const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'cracktrack.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    igdb_id INTEGER UNIQUE,
    title TEXT NOT NULL,
    slug TEXT,
    cover_url TEXT,
    release_date TEXT,
    release_timestamp INTEGER,
    platforms TEXT,
    genres TEXT,
    summary TEXT,
    status TEXT DEFAULT 'unknown',
    cracked_date TEXT,
    crack_group TEXT,
    days_to_crack INTEGER,
    reddit_post_url TEXT,
    reddit_post_title TEXT,
    drm TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reddit_id TEXT UNIQUE,
    title TEXT NOT NULL,
    body TEXT,
    url TEXT,
    author TEXT,
    score INTEGER DEFAULT 0,
    tag TEXT,
    created_utc INTEGER,
    fetched_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    game_id INTEGER NOT NULL,
    added_at TEXT DEFAULT (datetime('now')),
    notified INTEGER DEFAULT 0,
    UNIQUE(session_id, game_id)
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ─── IGDB API ─────────────────────────────────────────────────────────────────
let igdbToken = null;
let igdbTokenExpiry = 0;

async function getIgdbToken() {
  if (igdbToken && Date.now() < igdbTokenExpiry) return igdbToken;
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn('IGDB credentials not set — game metadata will be limited');
    return null;
  }
  try {
    const res = await axios.post(
      `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`
    );
    igdbToken = res.data.access_token;
    igdbTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return igdbToken;
  } catch (e) {
    console.error('IGDB auth failed:', e.message);
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
      {
        headers: {
          'Client-ID': process.env.IGDB_CLIENT_ID,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain'
        }
      }
    );
    return res.data;
  } catch (e) {
    console.error('IGDB search error:', e.message);
    return [];
  }
}

async function igdbGetById(igdbId) {
  const token = await getIgdbToken();
  if (!token) return null;
  try {
    const res = await axios.post(
      'https://api.igdb.com/v4/games',
      `fields name,slug,cover.url,first_release_date,platforms.name,genres.name,summary;
       where id = ${igdbId};`,
      {
        headers: {
          'Client-ID': process.env.IGDB_CLIENT_ID,
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'text/plain'
        }
      }
    );
    return res.data[0] || null;
  } catch (e) {
    return null;
  }
}

function formatIgdbGame(g) {
  const releaseTs = g.first_release_date ? g.first_release_date * 1000 : null;
  const releaseDate = releaseTs ? new Date(releaseTs).toISOString().split('T')[0] : null;
  const coverUrl = g.cover?.url
    ? 'https:' + g.cover.url.replace('t_thumb', 't_cover_big')
    : null;
  return {
    igdb_id: g.id,
    title: g.name,
    slug: g.slug,
    cover_url: coverUrl,
    release_date: releaseDate,
    release_timestamp: releaseTs,
    platforms: g.platforms ? g.platforms.map(p => p.name).join(', ') : null,
    genres: g.genres ? g.genres.map(g => g.name).join(', ') : null,
    summary: g.summary || null,
  };
}

// ─── REDDIT r/CRACKWATCH ──────────────────────────────────────────────────────
// Parse post titles like:
// "[CRACKED] Game Name (Denuvo) - SCENE / EMPRESS"
// "[STATUS UPDATE] Game Name - DRM Removed"
// "[UNCRACKED] Game Name - 365 Days"

const CRACK_PATTERNS = [
  /^\[CRACKED\]\s*(.+?)(?:\s*[\(\[].+[\)\]])?\s*[-–]\s*(.+)$/i,
  /^\[CRACKED\]\s*(.+)$/i,
  /^(.+?)\s+(?:has been |is now )?cracked\s+by\s+(.+)$/i,
  /^(.+?)\s*[-–]\s*cracked$/i,
];

const UNCRACKED_PATTERNS = [
  /^\[UNCRACKED\]\s*(.+)/i,
  /^\[STATUS\]\s*(.+)/i,
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

function parseRedditPost(post) {
  const title = post.title || '';
  const flair = (post.link_flair_text || '').toUpperCase();
  let status = 'unknown';
  let gameName = null;
  let crackGroup = null;

  // Check flair first
  if (flair.includes('CRACKED') || flair.includes('SCENE')) status = 'cracked';
  else if (flair.includes('UNCRACKED') || flair.includes('DENUVO')) status = 'uncracked';
  else if (flair.includes('NEWS') || flair.includes('DISCUSSION')) status = 'news';

  // Try crack patterns
  for (const pattern of CRACK_PATTERNS) {
    const m = title.match(pattern);
    if (m) {
      gameName = m[1]?.trim();
      crackGroup = m[2]?.trim();
      status = 'cracked';
      break;
    }
  }

  // Try uncracked patterns
  if (!gameName) {
    for (const pattern of UNCRACKED_PATTERNS) {
      const m = title.match(pattern);
      if (m) {
        gameName = m[1]?.trim();
        status = 'uncracked';
        break;
      }
    }
  }

  // Fallback: use full title as game name
  if (!gameName) gameName = title.replace(/^\[.*?\]\s*/, '').trim();

  // Detect DRM
  let drm = null;
  const fullText = title + ' ' + (post.selftext || '');
  for (const [name, pattern] of Object.entries(DRM_PATTERNS)) {
    if (pattern.test(fullText)) { drm = name; break; }
  }

  const createdDate = post.created_utc
    ? new Date(post.created_utc * 1000).toISOString().split('T')[0]
    : null;

  // Determine news tag
  let tag = 'scene';
  if (flair.includes('CRACK')) tag = 'release';
  else if (drm) tag = 'drm';
  else if (title.match(/update|patch/i)) tag = 'update';
  else if (title.match(/bypass|remove/i)) tag = 'bypass';

  return { gameName, status, crackGroup, drm, createdDate, tag };
}

async function fetchCrackWatchPosts(sort = 'new', limit = 100) {
  try {
    const url = `https://www.reddit.com/r/CrackWatch/${sort}.json?limit=${limit}&t=month`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'CrackTrack/1.0 (crack status tracker app)' },
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
  const [newPosts, hotPosts] = await Promise.all([
    fetchCrackWatchPosts('new', 100),
    fetchCrackWatchPosts('hot', 50),
  ]);

  const allPosts = [...newPosts, ...hotPosts];
  const seen = new Set();
  const unique = allPosts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  let crackedCount = 0;
  let newsCount = 0;

  for (const post of unique) {
    const parsed = parseRedditPost(post);
    const postUrl = `https://reddit.com${post.permalink}`;
    const postDate = post.created_utc
      ? new Date(post.created_utc * 1000).toISOString().split('T')[0]
      : null;

    // Save to news table
    try {
      db.prepare(`
        INSERT OR REPLACE INTO news (reddit_id, title, body, url, author, score, tag, created_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        post.id,
        post.title,
        (post.selftext || '').slice(0, 2000),
        postUrl,
        post.author,
        post.score || 0,
        parsed.tag,
        post.created_utc || 0
      );
      newsCount++;
    } catch {}

    // If it's a cracked game, update or insert into games table
    if (parsed.status === 'cracked' && parsed.gameName && parsed.gameName.length > 2) {
      try {
        const existing = db.prepare(
          'SELECT * FROM games WHERE LOWER(title) = LOWER(?)'
        ).get(parsed.gameName);

        if (existing) {
          if (existing.status !== 'cracked') {
            const releaseTs = existing.release_timestamp;
            const crackTs = post.created_utc ? post.created_utc * 1000 : Date.now();
            const daysToCrack = releaseTs
              ? Math.round((crackTs - releaseTs) / 86400000)
              : null;

            db.prepare(`
              UPDATE games SET
                status = 'cracked',
                cracked_date = ?,
                crack_group = ?,
                days_to_crack = ?,
                reddit_post_url = ?,
                reddit_post_title = ?,
                drm = COALESCE(?, drm),
                updated_at = datetime('now')
              WHERE id = ?
            `).run(postDate, parsed.crackGroup, daysToCrack, postUrl, post.title, parsed.drm, existing.id);
            crackedCount++;
          }
        } else {
          // New game not in DB yet — insert with crack info, IGDB sync happens separately
          db.prepare(`
            INSERT OR IGNORE INTO games (title, status, cracked_date, crack_group, reddit_post_url, reddit_post_title, drm)
            VALUES (?, 'cracked', ?, ?, ?, ?, ?)
          `).run(parsed.gameName, postDate, parsed.crackGroup, postUrl, post.title, parsed.drm);
          crackedCount++;
        }
      } catch (e) {
        console.error('DB insert error:', e.message);
      }
    }
  }

  db.prepare("INSERT OR REPLACE INTO meta VALUES ('last_reddit_sync', ?)").run(new Date().toISOString());
  console.log(`✅ Reddit sync done: ${crackedCount} crack updates, ${newsCount} news items`);
}

async function enrichWithIgdb(limit = 20) {
  if (!process.env.IGDB_CLIENT_ID) return;
  console.log('🎮 Enriching games with IGDB metadata...');
  const games = db.prepare(
    "SELECT * FROM games WHERE igdb_id IS NULL AND title IS NOT NULL LIMIT ?"
  ).all(limit);

  for (const game of games) {
    await new Promise(r => setTimeout(r, 300)); // rate limit
    const results = await igdbSearch(game.title, 3);
    if (results.length > 0) {
      const best = results[0];
      const fmt = formatIgdbGame(best);
      const releaseTs = fmt.release_timestamp;
      const crackedTs = game.cracked_date ? new Date(game.cracked_date).getTime() : null;
      const daysToCrack = (releaseTs && crackedTs)
        ? Math.round((crackedTs - releaseTs) / 86400000)
        : game.days_to_crack;

      db.prepare(`
        UPDATE games SET
          igdb_id = ?, slug = ?, cover_url = ?, release_date = ?,
          release_timestamp = ?, platforms = ?, genres = ?, summary = ?,
          days_to_crack = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(
        fmt.igdb_id, fmt.slug, fmt.cover_url, fmt.release_date,
        fmt.release_timestamp, fmt.platforms, fmt.genres, fmt.summary,
        daysToCrack, game.id
      );
    }
  }
  console.log(`✅ IGDB enrichment done for ${games.length} games`);
}

// ─── SCHEDULED JOBS ───────────────────────────────────────────────────────────
// Sync Reddit every 2 hours
cron.schedule('0 */2 * * *', async () => {
  await syncCrackWatch();
  await enrichWithIgdb(30);
});

// Initial sync on startup
setTimeout(async () => {
  await syncCrackWatch();
  await enrichWithIgdb(50);
}, 3000);

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// GET /api/search?q=game+name
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  // Search local DB first
  const local = db.prepare(`
    SELECT * FROM games
    WHERE title LIKE ? OR title LIKE ?
    ORDER BY
      CASE WHEN LOWER(title) = LOWER(?) THEN 0 ELSE 1 END,
      release_timestamp DESC NULLS LAST
    LIMIT 10
  `).all(`%${q}%`, `${q}%`, q);

  if (local.length > 0) {
    return res.json({ results: local.map(formatGameRow), source: 'db' });
  }

  // Fall back to IGDB live search
  const igdbResults = await igdbSearch(q, 5);
  const formatted = igdbResults.map(g => {
    const fmt = formatIgdbGame(g);
    // Check if we have crack info for this game
    const crackInfo = db.prepare('SELECT * FROM games WHERE igdb_id = ?').get(g.id);
    return {
      ...fmt,
      status: crackInfo?.status || 'unknown',
      cracked_date: crackInfo?.cracked_date || null,
      crack_group: crackInfo?.crack_group || null,
      days_to_crack: crackInfo?.days_to_crack || null,
      drm: crackInfo?.drm || null,
      reddit_post_url: crackInfo?.reddit_post_url || null,
    };
  });

  // Cache in DB
  for (const g of formatted) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO games (igdb_id, title, slug, cover_url, release_date, release_timestamp, platforms, genres, summary, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(g.igdb_id, g.title, g.slug, g.cover_url, g.release_date, g.release_timestamp, g.platforms, g.genres, g.summary, g.status || 'unknown');
    } catch {}
  }

  res.json({ results: formatted, source: 'igdb' });
});

// GET /api/game/:id
app.get('/api/game/:id', async (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id = ? OR igdb_id = ?')
    .get(req.params.id, req.params.id);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(formatGameRow(game));
});

// GET /api/news?limit=20&tag=release
app.get('/api/news', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const tag = req.query.tag;
  let query = 'SELECT * FROM news';
  const params = [];
  if (tag) { query += ' WHERE tag = ?'; params.push(tag); }
  query += ' ORDER BY created_utc DESC LIMIT ?';
  params.push(limit);
  const news = db.prepare(query).all(...params);
  res.json({ news, count: news.length });
});

// GET /api/recent-cracks?limit=20
app.get('/api/recent-cracks', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const games = db.prepare(`
    SELECT * FROM games WHERE status = 'cracked' AND cracked_date IS NOT NULL
    ORDER BY cracked_date DESC LIMIT ?
  `).all(limit);
  res.json({ games: games.map(formatGameRow) });
});

// GET /api/uncracked?limit=20
app.get('/api/uncracked', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const games = db.prepare(`
    SELECT * FROM games WHERE status = 'uncracked'
    ORDER BY release_timestamp DESC NULLS LAST LIMIT ?
  `).all(limit);
  res.json({ games: games.map(formatGameRow) });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const total = db.prepare("SELECT COUNT(*) as n FROM games").get().n;
  const cracked = db.prepare("SELECT COUNT(*) as n FROM games WHERE status='cracked'").get().n;
  const uncracked = db.prepare("SELECT COUNT(*) as n FROM games WHERE status='uncracked'").get().n;
  const avgDays = db.prepare("SELECT AVG(days_to_crack) as avg FROM games WHERE days_to_crack > 0 AND days_to_crack < 3000").get().avg;
  const fastestCrack = db.prepare("SELECT title, days_to_crack FROM games WHERE days_to_crack >= 0 ORDER BY days_to_crack ASC LIMIT 1").get();
  const longestWait = db.prepare("SELECT title, days_to_crack FROM games WHERE days_to_crack > 0 ORDER BY days_to_crack DESC LIMIT 1").get();
  const lastSync = db.prepare("SELECT value FROM meta WHERE key='last_reddit_sync'").get();
  res.json({
    total, cracked, uncracked,
    avgDaysToCrack: avgDays ? Math.round(avgDays) : null,
    fastestCrack, longestWait,
    lastSync: lastSync?.value || null,
  });
});

// POST /api/watchlist  { session_id, game_id }
app.post('/api/watchlist', (req, res) => {
  const { session_id, game_id } = req.body;
  if (!session_id || !game_id) return res.status(400).json({ error: 'Missing fields' });
  try {
    db.prepare('INSERT OR IGNORE INTO watchlist (session_id, game_id) VALUES (?, ?)').run(session_id, game_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/watchlist  { session_id, game_id }
app.delete('/api/watchlist', (req, res) => {
  const { session_id, game_id } = req.body;
  db.prepare('DELETE FROM watchlist WHERE session_id = ? AND game_id = ?').run(session_id, game_id);
  res.json({ ok: true });
});

// GET /api/watchlist/:session_id
app.get('/api/watchlist/:session_id', (req, res) => {
  const games = db.prepare(`
    SELECT g.*, w.added_at, w.notified FROM watchlist w
    JOIN games g ON g.id = w.game_id
    WHERE w.session_id = ?
    ORDER BY w.added_at DESC
  `).all(req.params.session_id);
  res.json({ games: games.map(formatGameRow) });
});

// GET /api/watchlist/:session_id/check — check if any watched games got cracked
app.get('/api/watchlist/:session_id/check', (req, res) => {
  const newlyCracked = db.prepare(`
    SELECT g.*, w.id as watch_id FROM watchlist w
    JOIN games g ON g.id = w.game_id
    WHERE w.session_id = ? AND g.status = 'cracked' AND w.notified = 0
  `).all(req.params.session_id);

  if (newlyCracked.length > 0) {
    const ids = newlyCracked.map(g => g.watch_id);
    db.prepare(`UPDATE watchlist SET notified = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }

  res.json({ newlyCracked: newlyCracked.map(formatGameRow) });
});

// GET /api/sync — manual trigger
app.post('/api/sync', async (req, res) => {
  res.json({ ok: true, message: 'Sync started in background' });
  await syncCrackWatch();
  await enrichWithIgdb(30);
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatGameRow(g) {
  const now = Date.now();
  const releaseTs = g.release_timestamp;
  const daysSinceRelease = releaseTs ? Math.round((now - releaseTs) / 86400000) : null;
  return {
    id: g.id,
    igdb_id: g.igdb_id,
    title: g.title,
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
    updated_at: g.updated_at,
  };
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 CrackTrack API running on port ${PORT}`));
