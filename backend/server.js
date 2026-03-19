const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const cron    = require('node-cron');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

// ── Start HTTP server IMMEDIATELY so Render sees the port ─────────────────────
// MongoDB connects separately below. Routes return 503 until DB is ready.
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`HTTP server listening on ${PORT}`));

let dbReady = false;
app.use((req, res, next) => {
  if (!dbReady && !req.path.startsWith('/api/health')) {
    return res.status(503).json({ error: 'Database connecting, please retry in a moment' });
  }
  next();
});

// ── SCHEMAS ───────────────────────────────────────────────────────────────────
const gameSchema = new mongoose.Schema({
  igdb_id:               { type: Number, unique: true, sparse: true },
  title:                 { type: String, required: true },
  title_lower:           { type: String, index: true },
  slug:                  String,
  cover_url:             String,
  release_date:          String,
  release_timestamp:     Number,
  platforms:             String,
  genres:                String,
  summary:               String,
  status:                { type: String, default: 'unknown', enum: ['cracked','uncracked','unknown'] },
  is_hypervisor_bypass:  { type: Boolean, default: false },
  cracked_date:          String,
  crack_group:           String,
  days_to_crack:         Number,
  drm:                   String,
  scene_filename:        String,
  reddit_post_url:       String,
  reddit_post_title:     String,
  hypervisor_post_url:   String,
  hypervisor_post_title: String,
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

const Game      = mongoose.model('Game',      gameSchema);
const News      = mongoose.model('News',      newsSchema);
const Watchlist = mongoose.model('Watchlist', watchlistSchema);
const Meta      = mongoose.model('Meta',      metaSchema);

async function getMeta(key)        { const d = await Meta.findOne({key}); return d ? d.value : null; }
async function setMeta(key, value) { await Meta.findOneAndUpdate({key}, {value}, {upsert:true}); }

// ── IGDB ──────────────────────────────────────────────────────────────────────
let igdbToken = null, igdbExpiry = 0;
async function getToken() {
  if (igdbToken && Date.now() < igdbExpiry) return igdbToken;
  const {IGDB_CLIENT_ID:id, IGDB_CLIENT_SECRET:secret} = process.env;
  if (!id||!secret) return null;
  try {
    const r = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`);
    igdbToken  = r.data.access_token;
    igdbExpiry = Date.now() + (r.data.expires_in - 60)*1000;
    console.log('IGDB token OK');
    return igdbToken;
  } catch(e) { console.error('IGDB auth failed:', e.message); return null; }
}

async function igdbPost(body) {
  const token = await getToken(); if (!token) return [];
  try {
    const r = await axios.post('https://api.igdb.com/v4/games', body, {
      headers: { 'Client-ID': process.env.IGDB_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' }
    });
    return r.data || [];
  } catch(e) { console.error('IGDB error:', e.message); return []; }
}

async function igdbSearch(q, limit=10) {
  return igdbPost(`fields name,slug,cover.url,first_release_date,platforms.name,genres.name,summary; search "${q.replace(/"/g,'')}"; where platforms=(6) & version_parent=null; limit ${limit};`);
}
async function igdbPage(after, before, offset=0) {
  return igdbPost(`fields name,slug,cover.url,first_release_date,platforms.name,genres.name,summary; where platforms=(6) & first_release_date>=${Math.floor(after/1000)} & first_release_date<=${Math.floor(before/1000)} & first_release_date!=null & category=(0,8,9); sort first_release_date desc; limit 500; offset ${offset};`);
}

function fmtGame(g) {
  const ts = g.first_release_date ? g.first_release_date*1000 : null;
  return { igdb_id:g.id, title:g.name, title_lower:g.name?.toLowerCase(), slug:g.slug, cover_url:g.cover?.url?'https:'+g.cover.url.replace('t_thumb','t_cover_big'):null, release_date:ts?new Date(ts).toISOString().split('T')[0]:null, release_timestamp:ts, platforms:g.platforms?.map(p=>p.name).join(', ')||null, genres:g.genres?.map(x=>x.name).join(', ')||null, summary:g.summary||null };
}

// ── BULK IMPORT (2 years) ─────────────────────────────────────────────────────
async function bulkImport(force=false) {
  const done = await getMeta('history_imported');
  if (done && !force) { console.log('History already imported'); return; }
  if (!process.env.IGDB_CLIENT_ID) { console.warn('No IGDB creds, skipping import'); return; }

  console.log('Starting 2-year IGDB bulk import...');
  const now = Date.now();
  const cutoff = now - (2 * 365.25 * 24 * 3600 * 1000);
  const CHUNK  = 6  * 30  * 24 * 3600 * 1000; // 6-month windows
  let end = now, start = end - CHUNK;
  let added = 0;

  while (end > cutoff) {
    console.log(`  chunk ${new Date(start).toISOString().slice(0,7)}...`);
    let offset = 0;
    while (true) {
      await sleep(400);
      const page = await igdbPage(start, end, offset);
      if (!page.length) break;
      const ops = page.map(g => ({
        updateOne: {
          filter: { igdb_id: g.id },
          update: { $setOnInsert: { status:'unknown', is_hypervisor_bypass:false }, $set: fmtGame(g) },
          upsert: true
        }
      }));
      const res = await Game.bulkWrite(ops, { ordered:false });
      added += res.upsertedCount;
      if (page.length < 500) break;
      offset += 500;
    }
    end   = start;
    start = end - CHUNK;
  }

  const total = await Game.countDocuments();
  await setMeta('history_imported', true);
  await setMeta('history_import_date', new Date().toISOString());
  await setMeta('history_total', total);
  console.log(`Bulk import done: ${added} new, ${total} total`);
}

// ── REDDIT PARSER ─────────────────────────────────────────────────────────────
// These flairs mean the post is a news/discussion — NEVER treat as a game
const NEWS_FLAIRS = new Set([
  'NEWS','DISCUSSION','WEEKLY','QUESTION','META','REQUEST','TOOLS',
  'TUTORIAL','MOD POST','ANNOUNCEMENT','HUMOR','SATIRE','TOOLS & RESOURCES',
  'WEEKLY THREAD','DAILY THREAD','MONTHLY THREAD','GENERAL'
]);

// These are the ONLY flairs that confirm a crack/uncracked release
const CRACKED_FLAIRS   = new Set(['CRACKED','SCENE RELEASE','SCENE','CRACKED - SCENE','CRACKED-SCENE']);
const UNCRACKED_FLAIRS = new Set(['UNCRACKED','DENUVO','DENUVO UNCRACKED','WAITING']);

// High-confidence title patterns for crack releases
const CRACK_RE = [
  /^\[CRACKED\]\s*(.+?)(?:\s*[\(\[].*?[\)\]])?\s*[-–]\s*(.+)$/i,  // [CRACKED] Game - Group
  /^\[CRACKED\]\s*(.+)$/i,                                          // [CRACKED] Game
  /^(.+?)\s+cracked\s+by\s+(.+)$/i,                                // Game cracked by Group
];
const UNCRACKED_RE = [
  /^\[UNCRACKED\]\s*(.+)/i,
  /^\[DENUVO\]\s*(.+)/i,
];
const HV_RE = [/hypervisor/i, /hyper-?v\s*bypass/i, /hv\s*bypass/i, /vm\s*bypass/i];
const DRM_MAP = { 'Denuvo':/denuvo/i, 'Steam DRM':/steam\s*drm/i, 'EGS DRM':/egs\s*drm/i, 'VMProtect':/vmprotect/i };

// Words that indicate a non-game title (discussion threads, news posts, etc)
const BAD_STARTS = new Set([
  'weekly','daily','monthly','discussion','thread','news','question','help',
  'psa','reminder','update','patch','fix','announcement','looking','does',
  'why','how','what','when','where','who','is','are','can','will','has',
  'have','did','do','any','anyone','someone'
]);

function validName(n) {
  if (!n) return false;
  const s = n.trim();
  if (s.length < 3 || s.length > 80) return false;
  if (s.includes('?')) return false;                          // questions
  if (/^\d+$/.test(s)) return false;                         // only numbers
  if (BAD_STARTS.has(s.split(/\s+/)[0].toLowerCase())) return false;
  return true;
}

function sceneFile(title) {
  const m = title.match(/([A-Za-z0-9._-]{10,}(?:v[\d.]+|Build\d+|REPACK|FitGirl|EMPRESS|SKIDROW|CODEX|PLAZA|CPY|RUNE|TiNYiSO|GOG)[A-Za-z0-9._-]*)/i);
  return m ? m[1] : null;
}

function parsePost(post) {
  const SKIP = { status:'news', gameName:null, isHV:false, tag:'scene', drm:null, sceneFilename:null, crackGroup:null };
  const title = (post.title||'').trim();
  const flair = (post.link_flair_text||'').toUpperCase().trim();
  const full  = title + ' ' + (post.selftext||'');

  // Immediately reject known news/discussion flairs
  if (NEWS_FLAIRS.has(flair) || [...NEWS_FLAIRS].some(f => flair.startsWith(f))) return SKIP;

  const isHV = HV_RE.some(p => p.test(full));

  let status='unknown', gameName=null, crackGroup=null;

  if (isHV) {
    // Hypervisor bypass — extract game name carefully
    const candidate = title
      .replace(/^\[.*?\]\s*/,'')
      .replace(/hypervisor\s*bypass/gi,'')
      .replace(/hv\s*bypass/gi,'')
      .replace(/[-–|].*$/,'')
      .trim();
    if (!validName(candidate)) return SKIP;
    gameName = candidate;
    status   = 'cracked';
  } else {
    // Try high-confidence title patterns first
    for (const re of CRACK_RE) {
      const m = title.match(re);
      if (m && validName(m[1]?.trim())) { gameName=m[1].trim(); crackGroup=m[2]?.trim(); status='cracked'; break; }
    }
    if (!gameName) {
      for (const re of UNCRACKED_RE) {
        const m = title.match(re);
        if (m && validName(m[1]?.trim())) { gameName=m[1].trim(); status='uncracked'; break; }
      }
    }
    // If no title pattern matched, use flair — but ONLY exact known crack flairs
    if (!gameName && CRACKED_FLAIRS.has(flair)) {
      const candidate = title.replace(/^\[.*?\]\s*/,'').replace(/\s*[-–|].*$/,'').trim();
      if (validName(candidate)) { gameName=candidate; status='cracked'; }
    }
    if (!gameName && UNCRACKED_FLAIRS.has(flair)) {
      const candidate = title.replace(/^\[.*?\]\s*/,'').replace(/\s*[-–|].*$/,'').trim();
      if (validName(candidate)) { gameName=candidate; status='uncracked'; }
    }
    // Still nothing — this is a news post
    if (!gameName || status==='unknown') return SKIP;
  }

  let drm=null;
  for (const [name,pat] of Object.entries(DRM_MAP)) { if(pat.test(full)){drm=name;break;} }
  const tag = isHV?'bypass':status==='cracked'?'release':drm?'drm':'scene';
  return { status, gameName, crackGroup, isHV, drm, sceneFilename:sceneFile(title), tag };
}

// ── REDDIT SYNC ───────────────────────────────────────────────────────────────
async function fetchReddit(sort='new', limit=100) {
  try {
    const r = await axios.get(`https://www.reddit.com/r/CrackWatch/${sort}.json?limit=${limit}&t=month`,
      { headers:{'User-Agent':'CrackTrack/1.0 (+https://cracktrack-api.onrender.com)'}, timeout:15000 });
    return r.data?.data?.children?.map(c=>c.data)||[];
  } catch(e) { console.error('Reddit fetch error:', e.message); return []; }
}

async function syncReddit() {
  console.log('Syncing r/CrackWatch...');
  const [newPosts, hotPosts] = await Promise.all([fetchReddit('new',100), fetchReddit('hot',50)]);
  // Also search specifically for HV posts
  let hvPosts = [];
  try {
    const r = await axios.get('https://www.reddit.com/r/CrackWatch/search.json?q=hypervisor+bypass&restrict_sr=1&sort=new&limit=25',
      { headers:{'User-Agent':'CrackTrack/1.0'}, timeout:10000 });
    hvPosts = r.data?.data?.children?.map(c=>c.data)||[];
  } catch{}

  const seen = new Set();
  const posts = [...newPosts,...hotPosts,...hvPosts].filter(p => { if(seen.has(p.id))return false; seen.add(p.id);return true; });
  let cracks=0, hvCount=0, newsCount=0;

  for (const post of posts) {
    const p   = parsePost(post);
    const url = `https://reddit.com${post.permalink}`;
    const date = post.created_utc ? new Date(post.created_utc*1000).toISOString().split('T')[0] : null;

    // Save everything to news collection (news tab source)
    try {
      await News.findOneAndUpdate(
        { reddit_id: post.id },
        { reddit_id:post.id, title:post.title, body:(post.selftext||'').slice(0,1500), url, author:post.author, score:post.score||0, tag:p.tag, created_utc:post.created_utc||0, is_hypervisor:p.isHV },
        { upsert:true, new:true }
      );
      newsCount++;
    } catch{}

    // Only add to game DB if it's a real crack/uncracked post
    if (p.status==='news' || !p.gameName) continue;

    const existing = await Game.findOne({ title_lower: p.gameName.toLowerCase() });
    const crackTs  = post.created_utc ? post.created_utc*1000 : Date.now();

    if (p.isHV) {
      const days = existing?.release_timestamp ? Math.round((crackTs-existing.release_timestamp)/86400000) : null;
      await Game.findOneAndUpdate(
        { title_lower: p.gameName.toLowerCase() },
        { $setOnInsert: { title:p.gameName, title_lower:p.gameName.toLowerCase(), status:'cracked' },
          $set: { is_hypervisor_bypass:true, cracked_date:existing?.cracked_date||date, days_to_crack:existing?.days_to_crack||days,
                  hypervisor_post_url:url, hypervisor_post_title:post.title, ...(p.drm&&{drm:p.drm}), ...(p.sceneFilename&&{scene_filename:p.sceneFilename}) }},
        { upsert:true }
      );
      hvCount++;
    } else if (p.status==='cracked') {
      const days = existing?.release_timestamp ? Math.round((crackTs-existing.release_timestamp)/86400000) : null;
      await Game.findOneAndUpdate(
        { title_lower: p.gameName.toLowerCase() },
        { $setOnInsert: { title:p.gameName, title_lower:p.gameName.toLowerCase() },
          $set: { status:'cracked', cracked_date:date, crack_group:p.crackGroup||null, days_to_crack:days,
                  reddit_post_url:url, reddit_post_title:post.title, ...(p.drm&&{drm:p.drm}), ...(p.sceneFilename&&{scene_filename:p.sceneFilename}) }},
        { upsert:true }
      );
      cracks++;
    } else if (p.status==='uncracked' && !existing) {
      await Game.create({ title:p.gameName, title_lower:p.gameName.toLowerCase(), status:'uncracked', drm:p.drm||null, reddit_post_url:url });
    }
  }
  await setMeta('last_reddit_sync', new Date().toISOString());
  console.log(`Reddit sync done: ${cracks} cracks, ${hvCount} HV, ${newsCount} news saved`);
}

async function enrichUnknown(n=30) {
  if (!process.env.IGDB_CLIENT_ID) return;
  const games = await Game.find({ igdb_id:null }).limit(n);
  if (!games.length) return;
  for (const g of games) {
    await sleep(400);
    const res = await igdbSearch(g.title, 3);
    if (!res.length) continue;
    const fmt = fmtGame(res[0]);
    const crackedTs = g.cracked_date ? new Date(g.cracked_date).getTime() : null;
    const days = fmt.release_timestamp && crackedTs ? Math.round((crackedTs-fmt.release_timestamp)/86400000) : g.days_to_crack;
    await Game.findByIdAndUpdate(g._id, { ...fmt, days_to_crack:days });
  }
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── SERIALISE ─────────────────────────────────────────────────────────────────
function row(g) {
  const dsr = g.release_timestamp ? Math.round((Date.now()-g.release_timestamp)/86400000) : null;
  return { id:g._id, igdb_id:g.igdb_id, title:g.title, scene_filename:g.scene_filename||null, slug:g.slug, cover_url:g.cover_url, release_date:g.release_date, days_since_release:dsr, platforms:g.platforms, genres:g.genres, summary:g.summary, status:g.status||'unknown', is_hypervisor_bypass:!!g.is_hypervisor_bypass, cracked_date:g.cracked_date, crack_group:g.crack_group, days_to_crack:g.days_to_crack, drm:g.drm, reddit_post_url:g.reddit_post_url, reddit_post_title:g.reddit_post_title, hypervisor_post_url:g.hypervisor_post_url||null, hypervisor_post_title:g.hypervisor_post_title||null };
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/api/health', async (req,res) => {
  const info = { status: dbReady?'ok':'connecting', dbReady };
  if (dbReady) {
    const [lastSync,histImported,histTotal] = await Promise.all([getMeta('last_reddit_sync'),getMeta('history_imported'),getMeta('history_total')]);
    const [total,cracked,uncracked,hv] = await Promise.all([Game.countDocuments(),Game.countDocuments({status:'cracked'}),Game.countDocuments({status:'uncracked'}),Game.countDocuments({is_hypervisor_bypass:true})]);
    Object.assign(info,{lastSync,historyImported:!!histImported,historyTotal:histTotal,gamesInDb:total,cracked,uncracked,hypervisor:hv,uptime:Math.round(process.uptime())+'s'});
  }
  res.json(info);
});

app.get('/api/stats', async (req,res) => {
  const [total,cracked,uncracked,hv,lastSync] = await Promise.all([Game.countDocuments(),Game.countDocuments({status:'cracked'}),Game.countDocuments({status:'uncracked'}),Game.countDocuments({is_hypervisor_bypass:true}),getMeta('last_reddit_sync')]);
  res.json({total,cracked,uncracked,hypervisor:hv,lastSync});
});

app.get('/api/search', async (req,res) => {
  const q = (req.query.q||'').trim();
  if (!q) return res.json({results:[]});
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
  const games = await Game.find({title:re}).sort({release_timestamp:-1}).limit(15);
  if (games.length) return res.json({results:games.map(row),source:'db'});
  const igdbRes = await igdbSearch(q,5);
  const results = await Promise.all(igdbRes.map(async g=>{
    const fmt=fmtGame(g), ex=await Game.findOne({igdb_id:g.id});
    if (!ex) { try { await Game.create({...fmt,title_lower:fmt.title?.toLowerCase(),status:'unknown'}); } catch{} }
    return {...fmt,id:ex?._id,status:ex?.status||'unknown',is_hypervisor_bypass:!!ex?.is_hypervisor_bypass,cracked_date:ex?.cracked_date||null,crack_group:ex?.crack_group||null,days_to_crack:ex?.days_to_crack||null,drm:ex?.drm||null,reddit_post_url:ex?.reddit_post_url||null,hypervisor_post_url:ex?.hypervisor_post_url||null,scene_filename:ex?.scene_filename||null};
  }));
  res.json({results,source:'igdb'});
});

// Main feed — all games with filter+sort
app.get('/api/recent-cracks', async (req,res) => {
  const limit  = Math.min(parseInt(req.query.limit)||20,200);
  const filter = req.query.filter||'all';
  const sort   = req.query.sort||'date_desc';

  let q;
  if      (filter==='cracked')    q = Game.find({status:'cracked',is_hypervisor_bypass:false});
  else if (filter==='uncracked')  q = Game.find({status:'uncracked'});
  else if (filter==='hypervisor') q = Game.find({status:'cracked',is_hypervisor_bypass:true});
  else                            q = Game.find({status:{$in:['cracked','uncracked']}});

  const sortMap = { date_desc:{cracked_date:-1,release_timestamp:-1}, date_asc:{cracked_date:1}, alpha_asc:{title_lower:1}, alpha_desc:{title_lower:-1}, days_asc:{days_to_crack:1}, days_desc:{days_to_crack:-1}, wait_desc:{release_timestamp:1} };
  q = q.sort(sortMap[sort]||sortMap.date_desc);
  const games = await q.limit(limit);
  res.json({games:games.map(row)});
});

app.get('/api/uncracked', async (req,res) => {
  const games = await Game.find({status:'uncracked'}).sort({release_timestamp:-1}).limit(50);
  res.json({games:games.map(row)});
});

app.get('/api/hypervisor', async (req,res) => {
  const games = await Game.find({status:'cracked',is_hypervisor_bypass:true}).sort({cracked_date:-1}).limit(50);
  res.json({games:games.map(row)});
});

app.get('/api/news', async (req,res) => {
  const limit = Math.min(parseInt(req.query.limit)||30,100);
  const tag   = req.query.tag;
  let q = News.find();
  if (tag==='bypass') q=q.where({$or:[{tag:'bypass'},{is_hypervisor:true}]});
  else if (tag)       q=q.where({tag});
  const news = await q.sort({created_utc:-1}).limit(limit);
  res.json({news});
});

app.post('/api/watchlist', async (req,res) => {
  const {session_id,game_id}=req.body;
  if (!session_id||!game_id) return res.status(400).json({error:'Missing fields'});
  try { await Watchlist.create({session_id,game_id}); } catch{}
  res.json({ok:true});
});
app.delete('/api/watchlist', async (req,res) => {
  await Watchlist.deleteOne(req.body);
  res.json({ok:true});
});
app.get('/api/watchlist/:sid', async (req,res) => {
  const items = await Watchlist.find({session_id:req.params.sid});
  const games = await Game.find({_id:{$in:items.map(w=>w.game_id)}});
  res.json({games:games.map(row)});
});
app.get('/api/watchlist/:sid/check', async (req,res) => {
  const items = await Watchlist.find({session_id:req.params.sid,notified:false});
  const games = await Game.find({_id:{$in:items.map(w=>w.game_id)},status:'cracked'});
  if (games.length) await Watchlist.updateMany({session_id:req.params.sid,game_id:{$in:games.map(g=>g._id)}},{notified:true});
  res.json({newlyCracked:games.filter(g=>!g.is_hypervisor_bypass).map(row),newlyBypassed:games.filter(g=>g.is_hypervisor_bypass).map(row)});
});

async function runSync(res) {
  res.json({ok:true,message:'Sync started'});
  await syncReddit();
  await enrichUnknown(30);
}
app.get('/api/sync',  (req,res)=>runSync(res));
app.post('/api/sync', (req,res)=>runSync(res));

app.get('/api/reimport', async (req,res) => {
  const del = await Game.deleteMany({status:'unknown',reddit_post_url:null,hypervisor_post_url:null});
  await setMeta('history_imported',false);
  res.json({ok:true,message:`Cleared ${del.deletedCount} stale games. Reimport started.`});
  bulkImport(true);
});

// ── CONNECT MONGODB THEN START JOBS ──────────────────────────────────────────
const MONGO = process.env.MONGODB_URI;
if (!MONGO) { console.error('MONGODB_URI not set'); process.exit(1); }

mongoose.connect(MONGO, { serverSelectionTimeoutMS: 30000 })
  .then(async () => {
    console.log('MongoDB connected');
    dbReady = true;
    // Run jobs now that DB is ready
    await syncReddit();
    await enrichUnknown(50);
    await bulkImport();
    // Sync every 2 hours
    cron.schedule('0 */2 * * *', async () => { await syncReddit(); await enrichUnknown(30); });
  })
  .catch(e => { console.error('MongoDB failed:', e.message); process.exit(1); });
