const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const cron     = require('node-cron');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// Start HTTP immediately so Render detects the port
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

let dbReady = false;

// ── SCHEMA ────────────────────────────────────────────────────────────────────
// One simple collection. Each doc = one game.
const gameSchema = new mongoose.Schema({
  igdb_id:          { type: Number, unique: true, sparse: true },
  title:            { type: String, required: true },
  title_lower:      String,
  cover_url:        String,
  release_date:     String,   // "2024-03-15" or null
  release_status:   { type: String, default: 'released' }, // 'released' | 'unreleased' | 'tba'
  release_timestamp:Number,
  steam_url:        String,   // e.g. https://store.steampowered.com/app/1234
  websites:         [String], // raw website URLs from IGDB
  genres:           String,
  // Crack info — updated by Reddit sync
  crack_status:     { type: String, default: 'uncracked' }, // 'uncracked' | 'cracked' | 'hypervisor'
  crack_group:      String,
  cracked_date:     String,
  days_to_crack:    Number,
  crack_source_url: String,   // Reddit post URL
}, { timestamps: true });

gameSchema.index({ title_lower: 1 });
gameSchema.index({ release_timestamp: -1 });
gameSchema.index({ crack_status: 1 });

const Game = mongoose.model('Game', gameSchema);

// ── IGDB ──────────────────────────────────────────────────────────────────────
let igdbToken = null, igdbExpiry = 0;

async function getToken() {
  if (igdbToken && Date.now() < igdbExpiry) return igdbToken;
  const { IGDB_CLIENT_ID: id, IGDB_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) { console.warn('No IGDB creds'); return null; }
  const r = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`);
  igdbToken  = r.data.access_token;
  igdbExpiry = Date.now() + (r.data.expires_in - 60) * 1000;
  return igdbToken;
}

async function igdbQuery(body) {
  const token = await getToken();
  if (!token) return [];
  try {
    const r = await axios.post('https://api.igdb.com/v4/games', body, {
      headers: { 'Client-ID': process.env.IGDB_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' }
    });
    return r.data || [];
  } catch (e) { console.error('IGDB error:', e.message); return []; }
}

// Extract the best available URL (prefer Steam)
function extractUrls(websites) {
  if (!websites || !websites.length) return { steam_url: null, websites: [] };
  const urls = websites.map(w => w.url).filter(Boolean);
  const steam = urls.find(u => u.includes('steampowered.com') || u.includes('store.steampowered'));
  return { steam_url: steam || null, websites: urls };
}

function parseIgdbGame(g) {
  const ts = g.first_release_date ? g.first_release_date * 1000 : null;
  const now = Date.now();
  let release_status = 'released';
  if (!ts) release_status = 'tba';
  else if (ts > now) release_status = 'unreleased';
  const { steam_url, websites } = extractUrls(g.websites);
  return {
    igdb_id:           g.id,
    title:             g.name,
    title_lower:       g.name?.toLowerCase(),
    cover_url:         g.cover?.url ? 'https:' + g.cover.url.replace('t_thumb', 't_cover_big') : null,
    release_date:      ts ? new Date(ts).toISOString().split('T')[0] : null,
    release_timestamp: ts,
    release_status,
    steam_url,
    websites,
    genres:            g.genres?.map(x => x.name).join(', ') || null,
  };
}

// ── IGDB BULK IMPORT ──────────────────────────────────────────────────────────
// Fetches all PC games released in the last 2 years + upcoming
async function bulkImport(force = false) {
  const meta = await Game.findOne({ igdb_id: -1 }); // use igdb_id=-1 as meta marker
  if (meta?.title === 'IMPORT_DONE' && !force) { console.log('Import already done'); return; }

  if (!process.env.IGDB_CLIENT_ID) { console.warn('No IGDB creds, skipping'); return; }
  console.log('Starting IGDB bulk import...');

  const now         = Math.floor(Date.now() / 1000);
  const twoYearsAgo = now - (2 * 365 * 24 * 3600);
  const twoYearsAhead = now + (2 * 365 * 24 * 3600);

  let total = 0;

  // Fetch in chunks: past 2 years in 3-month windows, plus upcoming
  const windows = [];
  // Past 2 years
  let wEnd = now, wStart = wEnd - (90 * 24 * 3600);
  while (wEnd > twoYearsAgo) {
    windows.push({ start: Math.max(wStart, twoYearsAgo), end: wEnd, type: 'past' });
    wEnd   = wStart;
    wStart = wEnd - (90 * 24 * 3600);
  }
  // Upcoming
  windows.push({ start: now, end: twoYearsAhead, type: 'upcoming' });

  for (const win of windows) {
    console.log(`  ${new Date(win.start*1000).toISOString().slice(0,7)} → ${new Date(win.end*1000).toISOString().slice(0,7)}`);
    let offset = 0;
    while (true) {
      await sleep(300);
      const whereClause = win.type === 'upcoming'
        ? `first_release_date > ${win.start} & first_release_date < ${win.end}`
        : `first_release_date >= ${win.start} & first_release_date <= ${win.end}`;
      const games = await igdbQuery(
        `fields name,cover.url,first_release_date,genres.name,websites.url,websites.category;
         where platforms = (6) & category = (0,8,9) & ${whereClause};
         sort first_release_date desc;
         limit 500; offset ${offset};`
      );
      if (!games.length) break;
      const ops = games.map(g => {
        const data = parseIgdbGame(g);
        return {
          updateOne: {
            filter: { igdb_id: g.id },
            update: {
              $setOnInsert: { crack_status: 'uncracked' },
              $set: data
            },
            upsert: true
          }
        };
      });
      const res = await Game.bulkWrite(ops, { ordered: false });
      total += res.upsertedCount;
      if (games.length < 500) break;
      offset += 500;
    }
  }

  // Mark import done
  await Game.findOneAndUpdate(
    { igdb_id: -1 },
    { igdb_id: -1, title: 'IMPORT_DONE', title_lower: 'import_done' },
    { upsert: true }
  );
  const count = await Game.countDocuments({ igdb_id: { $gt: 0 } });
  console.log(`Bulk import done: ${total} new games, ${count} total`);
}

// ── REDDIT CRACK STATUS ───────────────────────────────────────────────────────
// Keep this DEAD SIMPLE. Only look for posts where the title STARTS with [CRACKED]
// or [UNCRACKED] — nothing else. No guessing.

const CRACKED_RE   = /^\[CRACKED\]\s+(.+?)(?:\s*[-–|]\s*(.+))?$/i;
const UNCRACKED_RE = /^\[UNCRACKED\]\s+(.+)/i;
const HV_RE        = /hypervisor|hv.bypass|vm.bypass/i;

async function syncCrackStatus() {
  console.log('Syncing crack status from r/CrackWatch...');
  let posts = [];
  try {
    // Fetch new + hot
    const [a, b] = await Promise.all([
      axios.get('https://www.reddit.com/r/CrackWatch/new.json?limit=100', { headers: { 'User-Agent': 'CrackTrack/2.0' }, timeout: 15000 }),
      axios.get('https://www.reddit.com/r/CrackWatch/hot.json?limit=50',  { headers: { 'User-Agent': 'CrackTrack/2.0' }, timeout: 15000 }),
    ]);
    const all = [...(a.data?.data?.children||[]), ...(b.data?.data?.children||[])];
    const seen = new Set();
    posts = all.filter(p => { if (seen.has(p.data.id)) return false; seen.add(p.data.id); return true; }).map(p => p.data);
  } catch (e) { console.error('Reddit error:', e.message); return; }

  let updated = 0;
  for (const post of posts) {
    const title = post.title || '';

    // ONLY process posts that explicitly start with [CRACKED] or [UNCRACKED]
    const crackedMatch   = title.match(CRACKED_RE);
    const uncrackedMatch = title.match(UNCRACKED_RE);
    if (!crackedMatch && !uncrackedMatch) continue;

    const gameName  = (crackedMatch ? crackedMatch[1] : uncrackedMatch[1]).trim();
    const crackGroup = crackedMatch ? (crackedMatch[2] || '').trim() || null : null;
    const isHV      = HV_RE.test(title + ' ' + (post.selftext || ''));
    const postDate  = new Date(post.created_utc * 1000).toISOString().split('T')[0];
    const postUrl   = `https://reddit.com${post.permalink}`;

    if (!gameName || gameName.length < 2 || gameName.length > 100) continue;

    // Find matching game in DB (fuzzy match on title)
    const game = await Game.findOne({
      title_lower: { $regex: new RegExp(gameName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
    }).sort({ release_timestamp: -1 });

    if (!game) continue; // only update games we already have from IGDB

    if (crackedMatch) {
      const crackTs   = post.created_utc * 1000;
      const daysToCrack = game.release_timestamp ? Math.round((crackTs - game.release_timestamp) / 86400000) : null;
      await Game.findByIdAndUpdate(game._id, {
        crack_status:    isHV ? 'hypervisor' : 'cracked',
        crack_group:     crackGroup,
        cracked_date:    postDate,
        days_to_crack:   daysToCrack && daysToCrack >= 0 ? daysToCrack : null,
        crack_source_url: postUrl,
      });
      updated++;
    } else if (uncrackedMatch && game.crack_status === 'uncracked') {
      // Don't downgrade a cracked game
      await Game.findByIdAndUpdate(game._id, { crack_source_url: postUrl });
    }
  }
  console.log(`Crack sync done: ${updated} games updated`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SERIALISE ─────────────────────────────────────────────────────────────────
function toRow(g) {
  const dsr = g.release_timestamp ? Math.round((Date.now() - g.release_timestamp) / 86400000) : null;
  return {
    id:               g._id,
    igdb_id:          g.igdb_id,
    title:            g.title,
    cover_url:        g.cover_url,
    release_date:     g.release_date,
    release_status:   g.release_status,
    days_since_release: dsr,
    steam_url:        g.steam_url,
    genres:           g.genres,
    crack_status:     g.crack_status,
    crack_group:      g.crack_group,
    cracked_date:     g.cracked_date,
    days_to_crack:    g.days_to_crack,
    crack_source_url: g.crack_source_url,
  };
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  if (!dbReady) return res.json({ status: 'connecting' });
  const [total, cracked, hv, uncracked, unreleased] = await Promise.all([
    Game.countDocuments({ igdb_id: { $gt: 0 } }),
    Game.countDocuments({ crack_status: 'cracked' }),
    Game.countDocuments({ crack_status: 'hypervisor' }),
    Game.countDocuments({ crack_status: 'uncracked', release_status: 'released' }),
    Game.countDocuments({ release_status: { $in: ['unreleased', 'tba'] } }),
  ]);
  res.json({ status: 'ok', total, cracked, hypervisor: hv, uncracked, unreleased });
});

// Main games list — sorted by release date desc, with filter + search
app.get('/api/games', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(50, parseInt(req.query.limit) || 50);
  const skip   = (page - 1) * limit;
  const status = req.query.status; // 'cracked' | 'uncracked' | 'hypervisor' | 'unreleased' | ''
  const q      = (req.query.q || '').trim();

  const filter = { igdb_id: { $gt: 0 } };
  if (q) filter.title = { $regex: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i') };
  if (status === 'cracked')    filter.crack_status = 'cracked';
  else if (status === 'hypervisor') filter.crack_status = 'hypervisor';
  else if (status === 'uncracked')  { filter.crack_status = 'uncracked'; filter.release_status = 'released'; }
  else if (status === 'unreleased') filter.release_status = { $in: ['unreleased', 'tba'] };

  const [games, total] = await Promise.all([
    Game.find(filter).sort({ release_timestamp: -1 }).skip(skip).limit(limit),
    Game.countDocuments(filter),
  ]);
  res.json({ games: games.map(toRow), total, page, pages: Math.ceil(total / limit) });
});

app.get('/api/stats', async (req, res) => {
  const [total, cracked, hv, uncracked] = await Promise.all([
    Game.countDocuments({ igdb_id: { $gt: 0 } }),
    Game.countDocuments({ crack_status: 'cracked' }),
    Game.countDocuments({ crack_status: 'hypervisor' }),
    Game.countDocuments({ crack_status: 'uncracked', release_status: 'released' }),
  ]);
  res.json({ total, cracked: cracked + hv, hypervisor: hv, uncracked });
});

async function runSync(res) {
  res.json({ ok: true, message: 'Sync started' });
  await syncCrackStatus();
}
app.get('/api/sync',  (req, res) => runSync(res));
app.post('/api/sync', (req, res) => runSync(res));

app.get('/api/reimport', async (req, res) => {
  await Game.deleteOne({ igdb_id: -1 }); // remove the "done" marker
  res.json({ ok: true, message: 'Reimport started' });
  bulkImport(true);
});

// ── CONNECT & START ───────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 })
  .then(async () => {
    console.log('MongoDB connected');
    dbReady = true;
    // Run immediately then schedule
    await syncCrackStatus();
    await bulkImport();
    cron.schedule('0 */3 * * *', syncCrackStatus);    // crack status every 3h
    cron.schedule('0 3 * * 0',   () => bulkImport(true)); // full reimport weekly (Sunday 3am)
  })
  .catch(e => { console.error('MongoDB failed:', e.message); process.exit(1); });
