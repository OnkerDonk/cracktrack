const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

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
function nextId(rows) { return rows.length === 0 ? 1 : Math.max(...rows.map(r => r.id || 0)) + 1; }

function dbUpsertGame(game) {
  const games = readTable('games');
  const idx = games.findIndex(g =>
    (game.igdb_id && g.igdb_id === game.igdb_id) ||
    (game.id && g.id === game.id) ||
    (!game.igdb_id && !game.id && g.title && game.title && g.title.toLowerCase() === game.title.toLowerCase())
  );
  const now = new Date().toISOString();
  if (idx >= 0) { games[idx] = { ...games[idx], ...game, updated_at: now }; }
  else { games.push({ id: nextId(games), created_at: now, updated_at: now, status: 'unknown', ...game }); }
  writeTable('games', games);
  return games[idx >= 0 ? idx : games.length - 1];
}

function dbBatchUpsertGames(newGames) {
  const games = readTable('games');
  const byIgdbId = new Map();
  const byTitle  = new Map();
  games.forEach((g, i) => { if (g.igdb_id) byIgdbId.set(g.igdb_id, i); if (g.title) byTitle.set(g.title.toLowerCase(), i); });
  let added = 0;
  const now = new Date().toISOString();
  for (const game of newGames) {
    const ei = game.igdb_id && byIgdbId.has(game.igdb_id) ? byIgdbId.get(game.igdb_id)
             : game.title && byTitle.has(game.title.toLowerCase()) ? byTitle.get(game.title.toLowerCase()) : -1;
    if (ei >= 0) {
      const ex = games[ei];
      games[ei] = { ...ex, igdb_id: game.igdb_id||ex.igdb_id, cover_url: game.cover_url||ex.cover_url, release_date: game.release_date||ex.release_date, release_timestamp: game.release_timestamp||ex.release_timestamp, platforms: game.platforms||ex.platforms, genres: game.genres||ex.genres, summary: game.summary||ex.summary, slug: game.slug||ex.slug, updated_at: now };
    } else {
      const id = nextId(games);
      const entry = { id, created_at: now, updated_at: now, status: 'unknown', ...game };
      games.push(entry);
      if (game.igdb_id) byIgdbId.set(game.igdb_id, games.length-1);
      if (game.title)   byTitle.set(game.title.toLowerCase(), games.length-1);
      added++;
    }
  }
  writeTable('games', games);
  return added;
}

function dbFindGame(predicate) { return readTable('games').find(predicate) || null; }

function dbUpsertNews(item) {
  const news = readTable('news');
  const idx = news.findIndex(n => n.reddit_id === item.reddit_id);
  if (idx >= 0) { news[idx] = { ...news[idx], ...item }; }
  else { news.push({ id: nextId(news), fetched_at: new Date().toISOString(), ...item }); }
  writeTable('news', news);
}
function dbAddWatchlist(session_id, game_id) {
  const wl = readTable('watchlist');
  if (!wl.find(w => w.session_id === session_id && w.game_id === game_id)) {
    wl.push({ id: nextId(wl), session_id, game_id, added_at: new Date().toISOString(), notified: false });
    writeTable('watchlist', wl);
  }
}
function dbRemoveWatchlist(session_id, game_id) {
  writeTable('watchlist', readTable('watchlist').filter(w => !(w.session_id === session_id && w.game_id === game_id)));
}
function dbGetWatchlistGames(session_id) {
  const wl = readTable('watchlist').filter(w => w.session_id === session_id);
  const games = readTable('games');
  return wl.map(w => { const g = games.find(g => g.id === w.game_id); return g ? { ...g, added_at: w.added_at, notified: w.notified, watch_id: w.id } : null; }).filter(Boolean);
}

// IGDB
let igdbToken = null, igdbTokenExpiry = 0;
async function getIgdbToken() {
  if (igdbToken && Date.now() < igdbTokenExpiry) return igdbToken;
  const { IGDB_CLIENT_ID: clientId, IGDB_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) { console.warn('No IGDB credentials'); return null; }
  try {
    const res = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`);
    igdbToken = res.data.access_token;
    igdbTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    console.log('IGDB token OK');
    return igdbToken;
  } catch(e) { console.error('IGDB auth failed:', e.message); return null; }
}
async function igdbSearch(query, limit=10) {
  const token = await getIgdbToken(); if (!token) return [];
  try {
    const res = await axios.post('https://api.igdb.com/v4/games',
      `fields name,slug,cover.url,first_release_date,platforms.name,genres.name,summary; search "${query.replace(/"/g,'')}"; where platforms = (6) & version_parent = null; limit ${limit};`,
      { headers: { 'Client-ID': process.env.IGDB_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' } });
    return res.data || [];
  } catch(e) { console.error('IGDB search error:', e.message); return []; }
}
async function igdbFetchPage(afterTs, beforeTs, offset=0) {
  const token = await getIgdbToken(); if (!token) return [];
  try {
    const res = await axios.post('https://api.igdb.com/v4/games',
      `fields name,slug,cover.url,first_release_date,platforms.abbreviation,genres.name; where platforms = (6) & first_release_date >= ${Math.floor(afterTs/1000)} & first_release_date <= ${Math.floor(beforeTs/1000)} & first_release_date != null & category = (0,8,9); sort first_release_date desc; limit 500; offset ${offset};`,
      { headers: { 'Client-ID': process.env.IGDB_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' } });
    return res.data || [];
  } catch(e) { console.error('IGDB page error:', e.message); return []; }
}
function formatIgdbGame(g) {
  const releaseTs = g.first_release_date ? g.first_release_date * 1000 : null;
  return { igdb_id: g.id, title: g.name, slug: g.slug, cover_url: g.cover?.url ? 'https:'+g.cover.url.replace('t_thumb','t_cover_big') : null, release_date: releaseTs ? new Date(releaseTs).toISOString().split('T')[0] : null, release_timestamp: releaseTs, platforms: g.platforms?.map(p=>p.abbreviation||p.name).join(', ')||null, genres: g.genres?.map(g=>g.name).join(', ')||null, summary: g.summary||null };
}

async function bulkImportHistory(forceRedo=false) {
  const meta = readMeta();
  if (meta.history_imported && !forceRedo) { console.log('History already imported ('+meta.history_total+' games). Use /api/reimport to redo.'); return; }
  if (!process.env.IGDB_CLIENT_ID) { console.warn('No IGDB credentials — skipping history import'); return; }
  console.log('Starting 2-year bulk import (batch mode)...');
  const now = Date.now();
  const tenYearsAgo = now - (2 * 365.25 * 24 * 60 * 60 * 1000);
  const SIX_MONTHS = 6 * 30 * 24 * 60 * 60 * 1000;
  let totalAdded = 0, chunkEnd = now, chunkStart = chunkEnd - SIX_MONTHS;
  while (chunkEnd > tenYearsAgo) {
    const label = new Date(chunkStart).toISOString().slice(0,7);
    console.log(`  Fetching ${label}...`);
    let offset = 0, chunkBatch = [];
    while (true) {
      await new Promise(r => setTimeout(r, 300));
      const page = await igdbFetchPage(chunkStart, chunkEnd, offset);
      if (!page.length) break;
      page.forEach(g => chunkBatch.push(formatIgdbGame(g)));
      if (page.length < 500) break;
      offset += 500;
    }
    if (chunkBatch.length) { const added = dbBatchUpsertGames(chunkBatch); totalAdded += added; console.log(`    ${chunkBatch.length} fetched, ${added} new`); }
    chunkEnd = chunkStart; chunkStart = chunkEnd - SIX_MONTHS;
  }
  const m2 = readMeta(); m2.history_imported = true; m2.history_import_date = new Date().toISOString(); m2.history_total = readTable('games').length; writeMeta(m2);
  console.log('Bulk import done. Total games: ' + m2.history_total);
}

// Reddit parser
const CRACK_PATTERNS = [/^\[CRACKED\]\s*(.+?)(?:\s*[\(\[].+[\)\]])?\s*[-–]\s*(.+)$/i,/^\[CRACKED\]\s*(.+)$/i,/^(.+?)\s+(?:has been |is now )?cracked\s+by\s+(.+)$/i,/^(.+?)\s*[-–]\s*cracked$/i];
const UNCRACKED_PATTERNS = [/^\[UNCRACKED\]\s*(.+)/i,/^\[STATUS\]\s*(.+)/i];
const HYPERVISOR_PATTERNS = [/hypervisor/i,/hyper-?v\b/i,/vm\s*bypass/i,/virtual\s*machine\s*bypass/i,/vmware.*bypass/i,/bypass.*hypervisor/i,/anti[\s-]?vm.*bypass/i,/\[hypervisor/i,/hv\s*bypass/i];
const DRM_PATTERNS = {'Denuvo':/denuvo/i,'Steam DRM':/steam\s*drm/i,'EGS DRM':/epic\s*game|egs\s*drm/i,'VMProtect':/vmprotect/i,'Arxan':/arxan/i,'Enigma':/enigma\s*protector/i,'FADE':/\bfade\b/i};

function extractSceneFilename(title) {
  const m = title.match(/([A-Za-z0-9._-]{10,}(?:v[\d.]+|Build[\d]+|Update|DLC|REPACK|FitGirl|EMPRESS|SKIDROW|CODEX|PLAZA|CPY|RUNE|TiNYiSO|P2P|GOG|MULTI\d+)[A-Za-z0-9._-]*)/i);
  if (m) return m[1];
  const gm = title.match(/[-–]\s*([A-Z0-9]{3,12})\s*$/);
  return gm ? gm[1] : null;
}

function parseRedditPost(post) {
  const title = post.title || '', flair = (post.link_flair_text||'').toUpperCase(), fullText = title+' '+(post.selftext||'');
  let status = 'unknown', gameName = null, crackGroup = null;
  const isHV = HYPERVISOR_PATTERNS.some(p => p.test(fullText)) || flair.includes('HYPERVISOR') || flair.includes('HV BYPASS');
  if (isHV) {
    // Hypervisor bypass = cracked but also flagged as hypervisor
    status = 'cracked';
    gameName = title.replace(/^\[.*?\]\s*/,'').replace(/hypervisor\s*bypass/i,'').replace(/[-–].*$/,'').trim();
  } else {
    if (flair.includes('CRACKED')||flair.includes('SCENE')) status='cracked';
    else if (flair.includes('UNCRACKED')||flair.includes('DENUVO')) status='uncracked';
    for (const p of CRACK_PATTERNS) { const m=title.match(p); if(m){gameName=m[1]?.trim();crackGroup=m[2]?.trim();status='cracked';break;} }
    if (!gameName) { for (const p of UNCRACKED_PATTERNS) { const m=title.match(p); if(m){gameName=m[1]?.trim();status='uncracked';break;} } }
    if (!gameName) gameName = title.replace(/^\[.*?\]\s*/,'').trim();
  }
  let drm = null;
  for (const [name,pattern] of Object.entries(DRM_PATTERNS)) { if(pattern.test(fullText)){drm=name;break;} }
  const sceneFilename = extractSceneFilename(title);
  const createdDate = post.created_utc ? new Date(post.created_utc*1000).toISOString().split('T')[0] : null;
  let tag = 'scene';
  if (isHV) tag='bypass'; else if (flair.includes('CRACK')||status==='cracked') tag='release'; else if (drm) tag='drm'; else if (/update|patch/i.test(title)) tag='update'; else if (/bypass|remove/i.test(title)) tag='bypass';
  return { gameName, status, crackGroup, drm, sceneFilename, createdDate, tag, isHV };
}

async function fetchRedditPosts(sort='new', limit=100) {
  try {
    const res = await axios.get(`https://www.reddit.com/r/CrackWatch/${sort}.json?limit=${limit}&t=month`, { headers:{'User-Agent':'CrackTrack/1.0'}, timeout:15000 });
    return res.data?.data?.children?.map(c=>c.data)||[];
  } catch(e) { console.error('Reddit error:', e.message); return []; }
}
async function fetchHypervisorPosts() {
  try {
    const res = await axios.get('https://www.reddit.com/r/CrackWatch/search.json?q=hypervisor+bypass&restrict_sr=1&sort=new&limit=50', { headers:{'User-Agent':'CrackTrack/1.0'}, timeout:15000 });
    return res.data?.data?.children?.map(c=>c.data)||[];
  } catch(e) { return []; }
}

async function syncCrackWatch() {
  console.log('Syncing r/CrackWatch...');
  const [newPosts, hotPosts, hvPosts] = await Promise.all([fetchRedditPosts('new',100), fetchRedditPosts('hot',50), fetchHypervisorPosts()]);
  const seen = new Set();
  const unique = [...newPosts,...hotPosts,...hvPosts].filter(p => { if(seen.has(p.id))return false; seen.add(p.id);return true; });
  let cracked=0, hv=0, news=0;
  for (const post of unique) {
    const parsed = parseRedditPost(post);
    const postUrl = `https://reddit.com${post.permalink}`;
    const postDate = post.created_utc ? new Date(post.created_utc*1000).toISOString().split('T')[0] : null;
    try { dbUpsertNews({ reddit_id:post.id, title:post.title, body:(post.selftext||'').slice(0,2000), url:postUrl, author:post.author, score:post.score||0, tag:parsed.tag, created_utc:post.created_utc||0, is_hypervisor:parsed.isHV }); news++; } catch{}
    if (!parsed.gameName || parsed.gameName.length < 2) continue;
    const existing = dbFindGame(g => g.title?.toLowerCase() === parsed.gameName.toLowerCase());
    const crackTs = post.created_utc ? post.created_utc*1000 : Date.now();
    if (parsed.isHV) {
      try {
        const daysToCrack = existing?.release_timestamp ? Math.round((crackTs-existing.release_timestamp)/86400000) : null;
        // HV games are cracked but also flagged with is_hypervisor_bypass = true
        dbUpsertGame({ ...(existing||{title:parsed.gameName}), status:'cracked', is_hypervisor_bypass:true, cracked_date: existing?.cracked_date||postDate, days_to_crack: existing?.days_to_crack||daysToCrack, hypervisor_post_url:postUrl, hypervisor_post_title:post.title, drm:parsed.drm||(existing?.drm), scene_filename:parsed.sceneFilename||(existing?.scene_filename) });
        hv++;
      } catch(e) { console.error('HV err:', e.message); }
    } else if (parsed.status === 'cracked') {
      try {
        if (existing) {
          if (existing.status !== 'cracked') {
            const d = existing.release_timestamp ? Math.round((crackTs-existing.release_timestamp)/86400000) : null;
            dbUpsertGame({ ...existing, status:'cracked', cracked_date:postDate, crack_group:parsed.crackGroup, days_to_crack:d, reddit_post_url:postUrl, reddit_post_title:post.title, scene_filename:parsed.sceneFilename||existing.scene_filename, drm:parsed.drm||existing.drm });
            cracked++;
          }
        } else {
          dbUpsertGame({ title:parsed.gameName, status:'cracked', cracked_date:postDate, crack_group:parsed.crackGroup, reddit_post_url:postUrl, reddit_post_title:post.title, scene_filename:parsed.sceneFilename, drm:parsed.drm });
          cracked++;
        }
      } catch(e) { console.error('Crack err:', e.message); }
    } else if (parsed.status === 'uncracked') {
      if (!existing) dbUpsertGame({ title:parsed.gameName, status:'uncracked', drm:parsed.drm, reddit_post_url:postUrl, scene_filename:parsed.sceneFilename });
    }
  }
  const meta=readMeta(); meta.last_reddit_sync=new Date().toISOString(); writeMeta(meta);
  console.log(`Reddit sync done: ${cracked} cracks, ${hv} HV, ${news} news`);
}

async function enrichWithIgdb(batchSize=20) {
  if (!process.env.IGDB_CLIENT_ID) return;
  const games = readTable('games').filter(g => !g.igdb_id && g.title).slice(0, batchSize);
  if (!games.length) return;
  console.log(`Enriching ${games.length} games...`);
  for (const game of games) {
    await new Promise(r => setTimeout(r,350));
    const results = await igdbSearch(game.title, 3);
    if (results.length > 0) {
      const fmt = formatIgdbGame(results[0]);
      const crackedTs = game.cracked_date ? new Date(game.cracked_date).getTime() : null;
      const d = fmt.release_timestamp && crackedTs ? Math.round((crackedTs-fmt.release_timestamp)/86400000) : game.days_to_crack;
      dbUpsertGame({ ...game, ...fmt, days_to_crack:d });
    }
  }
  console.log('Enrichment done');
}

// Scheduled sync every 2 hours
cron.schedule('0 */2 * * *', async () => { await syncCrackWatch(); await enrichWithIgdb(30); });

// Startup
setTimeout(async () => {
  await syncCrackWatch();
  await enrichWithIgdb(50);
  await bulkImportHistory();
}, 3000);

// ROUTES
function sortGames(games, sort) {
  switch(sort) {
    case 'date_asc':   return [...games].sort((a,b)=>(a.cracked_date||'').localeCompare(b.cracked_date||''));
    case 'date_desc':  return [...games].sort((a,b)=>(b.cracked_date||'').localeCompare(a.cracked_date||''));
    case 'days_asc':   return [...games].sort((a,b)=>(a.days_to_crack??99999)-(b.days_to_crack??99999));
    case 'days_desc':  return [...games].sort((a,b)=>(b.days_to_crack??-1)-(a.days_to_crack??-1));
    case 'alpha_asc':  return [...games].sort((a,b)=>(a.title||'').localeCompare(b.title||''));
    case 'alpha_desc': return [...games].sort((a,b)=>(b.title||'').localeCompare(a.title||''));
    case 'wait_desc':  return [...games].sort((a,b)=>(b.days_since_release||0)-(a.days_since_release||0));
    case 'wait_asc':   return [...games].sort((a,b)=>(a.days_since_release||0)-(b.days_since_release||0));
    default:           return [...games].sort((a,b)=>(b.cracked_date||'').localeCompare(a.cracked_date||''));
  }
}

function formatGameRow(g) {
  const releaseTs = g.release_timestamp;
  const daysSinceRelease = releaseTs ? Math.round((Date.now()-releaseTs)/86400000) : null;
  return { id:g.id, igdb_id:g.igdb_id, title:g.title, scene_filename:g.scene_filename||null, slug:g.slug, cover_url:g.cover_url, release_date:g.release_date, days_since_release:daysSinceRelease, platforms:g.platforms, genres:g.genres, summary:g.summary, status:g.status||'unknown', is_hypervisor_bypass:!!g.is_hypervisor_bypass, cracked_date:g.cracked_date, crack_group:g.crack_group, days_to_crack:g.days_to_crack, drm:g.drm, reddit_post_url:g.reddit_post_url, reddit_post_title:g.reddit_post_title, hypervisor_post_url:g.hypervisor_post_url||null, hypervisor_post_title:g.hypervisor_post_title||null, updated_at:g.updated_at };
}

app.get('/api/health', (req,res) => {
  const meta=readMeta(), games=readTable('games');
  res.json({ status:'ok', lastSync:meta.last_reddit_sync, historyImported:!!meta.history_imported, historyTotal:meta.history_total, gamesInDb:games.length, cracked:games.filter(g=>g.status==='cracked'||g.status==='hypervisor_bypass').length, uncracked:games.filter(g=>g.status==='uncracked').length, hypervisor:games.filter(g=>g.status==='hypervisor_bypass').length, uptime:Math.round(process.uptime())+'s' });
});

app.get('/api/reimport', async (req,res) => {
  const meta=readMeta(); meta.history_imported=false; writeMeta(meta);
  res.json({ ok:true, message:'Reimport started — check /api/health in ~10 min' });
  bulkImportHistory(true);
});

app.get('/api/search', async (req,res) => {
  const q = (req.query.q||'').trim().toLowerCase();
  if (!q) return res.json({ results:[] });
  let local = readTable('games').filter(g=>g.title?.toLowerCase().includes(q)).sort((a,b)=>(a.title?.toLowerCase()===q?0:1)-(b.title?.toLowerCase()===q?0:1)||(b.release_timestamp||0)-(a.release_timestamp||0)).slice(0,15);
  if (local.length) return res.json({ results:local.map(formatGameRow), source:'db' });
  const igdbResults = await igdbSearch(q,5);
  const formatted = igdbResults.map(g => { const fmt=formatIgdbGame(g); const ci=dbFindGame(dg=>dg.igdb_id===g.id); return {...fmt, status:ci?.status||'unknown', cracked_date:ci?.cracked_date||null, crack_group:ci?.crack_group||null, days_to_crack:ci?.days_to_crack||null, drm:ci?.drm||null, reddit_post_url:ci?.reddit_post_url||null, hypervisor_post_url:ci?.hypervisor_post_url||null, scene_filename:ci?.scene_filename||null}; });
  for (const g of formatted) { if (!dbFindGame(dg=>dg.igdb_id===g.igdb_id)) dbUpsertGame(g); }
  res.json({ results:formatted, source:'igdb' });
});

app.get('/api/game/:id', (req,res) => {
  const id=parseInt(req.params.id), game=dbFindGame(g=>g.id===id||g.igdb_id===id);
  if (!game) return res.status(404).json({error:'Not found'});
  res.json(formatGameRow(game));
});

app.get('/api/news', (req,res) => {
  const limit=Math.min(parseInt(req.query.limit)||30,100), tag=req.query.tag;
  let news=readTable('news');
  if (tag==='bypass') news=news.filter(n=>n.tag==='bypass'||n.is_hypervisor);
  else if (tag) news=news.filter(n=>n.tag===tag);
  res.json({ news:news.sort((a,b)=>(b.created_utc||0)-(a.created_utc||0)).slice(0,limit) });
});

// Returns all games with optional filter: ?filter=cracked|uncracked|hypervisor
app.get('/api/recent-cracks', (req,res) => {
  const limit=Math.min(parseInt(req.query.limit)||20,200);
  const sort=req.query.sort||'date_desc';
  const filter=req.query.filter||'all';
  let games=readTable('games').map(g=>({...g,days_since_release:g.release_timestamp?Math.round((Date.now()-g.release_timestamp)/86400000):null}));
  if (filter==='cracked')    games=games.filter(g=>g.status==='cracked'&&!g.is_hypervisor_bypass);
  else if (filter==='hypervisor') games=games.filter(g=>g.status==='cracked'&&g.is_hypervisor_bypass);
  else if (filter==='uncracked')  games=games.filter(g=>g.status==='uncracked');
  else games=games.filter(g=>g.status==='cracked'||g.status==='uncracked'); // all
  res.json({ games:sortGames(games,sort).slice(0,limit).map(formatGameRow) });
});

app.get('/api/uncracked', (req,res) => {
  const limit=Math.min(parseInt(req.query.limit)||30,200), sort=req.query.sort||'wait_desc';
  let games=readTable('games').filter(g=>g.status==='uncracked').map(g=>({...g,days_since_release:g.release_timestamp?Math.round((Date.now()-g.release_timestamp)/86400000):null}));
  res.json({ games:sortGames(games,sort).slice(0,limit).map(formatGameRow) });
});

app.get('/api/hypervisor', (req,res) => {
  const limit=Math.min(parseInt(req.query.limit)||30,100);
  const games=readTable('games').filter(g=>g.status==='cracked'&&g.is_hypervisor_bypass).sort((a,b)=>(b.release_timestamp||0)-(a.release_timestamp||0)).slice(0,limit);
  res.json({ games:games.map(formatGameRow) });
});

app.get('/api/stats', (req,res) => {
  const games=readTable('games'), meta=readMeta();
  const cracked=games.filter(g=>g.status==='cracked').length;
  const hv=games.filter(g=>g.status==='cracked'&&g.is_hypervisor_bypass).length;
  const uncracked=games.filter(g=>g.status==='uncracked').length;
  res.json({ total:games.length, cracked, uncracked, hypervisor:hv, lastSync:meta.last_reddit_sync||null, historyImported:!!meta.history_imported });
});

app.post('/api/watchlist', (req,res) => { const {session_id,game_id}=req.body; if(!session_id||!game_id)return res.status(400).json({error:'Missing'}); dbAddWatchlist(session_id,parseInt(game_id)); res.json({ok:true}); });
app.delete('/api/watchlist', (req,res) => { const {session_id,game_id}=req.body; dbRemoveWatchlist(session_id,parseInt(game_id)); res.json({ok:true}); });
app.get('/api/watchlist/:session_id', (req,res) => { res.json({games:dbGetWatchlistGames(req.params.session_id).map(formatGameRow)}); });
app.get('/api/watchlist/:session_id/check', (req,res) => {
  const games=readTable('games'), newlyCracked=[], newlyBypassed=[];
  const updated=readTable('watchlist').map(w => {
    if (w.session_id!==req.params.session_id||w.notified) return w;
    const game=games.find(g=>g.id===w.game_id);
    if (game?.status==='cracked'&&!game.is_hypervisor_bypass){newlyCracked.push(game);return{...w,notified:true};}
    if (game?.status==='cracked'&&game.is_hypervisor_bypass){newlyBypassed.push(game);return{...w,notified:true};}
    return w;
  });
  if (newlyCracked.length+newlyBypassed.length>0) writeTable('watchlist',updated);
  res.json({newlyCracked:newlyCracked.map(formatGameRow),newlyBypassed:newlyBypassed.map(formatGameRow)});
});

async function runSync(res) { res.json({ok:true,message:'Sync started'}); await syncCrackWatch(); await enrichWithIgdb(30); }
app.post('/api/sync', (req,res)=>runSync(res));
app.get('/api/sync',  (req,res)=>runSync(res));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CrackTrack API on port ${PORT}`));
