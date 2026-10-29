// aman2.js = PlayTube ka server (Node.js 18+, koi bahari library nahi chahiye).
// Chalane ka tarika:  BOT_TOKEN=... CHANNEL_ID=... node aman2.js
// App <-> server <-> Telegram channel. Video Telegram mein rehta hai; login, referral aur likes data.json mein.
// Free upload aur membership ke nikam app (playtube.html) ke andar local hain.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Readable } = require('stream');

// ===== Yahan apni jaankari likh sakte ho (ya chalate samay bahar se do). Ye file sirf server par rehti hai, ise app ke log nahi dekh sakte. =====
const MY_BOT_TOKEN = '';   // BotFather wali NAYI token, jaise '123456:ABC...'
const MY_CHANNEL_ID = '';  // channel ki sankhya, jaise '-100123456789'
// ===== Ye file kisi public jagah (jaise public GitHub) par mat daalna, warna token sabko dikh jayegi. =====
const BOT_TOKEN = process.env.BOT_TOKEN || MY_BOT_TOKEN, CHANNEL_ID = process.env.CHANNEL_ID || MY_CHANNEL_ID;
const PORT = process.env.PORT || 3000;
const TG = process.env.TELEGRAM_API || 'https://api.telegram.org';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MAX_VIDEO = 20 * 1024 * 1024; // bot sirf 20 MB tak ki file wapas nikal sakta hai
const MAX_PHOTO = 10 * 1024 * 1024;
const REFERRAL_BONUS = 5;
if(!BOT_TOKEN || !CHANNEL_ID){ console.error('BOT_TOKEN aur CHANNEL_ID set karo'); process.exit(1); }

let db = { shorts: [], events: [], users: {}, logins: {}, payments: {}, evSeq: 0, secret: '' };
let hadLocal = false;
try{ Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); hadLocal = true; }catch(e){}
if(!db.secret) db.secret = crypto.randomBytes(32).toString('hex');
let timer = null;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(db), () => {}), 400); scheduleBackup(); };

// ---- Backup: Render jaisi free jagah par file mit jaati hai, isliye data ki copy Telegram channel mein (pin kiye hue message mein) rakhte hain.
// Channel PRIVATE hi rakhna (is copy mein login ka secret bhi hai) aur bot ko channel mein "Post messages" + "Edit messages" ki ijazat do.
let backupTimer = null, backupMsg = 0, backing = false, restoreDone = hadLocal; // jab tak purana data wapas na aa jaye, naya backup nahi bhejte (warna purana mit sakta hai)
function scheduleBackup(){ if(!restoreDone) return; clearTimeout(backupTimer); backupTimer = setTimeout(backupNow, Number(process.env.BACKUP_DELAY_MS || 25000)); }
async function backupNow(){
  if(backing) return scheduleBackup();
  backing = true;
  try{
    const blob = () => new Blob([JSON.stringify(db)], { type: 'application/json' });
    if(backupMsg){
      try{
        const f = new FormData();
        f.append('chat_id', CHANNEL_ID); f.append('message_id', String(backupMsg));
        f.append('media', JSON.stringify({ type: 'document', media: 'attach://f' })); f.append('f', blob(), 'playtube-data.json');
        await tg('editMessageMedia', f); return;
      }catch(e){ if(/not modified/i.test(e.message)) return; backupMsg = 0; }
    }
    const f = new FormData();
    f.append('chat_id', CHANNEL_ID); f.append('caption', 'PlayTube data backup. Isko mat hatana.'); f.append('document', blob(), 'playtube-data.json');
    backupMsg = (await tg('sendDocument', f)).message_id;
    const pin = new FormData(); pin.append('chat_id', CHANNEL_ID); pin.append('message_id', String(backupMsg)); pin.append('disable_notification', 'true');
    await tg('pinChatMessage', pin);
  }catch(e){ console.error('backup nahi hua (bot ko channel mein Edit messages ki ijazat do):', e.message); }
  finally{ backing = false; }
}
async function restore(){
  if(hadLocal) return; // is jagah file maujood hai, wahi sabse nayi hai
  try{
    const pm = (await tg('getChat?chat_id=' + encodeURIComponent(CHANNEL_ID))).pinned_message;
    if(!pm || !pm.document || pm.document.file_name !== 'playtube-data.json'){ restoreDone = true; return console.log('Koi purana backup nahi mila, naye sire se shuru.'); }
    const r = await fetch(`${TG}/file/bot${BOT_TOKEN}/${await filePath(pm.document.file_id)}`);
    Object.assign(db, await r.json()); backupMsg = pm.message_id;
    restoreDone = true; console.log('Telegram backup se data wapas aa gaya.');
  }catch(e){ console.error('restore nahi hua, backup band rakha hai taaki purana na mite:', e.message); }
}
save();

const hits = new Map();
function limited(key, max, ms){
  const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < ms);
  if(list.length >= max){ hits.set(key, list); return true; }
  list.push(now); hits.set(key, list); return false;
}
const clean = (v, n) => String(v == null ? '' : v).slice(0, n);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Telegram
async function tg(method, form){
  const r = await fetch(`${TG}/bot${BOT_TOKEN}/${method}`, { method: form ? 'POST' : 'GET', body: form });
  const j = await r.json();
  if(!j.ok) throw new Error(j.description || 'Telegram error');
  return j.result;
}
const pathCache = new Map();
async function filePath(fileId){
  const c = pathCache.get(fileId);
  if(c && c.exp > Date.now()) return c.path;
  const f = await tg('getFile?file_id=' + encodeURIComponent(fileId));
  pathCache.set(fileId, { path: f.file_path, exp: Date.now() + 45 * 60 * 1000 });
  return f.file_path;
}
// Login code: user bot mein /start dabata hai, bot code bhejta hai. (Public link ki zarurat nahi, bot khud messages mangta rehta hai.)
async function handleUpdate(u){
  const m = u.message;
  if(!m || !m.chat || m.chat.type !== 'private' || !m.from || !String(m.text || '').startsWith('/start')) return;
  const code = String(100000 + crypto.randomInt(900000)), uid = String(m.from.id), now = Date.now();
  for(const c of Object.keys(db.logins)) if(db.logins[c].uid === uid || db.logins[c].exp < now) delete db.logins[c];
  db.logins[code] = { uid, name: clean(m.from.first_name, 60), exp: now + 10 * 60 * 1000 };
  save();
  const f = new FormData();
  f.append('chat_id', String(m.chat.id));
  f.append('text', `PlayTube login code: ${code}\n10 minute ke andar ye code app mein daalo.`);
  await tg('sendMessage', f);
}
async function pollTelegram(){
  try{ await tg('deleteWebhook'); }catch(e){}
  let offset = 0;
  for(;;){
    try{
      const list = await tg('getUpdates?timeout=25&offset=' + offset);
      for(const u of list){ offset = u.update_id + 1; try{ await handleUpdate(u); }catch(e){ console.error('update:', e.message); } }
    }catch(e){ console.error('getUpdates:', e.message); await sleep(5000); }
  }
}
let botName = '';

// ---- login session (signed token)
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', db.secret).update(data).digest('base64url');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const makeToken = (uid) => { const body = b64u(JSON.stringify({ u: uid, e: Date.now() + 30 * 86400000 })); return body + '.' + sign(body); };
function readToken(req){
  const [body, sig] = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').split('.');
  if(!body || !sig || !same(sign(body), sig)) return null;
  try{ const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.e > Date.now() ? String(p.u) : null; }catch(e){ return null; }
}
const publicUser = (u) => ({ id: u.id, name: u.name, ref_code: u.ref_code, bonus: Object.values(db.users).filter(x => x.referred_by === u.id).length * REFERRAL_BONUS });
const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRefCode(){ for(;;){ const c = [...crypto.randomBytes(6)].map(b => alpha[b % alpha.length]).join(''); if(!Object.values(db.users).some(u => u.ref_code === c)) return c; } }

// ---- http helpers
function readBody(req, limit){
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if(size > limit){ reject(Object.assign(new Error('File bahut badi hai'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readJson = async (req) => JSON.parse((await readBody(req, 5000)).toString() || '{}');

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range,Accept-Ranges,Content-Length');
  if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x'), p = url.pathname, M = req.method;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try{
    if(M === 'GET' && p === '/api/config'){
      if(!botName) botName = (await tg('getMe')).username;
      return send(res, 200, { bot: botName, bonus: REFERRAL_BONUS });
    }

    if(M === 'POST' && p === '/api/login'){
      if(limited(ip + 'login', 20, 3600000)) return send(res, 429, { error: 'Thodi der baad try karo' });
      const b = await readJson(req), code = clean(b.code, 10), row = db.logins[code];
      if(!row || row.exp < Date.now()) return send(res, 400, { error: 'Code galat ya purana hai. Bot mein /start dabakar naya code lo.' });
      delete db.logins[code];
      let user = db.users[row.uid];
      if(!user){
        const ref = clean(b.ref, 20).toUpperCase();
        const refUser = ref ? Object.values(db.users).find(u => u.ref_code === ref) : null;
        user = db.users[row.uid] = { id: row.uid, name: clean(b.name, 60) || row.name || 'User', ref_code: newRefCode(), referred_by: refUser ? refUser.id : null, created: new Date().toISOString() };
      }
      save();
      return send(res, 200, { token: makeToken(user.id), user: publicUser(user) });
    }

    if(M === 'GET' && p === '/api/me'){
      const uid = readToken(req), user = uid && db.users[uid];
      return user ? send(res, 200, { user: publicUser(user) }) : send(res, 401, { error: 'Login karo' });
    }

    if(M === 'GET' && p === '/api/shorts')
      return send(res, 200, db.shorts.slice(-300).reverse().map(({ id, title, channel, kind, t }) => ({ id, title, channel, kind, t })));

    if(M === 'GET' && p === '/api/events'){
      const since = Number(url.searchParams.get('since') || 0);
      const rows = db.events.filter(e => e.id > since);
      return send(res, 200, { events: rows, max: rows.length ? rows[rows.length - 1].id : since });
    }

    if(M === 'POST' && p === '/api/event'){
      const uid = readToken(req);
      if(!uid || !db.users[uid]) return send(res, 401, { error: 'Pehle Telegram se sign in karo' });
      if(limited(uid + 'event', 60, 60000)) return send(res, 429, { error: 'Thoda ruko' });
      const e = await readJson(req);
      if(!['r', 's', 'w', 'm'].includes(e.k) || !e.tg) return send(res, 400, { error: 'galat event' });
      const ev = { k: e.k, tg: clean(e.tg, 200), v: clean(e.v, 20), x: clean(e.x, 300), n: clean(e.n, 60), u: uid, t: new Date().toISOString() };
      db.events = db.events.filter(o => !(o.k === ev.k && o.tg === ev.tg && o.u === ev.u && o.x === ev.x));
      ev.id = ++db.evSeq; db.events.push(ev); save();
      return send(res, 200, { ok: true });
    }

    if(M === 'POST' && p === '/api/upload'){
      if(limited(ip + 'upload', 10, 3600000)) return send(res, 429, { error: 'Ek ghante mein 10 se zyada upload nahi' });
      const mime = (req.headers['content-type'] || '').split(';')[0], isPhoto = mime.startsWith('image/');
      if(!isPhoto && !mime.startsWith('video/')) return send(res, 400, { error: 'Sirf video ya photo' });
      const limit = isPhoto ? MAX_PHOTO : MAX_VIDEO, sizeMsg = { error: `File ${limit / 1048576} MB se chhoti honi chahiye` };
      if(Number(req.headers['content-length'] || 0) > limit) return send(res, 413, sizeMsg);
      const uid = readToken(req), user = uid && db.users[uid];
      if(!user) return send(res, 401, { error: 'Pehle Telegram se sign in karo' });
      try{
        const buf = await readBody(req, limit);
        let title = '', channel = 'Unknown';
        try{ title = clean(decodeURIComponent(req.headers['x-title'] || ''), 150); channel = clean(decodeURIComponent(req.headers['x-channel'] || 'Unknown'), 60); }catch(e){}
        const form = new FormData();
        form.append('chat_id', CHANNEL_ID);
        form.append('caption', (title + ' | ' + channel).slice(0, 200));
        const field = isPhoto ? 'photo' : (mime === 'video/mp4' ? 'video' : 'document');
        form.append(field, new Blob([buf], { type: mime }), 'file');
        const r = await tg(field === 'photo' ? 'sendPhoto' : field === 'video' ? 'sendVideo' : 'sendDocument', form);
        const fileId = isPhoto ? r.photo[r.photo.length - 1].file_id : (r.video || r.document).file_id;
        const rec = { id: crypto.randomBytes(6).toString('hex'), title, channel, kind: isPhoto ? 'photo' : 'video', mime: isPhoto ? 'image/jpeg' : mime, file_id: fileId, msg_id: r.message_id, t: new Date().toISOString(), owner: uid };
        db.shorts.push(rec); save();
        return send(res, 200, { id: rec.id, kind: rec.kind });
      }catch(err){ throw err; }
    }

    if(M === 'GET' && p.startsWith('/media/')){
      const rec = db.shorts.find(s => s.id === p.slice(7));
      if(!rec) return send(res, 404, { error: 'nahi mila' });
      const r = await fetch(`${TG}/file/bot${BOT_TOKEN}/${await filePath(rec.file_id)}`, { headers: req.headers.range ? { Range: req.headers.range } : {} });
      const h = { 'Content-Type': rec.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
      ['content-length', 'content-range'].forEach(k => { if(r.headers.get(k)) h[k] = r.headers.get(k); });
      res.writeHead(r.status, h);
      return Readable.fromWeb(r.body).pipe(res);
    }

    if(M === 'GET' && (p === '/' || p === '/index.html')){
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'playtube.html')).pipe(res);
    }
    send(res, 404, { error: 'nahi mila' });
  }catch(err){
    console.error(err.message);
    if(!res.headersSent) send(res, err.code === 413 ? 413 : 500, { error: err.message });
    else res.end();
  }
});
restore().then(() => server.listen(PORT, () => { console.log('PlayTube server chal raha hai: http://localhost:' + PORT); pollTelegram(); }));
