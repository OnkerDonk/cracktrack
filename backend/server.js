const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// ─── MONGODB SCHEMAS ──────────────────────────────────────────────────────────
const gameSchema = new mongoose.Schema({
  igdb_id:              { type: Number, unique: true, sparse: true },
  title:                { type: String, required: true },
  title_lower:          String, // for case-insensitive search without index overhead
  slug:                 String,
  cover_url:            String,
  release_date:         String,
  release_timestamp:    Number,
  platforms:            String,
  genres:               String,
  summary:              String,
  status:               { type: String, default: 'unknown', enum: ['cracked','uncracked','unknown'] },
  is_hypervisor_bypass: { type: Boolean, default: false },
  cracked_date:         String,
  crack_group:          String,
  days_to_crack:        Number,
  drm:                  String,
  scene_filename:       String,
  reddit_post_url:      String,
  reddit_post_title:    String,
  hypervisor_post_url:  String,
  hypervisor_post_title:String,
}, { timestamps: true });

const newsSchema = new mongoose.Schema({
  reddit_id:    { type: String, unique: true },
  title:        String,
  body:         String,
  url:          String,
  author:       String,
  score:        { type: Number, default: 0 },
  tag:          String,
  created_utc:  Number,
  is_hypervisor:{ type: Boolean, default: false },
}, { timestamps: true });

const watchlistSchema = new mongoose.Schema({
  session_id: String,
  game_id:    mongoose.Schema.Types.ObjectId,
  notified:   { type: Boolean, default: false },
  added_at:   { type: Date, default: Date.now },
});
watchlistSchema.index({ session_id: 1, game_id: 1 }, { unique: true });

const metaSchema = new mongoose.Schema({
  key:   { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed,
});

const Game     = mongoose.model('Game', gameSchema);
const News     = mongoose.model('News', newsSchema);
const Watchlist= mongoose.model('Watchlist', watchlistSchema);
const Meta     = mongoose.model('Meta', metaSchema);

// ─── META HELPERS ─────────────────────────────────────────────────────────────
async function getMeta(key) {
  const doc = await Meta.findOne({ key });
  return doc ? doc.value : null;
}
async function setMeta(key, value) {
  await Meta.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
}

// ─── IGDB API ─────────────────────────────────────────────────────────────────
let igdbToken = null, igdbTokenExpiry = 0;

async function getIgdbToken() {
  if (igdbToken && Date.now() < igdbTokenExpiry) return igdbToken;
  const { IGDB_CLIENT_ID: id, IGDB_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) { console.warn('No IGDB credentials'); return null; }
  try {
    const r = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`);
    igdbToken = r.data.access_token;
    igdbTokenExpiry = Date.now() + (r.data.expires_in - 60) * 1000;
    return igdbToken;
  } catch(e) { console.error('IGDB auth:', e.message); return null; }
}

async function igdbSearch(query, limit = 10) {
  const token = await getIgdbToken(); if (!token) return [];
  try {
    const r = await axios.post('https://api.igdb.com/v4/games',
      `fields name,slug,cover.url,first_release_date,platforms.name,genres.name,summary; search "${query.replace(/"/g,'')}"; where platforms = (6) & version_parent = null; limit ${limit};`,
      { headers: { 'Client-ID': process.env.IGDB_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' } });
    return r.data || [];
  } catch(e) { console.error('IGDB search:', e.message); return []; }
}

async function igdbFetchPage(afterTs, beforeTs, offset = 0) {
  const token = await getIgdbToken(); if (!token) return [];
  try {
    const r = await axios.post('https://api.igdb.com/v4/games',
      `fields name,slug,cover.url,first_release_date,platforms.name,genres.name,summary; where platforms = (6) & first_release_date >= ${Math.floor(afterTs/1000)} & first_release_date <= ${Math.floor(beforeTs/1000)} & first_release_date != null & category = (0,8,9); sort first_release_date desc; limit 500; offset ${offset};`,
      { headers: { 'Client-ID': process.env.IGDB_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' } });
    return r.data || [];
  } catch(e) { console.error('IGDB page:', e.message); return []; }
}

function fmtIgdb(g) {
  const releaseTs = g.first_release_date ? g.first_release_date * 1000 : null;
  return {
    igdb_id: g.id, title: g.name, title_lower: g.name?.toLowerCase(),
    slug: g.slug,
    cover_url: g.cover?.url ? 'https:' + g.cover.url.replace('t_thumb','t_cover_big') : null,
    release_date: releaseTs ? new Date(releaseTs).toISOString().split('T')[0] : null,
    release_timestamp: releaseTs,
    platforms: g.platforms?.map(p=>p.name).join(', ') || null,
    genres: g.genres?.map(g=>g.name).join(', ') || null,
    summary: g.summary || null,
  };
}

// ─── BULK HISTORY IMPORT ──────────────────────────────────────────────────────
async function bulkImportHistory(force = false) {
  const already = await getMeta('history_imported');
  if (already && !force) { console.log('History already imported, skipping'); return; }
  if (!process.env.IGDB_CLIENT_ID) { console.warn('No IGDB credentials — skipping history import'); return; }

  console.log('📚 Starting 2-year bulk IGDB import...');
  const now = Date.now();
  const twoYearsAgo = now - (2 * 365.25 * 24 * 60 * 60 * 1000);
  const CHUNK = 6 * 30 * 24 * 60 * 60 * 1000; // 6-month chunks
  let chunkEnd = now, chunkStart = chunkEnd - CHUNK;
  let totalAdded = 0;

  while (chunkEnd > twoYearsAgo) {
    const label = new Date(chunkStart).toISOString().slice(0,7);
    console.log(`  📅 Fetching ${label}...`);
    let offset = 0;
    while (true) {
      await new Promise(r => setTimeout(r, 350));
      const page = await igdbFetchPage(chunkStart, chunkEnd, offset);
      if (!page.length) break;
      // Bulk upsert — only set igdb fields, don't overwrite crack status
      const ops = page.map(g => {
        const fmt = fmtIgdb(g);
        return {
          updateOne: {
            filter: { igdb_id: fmt.igdb_id },
            update: { $setOnInsert: { status: 'unknown', is_hypervisor_bypass: false }, $set: fmt },
            upsert: true
          }
        };
      });
      const result = await Game.bulkWrite(ops, { ordered: false });
      totalAdded += result.upsertedCount;
      if (page.length < 500) break;
      offset += 500;
    }
    chunkEnd = chunkStart;
    chunkStart = chunkEnd - CHUNK;
  }

  await setMeta('history_imported', true);
  await setMeta('history_import_date', new Date().toISOString());
  const total = await Game.countDocuments();
  await setMeta('history_total', total);
  console.log(`✅ Import done — ${totalAdded} new games added, ${total} total in DB`);
}

// ─── REDDIT PARSER ────────────────────────────────────────────────────────────
const CRACK_PATTERNS = [
  /^\[CRACKED\]\s*(.+?)(?:\s*[\(\[].+[\)\]])?\s*[-–]\s*(.+)$/i,
  /^\[CRACKED\]\s*(.+)$/i,
  /^(.+?)\s+(?:has been |is now )?cracked\s+by\s+(.+)$/i,
  /^(.+?)\s*[-–]\s*cracked$/i,
];
const UNCRACKED_PATTERNS = [/^\[UNCRACKED\]\s*(.+)/i, /^\[STATUS\]\s*(.+)/i];
const HV_PATTERNS = [/hypervisor/i,/hyper-?v\b/i,/vm\s*bypass/i,/virtual\s*machine\s*bypass/i,/hv\s*bypass/i];
const NEWS_FLAIRS = ['NEWS','DISCUSSION','WEEKLY','QUESTION','META','REQUEST','TOOLS','TUTORIAL','MOD POST','ANNOUNCEMENT','HUMOR'];
const DRM_MAP = { 'Denuvo':/denuvo/i,'Steam DRM':/steam\s*drm/i,'EGS DRM':/epic\s*game|egs\s*drm/i,'VMProtect':/vmprotect/i,'Arxan':/arxan/i };

function extractFilename(title) {
  const m = title.match(/([A-Za-z0-9._-]{10,}(?:v[\d.]+|Build[\d]+|REPACK|FitGirl|EMPRESS|SKIDROW|CODEX|PLAZA|CPY|RUNE|TiNYiSO|GOG)[A-Za-z0-9._-]*)/i);
  if (m) return m[1];
  const gm = title.match(/[-–]\s*([A-Z0-9]{3,12})\s*$/);
  return gm ? gm[1] : null;
}

// Words that appear in discussion/news titles but are NOT game names
const NOISE_WORDS = new Set(['weekly','discussion','thread','question','help','news','release','update','patch','fix','bug','issue','mod','tool','request','info','guide','list','megathread','monthly','daily','general','latest','new','best','top','how','what','why','when','where','who']);

function isValidGameName(name) {
  if (!name || name.length < 3 || name.length > 80) return false;
  const lower = name.toLowerCase().trim();
  // Reject if it starts with a noise word
  const firstWord = lower.split(/\s+/)[0];
  if (NOISE_WORDS.has(firstWord)) return false;
  // Reject if it contains question marks (discussion posts)
  if (name.includes('?')) return false;
  // Reject purely numeric strings
  if (/^\d+$/.test(lower)) return false;
  return true;
}

function parsePost(post) {
  const title = post.title || '';
  const flair = (post.link_flair_text||'').toUpperCase().trim();
  const full = title + ' ' + (post.selftext||'');
  const isNewsFlair = NEWS_FLAIRS.some(f => flair.includes(f));

  // Pure news post — don't try to parse as a game
  if (isNewsFlair) return { status:'news', gameName:null, isHV:false, tag:'scene', drm:null, sceneFilename:null, crackGroup:null };

  const isHV = HV_PATTERNS.some(p => p.test(full));
  let status = 'unknown', gameName = null, crackGroup = null;

  if (isHV) {
    status = 'cracked';
    const candidate = title.replace(/^\[.*?\]\s*/,'').replace(/hypervisor\s*bypass/i,'').replace(/[-–].*$/,'').trim();
    gameName = isValidGameName(candidate) ? candidate : null;
  } else {
    // Only set status from flair if it's an EXACT known crack/uncracked flair
    if (['CRACKED','SCENE RELEASE','SCENE','CRACKED - SCENE'].includes(flair)) status = 'cracked';
    else if (['UNCRACKED','DENUVO','DENUVO UNCRACKED'].includes(flair)) status = 'uncracked';

    // Pattern matching — these are high-confidence
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

    // No pattern matched — only use flair-based status if we have a clean title
    if (!gameName && status !== 'unknown') {
      // Strip the flair tag from title to get the game name
      const candidate = title.replace(/^\[.*?\]\s*/,'').replace(/\s*[-–].*$/,'').trim();
      gameName = isValidGameName(candidate) ? candidate : null;
    }

    // Nothing matched at all — treat as news/discussion
    if (!gameName || status === 'unknown') {
      return { status:'news', gameName:null, isHV:false, tag:'scene', drm:null, sceneFilename:null, crackGroup:null };
    }
  }

  // Final validation — reject if game name isn't valid
  if (!isValidGameName(gameName)) {
    return { status:'news', gameName:null, isHV:false, tag:'scene', drm:null, sceneFilename:null, crackGroup:null };
  }

  let drm = null;
  for (const [name, pat] of Object.entries(DRM_MAP)) { if(pat.test(full)){drm=name;break;} }
  const sceneFilename = extractFilename(title);
  const createdDate = post.created_utc ? new Date(post.created_utc*1000).toISOString().split('T')[0] : null;
  let tag = isHV ? 'bypass' : status==='cracked' ? 'release' : drm ? 'drm' : /update|patch/i.test(title) ? 'update' : 'scene';
  return { status, gameName, crackGroup, isHV, drm, sceneFilename, createdDate, tag };
}

async function fetchReddit(sort='new', limit=100) {
  try {
    const r = await axios.get(`https://www.reddit.com/r/CrackWatch/${sort}.json?limit=${limit}&t=month`,
      { headers:{'User-Agent':'CrackTrack/1.0'}, timeout:15000 });
    return r.data?.data?.children?.map(c=>c.data)||[];
  } catch(e) { console.error('Reddit fetch:', e.message); return []; }
}
async function fetchHvPosts() {
  try {
    const r = await axios.get('https://www.reddit.com/r/CrackWatch/search.json?q=hypervisor+bypass&restrict_sr=1&sort=new&limit=50',
      { headers:{'User-Agent':'CrackTrack/1.0'}, timeout:15000 });
    return r.data?.data?.children?.map(c=>c.data)||[];
  } catch(e) { return []; }
}

async function syncReddit() {
  console.log('🔄 Syncing r/CrackWatch...');
  const [newPosts, hotPosts, hvPosts] = await Promise.all([fetchReddit('new',100), fetchReddit('hot',50), fetchHvPosts()]);
  const seen = new Set();
  const posts = [...newPosts,...hotPosts,...hvPosts].filter(p => { if(seen.has(p.id))return false; seen.add(p.id);return true; });

  let cracks=0, hv=0, newsCount=0;
  for (const post of posts) {
    const p = parsePost(post);
    const url = `https://reddit.com${post.permalink}`;
    const date = post.created_utc ? new Date(post.created_utc*1000).toISOString().split('T')[0] : null;

    // Always save to news
    try {
      await News.findOneAndUpdate(
        { reddit_id: post.id },
        { reddit_id:post.id, title:post.title, body:(post.selftext||'').slice(0,2000), url, author:post.author, score:post.score||0, tag:p.tag, created_utc:post.created_utc||0, is_hypervisor:p.isHV },
        { upsert:true }
      );
      newsCount++;
    } catch {}

    // Skip news posts for game DB
    if (p.status === 'news' || !p.gameName || p.gameName.length < 2) continue;

    const existing = await Game.findOne({ title_lower: p.gameName.toLowerCase() });
    const crackTs = post.created_utc ? post.created_utc*1000 : Date.now();

    if (p.isHV) {
      const daysToCrack = existing?.release_timestamp ? Math.round((crackTs-existing.release_timestamp)/86400000) : null;
      await Game.findOneAndUpdate(
        { title_lower: p.gameName.toLowerCase() },
        { $setOnInsert: { title: p.gameName, title_lower: p.gameName.toLowerCase() },
          $set: { status:'cracked', is_hypervisor_bypass:true, cracked_date: existing?.cracked_date||date, days_to_crack: existing?.days_to_crack||daysToCrack, hypervisor_post_url:url, hypervisor_post_title:post.title, ...(p.drm&&{drm:p.drm}), ...(p.sceneFilename&&{scene_filename:p.sceneFilename}) }},
        { upsert:true }
      );
      hv++;
    } else if (p.status === 'cracked') {
      const upd = existing && existing.status !== 'cracked';
      const daysToCrack = existing?.release_timestamp ? Math.round((crackTs-existing.release_timestamp)/86400000) : null;
      await Game.findOneAndUpdate(
        { title_lower: p.gameName.toLowerCase() },
        { $setOnInsert: { title: p.gameName, title_lower: p.gameName.toLowerCase() },
          $set: { status:'cracked', cracked_date:date, crack_group:p.crackGroup, days_to_crack:daysToCrack, reddit_post_url:url, reddit_post_title:post.title, ...(p.drm&&{drm:p.drm}), ...(p.sceneFilename&&{scene_filename:p.sceneFilename}) }},
        { upsert:true }
      );
      if (upd||!existing) cracks++;
    } else if (p.status === 'uncracked') {
      if (!existing) {
        await Game.create({ title:p.gameName, title_lower:p.gameName.toLowerCase(), status:'uncracked', drm:p.drm, reddit_post_url:url, scene_filename:p.sceneFilename });
      }
    }
  }
  await setMeta('last_reddit_sync', new Date().toISOString());
  console.log(`✅ Reddit sync: ${cracks} cracks, ${hv} HV bypasses, ${newsCount} news`);
}

async function enrichUnknown(batch=30) {
  if (!process.env.IGDB_CLIENT_ID) return;
  const games = await Game.find({ igdb_id: null, title: { $exists:true } }).limit(batch);
  if (!games.length) return;
  console.log(`🎮 Enriching ${games.length} games with IGDB...`);
  for (const game of games) {
    await new Promise(r=>setTimeout(r,350));
    const results = await igdbSearch(game.title, 3);
    if (results.length) {
      const fmt = fmtIgdb(results[0]);
      const crackedTs = game.cracked_date ? new Date(game.cracked_date).getTime() : null;
      const d = fmt.release_timestamp && crackedTs ? Math.round((crackedTs-fmt.release_timestamp)/86400000) : game.days_to_crack;
      await Game.findByIdAndUpdate(game._id, { ...fmt, days_to_crack:d });
    }
  }
}

// ─── SCHEDULED JOBS ───────────────────────────────────────────────────────────
cron.schedule('0 */2 * * *', async () => { await syncReddit(); await enrichUnknown(30); });
setTimeout(async () => { await syncReddit(); await enrichUnknown(50); await bulkImportHistory(); }, 3000);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function row(g) {
  const daysSinceRelease = g.release_timestamp ? Math.round((Date.now()-g.release_timestamp)/86400000) : null;
  return { id:g._id, igdb_id:g.igdb_id, title:g.title, scene_filename:g.scene_filename||null, slug:g.slug, cover_url:g.cover_url, release_date:g.release_date, days_since_release:daysSinceRelease, platforms:g.platforms, genres:g.genres, summary:g.summary, status:g.status||'unknown', is_hypervisor_bypass:!!g.is_hypervisor_bypass, cracked_date:g.cracked_date, crack_group:g.crack_group, days_to_crack:g.days_to_crack, drm:g.drm, reddit_post_url:g.reddit_post_url, reddit_post_title:g.reddit_post_title, hypervisor_post_url:g.hypervisor_post_url||null, hypervisor_post_title:g.hypervisor_post_title||null };
}

function applySortFilter(query, sort, filter) {
  if (filter==='cracked')    query = query.where({ status:'cracked', is_hypervisor_bypass:false });
  else if (filter==='uncracked')  query = query.where({ status:'uncracked' });
  else if (filter==='hypervisor') query = query.where({ status:'cracked', is_hypervisor_bypass:true });
  else query = query.where({ status:{ $in:['cracked','uncracked'] } }); // all

  switch(sort) {
    case 'date_asc':   return query.sort({ cracked_date:1 });
    case 'alpha_asc':  return query.sort({ title_lower:1 });
    case 'alpha_desc': return query.sort({ title_lower:-1 });
    case 'days_asc':   return query.sort({ days_to_crack:1 });
    case 'days_desc':  return query.sort({ days_to_crack:-1 });
    case 'wait_desc':  return query.sort({ release_timestamp:1 });
    default:           return query.sort({ cracked_date:-1, release_timestamp:-1 });
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/api/health', async (req,res) => {
  const [lastSync, histImported, histTotal] = await Promise.all([getMeta('last_reddit_sync'), getMeta('history_imported'), getMeta('history_total')]);
  const [total, cracked, uncracked, hv] = await Promise.all([Game.countDocuments(), Game.countDocuments({status:'cracked'}), Game.countDocuments({status:'uncracked'}), Game.countDocuments({is_hypervisor_bypass:true})]);
  res.json({ status:'ok', lastSync, historyImported:!!histImported, historyTotal:histTotal, gamesInDb:total, cracked, uncracked, hypervisor:hv, uptime:Math.round(process.uptime())+'s' });
});

app.get('/api/search', async (req,res) => {
  const q = (req.query.q||'').trim();
  if (!q) return res.json({ results:[] });
  const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'i');
  const games = await Game.find({ title: regex }).sort({ release_timestamp:-1 }).limit(15);
  if (games.length) return res.json({ results:games.map(row), source:'db' });

  const igdbResults = await igdbSearch(q, 5);
  const results = await Promise.all(igdbResults.map(async g => {
    const fmt = fmtIgdb(g);
    const existing = await Game.findOne({ igdb_id:g.id });
    if (!existing) { try { await Game.create({ ...fmt, title_lower:fmt.title?.toLowerCase(), status:'unknown' }); } catch{} }
    return { ...fmt, status:existing?.status||'unknown', is_hypervisor_bypass:!!existing?.is_hypervisor_bypass, cracked_date:existing?.cracked_date||null, crack_group:existing?.crack_group||null, days_to_crack:existing?.days_to_crack||null, drm:existing?.drm||null, reddit_post_url:existing?.reddit_post_url||null, hypervisor_post_url:existing?.hypervisor_post_url||null, scene_filename:existing?.scene_filename||null, id:existing?._id };
  }));
  res.json({ results, source:'igdb' });
});

app.get('/api/recent-cracks', async (req,res) => {
  const limit = Math.min(parseInt(req.query.limit)||20, 200);
  const filter = req.query.filter||'all';
  const sort = req.query.sort||'date_desc';
  const games = await applySortFilter(Game.find(), sort, filter).limit(limit);
  res.json({ games: games.map(row) });
});

app.get('/api/uncracked', async (req,res) => {
  const limit = Math.min(parseInt(req.query.limit)||30, 200);
  const games = await Game.find({ status:'uncracked' }).sort({ release_timestamp:-1 }).limit(limit);
  res.json({ games: games.map(row) });
});

app.get('/api/hypervisor', async (req,res) => {
  const limit = Math.min(parseInt(req.query.limit)||30, 100);
  const games = await Game.find({ status:'cracked', is_hypervisor_bypass:true }).sort({ cracked_date:-1 }).limit(limit);
  res.json({ games: games.map(row) });
});

app.get('/api/news', async (req,res) => {
  const limit = Math.min(parseInt(req.query.limit)||30, 100);
  const tag = req.query.tag;
  let q = News.find();
  if (tag==='bypass') q = q.where({ $or:[{tag:'bypass'},{is_hypervisor:true}] });
  else if (tag) q = q.where({ tag });
  const news = await q.sort({ created_utc:-1 }).limit(limit);
  res.json({ news });
});

app.get('/api/stats', async (req,res) => {
  const [total, cracked, uncracked, hv, lastSync, histImported] = await Promise.all([
    Game.countDocuments(),
    Game.countDocuments({ status:'cracked' }),
    Game.countDocuments({ status:'uncracked' }),
    Game.countDocuments({ is_hypervisor_bypass:true }),
    getMeta('last_reddit_sync'),
    getMeta('history_imported'),
  ]);
  res.json({ total, cracked, uncracked, hypervisor:hv, lastSync, historyImported:!!histImported });
});

app.post('/api/watchlist', async (req,res) => {
  const { session_id, game_id } = req.body;
  if (!session_id||!game_id) return res.status(400).json({error:'Missing fields'});
  try { await Watchlist.create({ session_id, game_id }); } catch{}
  res.json({ ok:true });
});
app.delete('/api/watchlist', async (req,res) => {
  const { session_id, game_id } = req.body;
  await Watchlist.deleteOne({ session_id, game_id });
  res.json({ ok:true });
});
app.get('/api/watchlist/:session_id', async (req,res) => {
  const items = await Watchlist.find({ session_id:req.params.session_id });
  const ids = items.map(w=>w.game_id);
  const games = await Game.find({ _id:{ $in:ids } });
  res.json({ games: games.map(row) });
});
app.get('/api/watchlist/:session_id/check', async (req,res) => {
  const items = await Watchlist.find({ session_id:req.params.session_id, notified:false });
  const ids = items.map(w=>w.game_id);
  const games = await Game.find({ _id:{$in:ids}, status:'cracked' });
  const newlyCracked = games.filter(g=>!g.is_hypervisor_bypass);
  const newlyBypassed = games.filter(g=>g.is_hypervisor_bypass);
  if (games.length) await Watchlist.updateMany({ session_id:req.params.session_id, game_id:{$in:games.map(g=>g._id)} }, { notified:true });
  res.json({ newlyCracked:newlyCracked.map(row), newlyBypassed:newlyBypassed.map(row) });
});

async function runSync(res) { res.json({ok:true,message:'Sync started — check /api/health shortly'}); await syncReddit(); await enrichUnknown(30); }
app.post('/api/sync', (req,res)=>runSync(res));
app.get('/api/sync',  (req,res)=>runSync(res));

app.get('/api/reimport', async (req,res) => {
  // Wipe all games that have no reddit data (pure IGDB stubs from broken imports)
  const deleted = await Game.deleteMany({ status:'unknown', reddit_post_url:null, hypervisor_post_url:null });
  await setMeta('history_imported', false);
  res.json({ ok:true, message:`Cleared ${deleted.deletedCount} stale games. Fresh 2-year import started — check /api/health in ~10 min` });
  bulkImportHistory(true);
});

// ─── START ────────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('❌ MONGODB_URI env var not set!'); process.exit(1); }

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => console.log(`🚀 CrackTrack API on port ${PORT}`));
  })
  .catch(e => { console.error('❌ MongoDB connection failed:', e.message); process.exit(1); });
