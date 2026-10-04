import { DurableObject } from 'cloudflare:workers';

// Layered – Stripe on-site checkout backend (Cloudflare Worker)
// Prices are recomputed HERE from the catalog, never trusted from the browser.
// Needs two settings in Cloudflare:
//   STRIPE_SECRET_KEY       (Secret)  sk_test_... / sk_live_...
//   STRIPE_PUBLISHABLE_KEY  (Text)    pk_test_... / pk_live_...

const CATALOG = [
  ['Spiral Bloom Planter', 28, 1], ['Aria Lathe Vase', 34, 1], ['Halo Mood Lamp', 46, 1],
  ['Stackr Desk Organizer', 24, 1], ['Tilt Phone Stand', 16, 1], ['CableCrab Holder', 12, 1],
  ['Flexi Dragon', 22, 1], ['Fidget Gear Trio', 14, 1], ['Grandmaster Chess Set', 79, 1],
  ['Cosplay Visor Gem', 38, 0], ['Dice Tower Keep', 42, 1], ['Tiny Titan Mini', 18, 1],
  ['Pocket Orbit Gift Box', 32, 1], ['Name Block Keychain', 9, 1],
]; // [name, price USD, in stock]
const MATS = { PLA: 1, PETG: 1.15, Resin: 1.4 };
const SIZES = { S: 0.8, M: 1, L: 1.4 };
const TAX_RATE = 0.08;          // matches the "Est. tax (8%)" on the site
const FREE_SHIP_OVER = 5000;    // cents
const STANDARD_SHIP = 599;      // cents
const EXPRESS_SHIP = 999;       // cents
const PROMOS = { PRINT10: 10 }; // code -> percent off

const cents = (n) => Math.round(n * 100);
const json = (o, status = 200, h = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...h } });

class Bad extends Error {}

async function quote(body, env) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 40) throw new Bad('Your cart is empty');
  const lines = [];
  let sub = 0;
  for (const it of items) {
    if (it.custom) { const L = await customLine(it, env); lines.push(L); sub += L.total; continue; }
    const p = CATALOG[it.id];
    const qty = Math.floor(Number(it.qty));
    if (!p || !(it.mat in MATS) || !(it.size in SIZES) || !(qty >= 1 && qty <= 50)) throw new Bad('Invalid item in cart');
    if (!p[2]) throw new Bad(`${p[0]} is out of stock`);
    const unit = cents(p[1] * MATS[it.mat] * SIZES[it.size]);
    sub += unit * qty;
    lines.push({ name: p[0], detail: `${it.mat} · Size ${it.size}`, qty, unit, total: unit * qty, key: `${it.id}:${it.mat}:${it.size}:${qty}` });
  }
  const pct = PROMOS[String(body.promo || '').toUpperCase()] || 0;
  const discount = Math.round((sub * pct) / 100);
  const options = { standard: sub >= FREE_SHIP_OVER ? 0 : STANDARD_SHIP, express: EXPRESS_SHIP };
  const shipping = body.shipping === 'express' ? 'express' : 'standard';
  const tax = Math.round((sub - discount) * TAX_RATE);
  const total = sub - discount + options[shipping] + tax;
  return { lines, sub, discount, pct, tax, options, shipping, total };
}

function enc(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') enc(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

async function stripe(env, path, body) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: enc(body).join('&'),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || 'Stripe error');
  return d;
}

const s = (v, n = 200) => String(v ?? '').trim().slice(0, n);

async function handle(request, env, path) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  try {
    const q = await quote(body, env);

    if (path === '/api/quote') {
      const { lines, ...rest } = q;
      return json({ ...rest, lines, publishableKey: env.STRIPE_PUBLISHABLE_KEY || '' });
    }

    // /api/payment-intent
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'Payments are not configured yet' }, 500);
    const email = s(body.email, 200), name = s(body.name, 100), a = body.address || {};
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Bad('Please enter a valid email');
    if (name.length < 2) throw new Bad('Please enter your name');
    if (s(a.line1).length < 3 || s(a.postal_code).length < 3 || s(a.country, 2).length !== 2) throw new Bad('Please enter your full shipping address');
    const address = {
      line1: s(a.line1), line2: s(a.line2), city: s(a.city), state: s(a.state),
      postal_code: s(a.postal_code, 20), country: s(a.country, 2).toUpperCase(),
    };
    if (address.country !== 'US') throw new Bad('We currently ship within the United States only');
    const pi = await stripe(env, 'payment_intents', {
      amount: q.total,
      currency: 'usd',
      ...(body.cardOnly ? { payment_method_types: ['card'] } : { automatic_payment_methods: { enabled: true } }),
      receipt_email: email,
      description: 'Layerly order',
      shipping: { name, address },
      metadata: {
        items: q.lines.map((l) => l.key).join(';').slice(0, 480),
        promo: q.pct ? s(body.promo).toUpperCase() : '',
        shipping: q.shipping,
        email,
        custom: q.lines.filter((l) => l.file).map((l) => `${l.file.name} -> /api/admin/stl?key=${l.file.key}`).join(' | ').slice(0, 490),
      },
    });
    return json({ clientSecret: pi.client_secret });
  } catch (e) {
    return json({ error: e.message }, e instanceof Bad ? 400 : 502);
  }
}


/* ---------- LIVE REVIEWS ---------- */
const REQUIRE_PURCHASE = true; // only people with a paid Stripe order can review (keeps reviews real)
const BAD = /\b(fuck\w*|shit\w*|bitch\w*|cunt|nigg\w*|fag\w*|retard\w*|whore|slut|asshole|dick)\b/i;

export class ReviewHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, rating INTEGER, text TEXT, ts INTEGER, who TEXT UNIQUE)');
  }
  list() {
    const sql = this.ctx.storage.sql;
    const reviews = sql.exec('SELECT id,name,rating,text,ts FROM reviews ORDER BY id DESC LIMIT 100').toArray();
    const st = sql.exec('SELECT COUNT(*) c, AVG(rating) a FROM reviews').one();
    return { reviews, count: st.c, avg: st.c ? Math.round(st.a * 10) / 10 : null };
  }
  async fetch(request) {
    const u = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'init', ...this.list() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (u.pathname === '/add' && request.method === 'POST') {
      const r = await request.json();
      try {
        this.ctx.storage.sql.exec('INSERT INTO reviews(name,rating,text,ts,who) VALUES(?,?,?,?,?)', r.name, r.rating, r.text, Date.now(), r.who);
      } catch { return json({ error: 'This purchase already has a review. Thank you!' }, 409); }
      const data = this.list();
      for (const ws of this.ctx.getWebSockets()) { try { ws.send(JSON.stringify({ type: 'update', ...data })); } catch {} }
      return json({ ok: true, ...data });
    }
    return json(this.list());
  }
  webSocketMessage() {}
  webSocketClose(ws) { try { ws.close(); } catch {} }
}

const hub = (env) => env.REVIEWS.get(env.REVIEWS.idFromName('main'));

async function hasPaidOrder(env, email) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Reviews are not available yet');
  if (/["\\]/.test(email)) throw new Error('Invalid email');
  const q = `status:"succeeded" AND receipt_email:"${email}"`;
  const r = await fetch('https://api.stripe.com/v1/payment_intents/search?limit=1&query=' + encodeURIComponent(q), {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Could not verify your order right now');
  return d.data.length > 0;
}

async function moderate(env, text) {
  if (BAD.test(text) || /https?:\/\/|www\./i.test(text)) return false;
  const r = await env.AI.run('@cf/meta/llama-guard-3-8b', { messages: [{ role: 'user', content: text }] });
  const v = r && r.response;
  return typeof v === 'object' && v !== null ? v.safe === true : /^\s*safe/i.test(String(v));
}

async function postReview(request, env) {
  let b; try { b = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const u = await me(request, env);
  if (!u) return json({ error: 'Please log in to leave a review' }, 401);
  const name = s(b.name || u.name, 40), text = s(b.text, 500), email = u.email;
  const rating = Math.round(Number(b.rating));
  if (name.length < 2) return json({ error: 'Please enter your name' }, 400);
  if (text.length < 10) return json({ error: 'Please write at least 10 characters' }, 400);
  if (!(rating >= 1 && rating <= 5)) return json({ error: 'Please pick a star rating' }, 400);
  try {
    if (REQUIRE_PURCHASE && !(await hasPaidOrder(env, email)))
      return json({ error: 'We could not find a paid order for the email you are logged in with. Log in with the email you used at checkout.' }, 403);
    if (!(await moderate(env, name + '. ' + text)))
      return json({ error: 'Your review did not pass our automatic content check. Please reword it.' }, 422);
  } catch (e) { return json({ error: e.message || 'Please try again' }, 503); } // fails closed: nothing posts unless checks pass
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  const who = [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return hub(env).fetch('https://hub/add', { method: 'POST', body: JSON.stringify({ name, rating, text, who }) });
}

/* ---------- CUSTOM PRINTS ---------- */
const CM = { PLA: 1, PETG: 1.2, Resin: 2.2, Nylon: 1.6, TPU: 1.5 };
const CL = { draft: [1.3, '0.3 mm draft'], standard: [1, '0.2 mm standard'], fine: [1.5, '0.1 mm fine'] };
const CF = { none: [0, 'As printed'], sanded: [6, 'Sanded'], painted: [14, 'Sanded + painted'] };
const files = (env) => env.FILES.get(env.FILES.idFromName('main'));
const users = (env) => env.USERS.get(env.USERS.idFromName('main'));

async function customLine(it, env) {
  const qty = Math.floor(Number(it.qty)), inf = Math.round(Number(it.infill));
  if (!(it.mat in CM) || !(it.layer in CL) || !(it.finish in CF) || !(inf >= 5 && inf <= 100) || !(qty >= 1 && qty <= 500) || !/^stl\/[0-9a-f-]{36}\.stl$/.test(String(it.fileKey)))
    throw new Bad('Invalid custom print in cart');
  const f = await files(env).head(it.fileKey);
  if (!f) throw new Bad('Your uploaded file is gone. Please re-add the custom print.');
  const vol = Math.max(0.6, Math.min(6, f.size / 150000));
  const up = (6 + vol * 5 * CM[it.mat] * CL[it.layer][0]) * (1 + inf / 150) + CF[it.finish][0];
  const unit = cents(up * (qty >= 10 ? 0.85 : qty >= 5 ? 0.92 : 1));
  return { name: 'Custom print: ' + f.name.slice(0, 40), detail: `${it.mat} · ${CL[it.layer][1]} · ${inf}% infill · ${CF[it.finish][1]}`, qty, unit, total: unit * qty,
    key: `C:${it.fileKey.slice(4, 12)}:${it.mat}:${it.layer}:${inf}:${it.finish}:${qty}`, file: { name: f.name, key: it.fileKey } };
}

export class FileHub extends DurableObject {
  constructor(c, e) {
    super(c, e); const q = c.storage.sql;
    q.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,name TEXT,size INTEGER,ts INTEGER)');
    q.exec('CREATE TABLE IF NOT EXISTS chunks(k TEXT,i INTEGER,d BLOB,PRIMARY KEY(k,i))');
    q.exec('CREATE TABLE IF NOT EXISTS rl(ip TEXT,ts INTEGER)');
  }
  save(key, name, buf, ip) {
    const q = this.ctx.storage.sql, now = Date.now();
    q.exec('DELETE FROM rl WHERE ts<?', now - 36e5);
    if (q.exec('SELECT COUNT(*) c FROM rl WHERE ip=?', ip).toArray()[0].c >= 10) return { error: 'Too many uploads. Try again later.' };
    if (q.exec('SELECT COALESCE(SUM(size),0) s FROM meta').toArray()[0].s + buf.byteLength > 2e9) return { error: 'Uploads are full right now.' };
    this.ctx.storage.transactionSync(() => {
      q.exec('INSERT INTO rl VALUES(?,?)', ip, now); q.exec('INSERT INTO meta VALUES(?,?,?,?)', key, name, buf.byteLength, now);
      for (let i = 0, n = 0; i < buf.byteLength; i += 1000000, n++) q.exec('INSERT INTO chunks VALUES(?,?,?)', key, n, buf.slice(i, i + 1000000));
    });
    return { ok: true };
  }
  head(key) { return this.ctx.storage.sql.exec('SELECT name,size FROM meta WHERE k=?', key).toArray()[0] || null; }
  read(key) {
    const m = this.head(key); if (!m) return null;
    const out = new Uint8Array(m.size); let o = 0;
    for (const r of this.ctx.storage.sql.exec('SELECT d FROM chunks WHERE k=? ORDER BY i', key)) { const u = new Uint8Array(r.d); out.set(u, o); o += u.length; }
    return { name: m.name, buf: out.buffer };
  }
}

async function upload(request, env) {
  const url = new URL(request.url), name = s(url.searchParams.get('name'), 80).replace(/[^\w.\- ]/g, '_');
  if (!/\.stl$/i.test(name)) return json({ error: 'Please choose an .stl file' }, 400);
  if (Number(request.headers.get('Content-Length') || 0) > 2e7) return json({ error: 'File too large (20 MB max)' }, 413);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 2e7 || buf.byteLength < 84) return json({ error: 'That does not look like a valid STL file (20 MB max)' }, 400);
  const head = new TextDecoder().decode(buf.slice(0, 400));
  const bin = 84 + new DataView(buf).getUint32(80, true) * 50 === buf.byteLength, asc = /^\s*solid/i.test(head) && /facet/.test(head);
  if (!bin && !asc) return json({ error: 'That does not look like a valid STL file' }, 400);
  const key = `stl/${crypto.randomUUID()}.stl`, r = await files(env).save(key, name, buf, request.headers.get('CF-Connecting-IP') || 'x');
  return r.error ? json({ error: r.error }, 429) : json({ key, name, size: buf.byteLength });
}

/* ---------- LOGIN (email code, Google, GitHub) ---------- */
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const rnd = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
const ck = (r, n) => ((r.headers.get('Cookie') || '').split(/;\s*/).find((x) => x.startsWith(n + '=')) || '').slice(n.length + 1);
const setCk = (n, v, age) => `${n}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const me = (r, env) => users(env).me(ck(r, 'lay_s'));
const safeNext = (n) => (/^\/(?!\/)[\w\-\/.?=&#%]*$/.test(n || '') ? n : '/');

export class UserHub extends DurableObject {
  constructor(c, e) {
    super(c, e); const q = c.storage.sql;
    q.exec('CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY,name TEXT,ts INTEGER)');
    q.exec('CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY,email TEXT,exp INTEGER)');
    q.exec('CREATE TABLE IF NOT EXISTS codes(email TEXT PRIMARY KEY,h TEXT,exp INTEGER,tries INTEGER,sent INTEGER)');
    q.exec('CREATE TABLE IF NOT EXISTS rl(k TEXT,ts INTEGER)');
  }
  rate(k, max) {
    const q = this.ctx.storage.sql, n = Date.now(); q.exec('DELETE FROM rl WHERE ts<?', n - 36e5);
    if (q.exec('SELECT COUNT(*) c FROM rl WHERE k=?', k).toArray()[0].c >= max) return false;
    q.exec('INSERT INTO rl VALUES(?,?)', k, n); return true;
  }
  async newCode(email, ip) {
    const q = this.ctx.storage.sql, n = Date.now(), p = q.exec('SELECT sent FROM codes WHERE email=?', email).toArray()[0];
    if (p && n - p.sent < 30000) return { error: 'Please wait 30 seconds before asking for another code.' };
    if (!this.rate('e' + email, 5) || !this.rate('i' + ip, 20)) return { error: 'Too many codes requested. Try again in an hour.' };
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
    q.exec('INSERT OR REPLACE INTO codes VALUES(?,?,?,?,?)', email, await sha(email + ':' + code), n + 6e5, 0, n);
    return { code };
  }
  async check(email, code) {
    const q = this.ctx.storage.sql, r = q.exec('SELECT * FROM codes WHERE email=?', email).toArray()[0];
    if (!r || r.exp < Date.now()) return { error: 'That code expired. Request a new one.' };
    if (r.tries >= 5) { q.exec('DELETE FROM codes WHERE email=?', email); return { error: 'Too many wrong tries. Request a new code.' }; }
    if (r.h !== (await sha(email + ':' + code))) { q.exec('UPDATE codes SET tries=tries+1 WHERE email=?', email); return { error: 'Wrong code. Check the email and try again.' }; }
    q.exec('DELETE FROM codes WHERE email=?', email); return this.login(email, '');
  }
  async login(email, name) {
    const q = this.ctx.storage.sql, n = Date.now(), t = rnd(32);
    q.exec('INSERT OR IGNORE INTO users VALUES(?,?,?)', email, (name || email.split('@')[0]).slice(0, 60), n);
    const u = q.exec('SELECT email,name FROM users WHERE email=?', email).toArray()[0];
    q.exec('INSERT INTO sessions VALUES(?,?,?)', await sha(t), email, n + 2592e6); return { token: t, user: u };
  }
  async me(t) {
    if (!t) return null;
    const r = this.ctx.storage.sql.exec('SELECT u.email,u.name,s.exp FROM sessions s JOIN users u ON u.email=s.email WHERE s.h=?', await sha(t)).toArray()[0];
    return r && r.exp > Date.now() ? { email: r.email, name: r.name } : null;
  }
  async out(t) { this.ctx.storage.sql.exec('DELETE FROM sessions WHERE h=?', await sha(t)); }
}

const OA = {
  google: { auth: 'https://accounts.google.com/o/oauth2/v2/auth', scope: 'openid email profile', tok: 'https://oauth2.googleapis.com/token', id: 'GOOGLE_CLIENT_ID', sec: 'GOOGLE_CLIENT_SECRET' },
  github: { auth: 'https://github.com/login/oauth/authorize', scope: 'read:user user:email', tok: 'https://github.com/login/oauth/access_token', id: 'GITHUB_CLIENT_ID', sec: 'GITHUB_CLIENT_SECRET' },
};
async function oauthProfile(pv, tk) {
  if (pv === 'google') {
    const u = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + tk } })).json();
    return u.email_verified ? { email: u.email, name: u.name } : null;
  }
  const h = { Authorization: 'Bearer ' + tk, 'User-Agent': 'layerly', Accept: 'application/json' };
  const es = await (await fetch('https://api.github.com/user/emails', { headers: h })).json(), u = await (await fetch('https://api.github.com/user', { headers: h })).json();
  const e = Array.isArray(es) && es.find((x) => x.primary && x.verified);
  return e ? { email: e.email, name: u.name || u.login } : null;
}

async function auth(request, env, url) {
  const origin = url.origin, seg = url.pathname.split('/'), act = seg[3], post = request.method === 'POST';
  if (act === 'providers') return json({ google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET), email: !!env.RESEND_API_KEY });
  if (act === 'me') return json({ user: await me(request, env) });
  if (act === 'logout' && post) { await users(env).out(ck(request, 'lay_s')); return json({ ok: true }, 200, { 'Set-Cookie': setCk('lay_s', '', 0) }); }
  if ((act === 'send' || act === 'verify') && post) {
    let b; try { b = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const email = s(b.email, 200).toLowerCase();
    if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(email)) return json({ error: 'Enter a valid email address' }, 400);
    if (act === 'verify') {
      const r = await users(env).check(email, s(b.code, 10));
      return r.error ? json({ error: r.error }, 400) : json({ user: r.user }, 200, { 'Set-Cookie': setCk('lay_s', r.token, 2592000) });
    }
    if (!env.RESEND_API_KEY) return json({ error: 'Email codes are not set up yet (site owner: add RESEND_API_KEY).' }, 503);
    const r = await users(env).newCode(email, request.headers.get('CF-Connecting-IP') || 'x');
    if (r.error) return json({ error: r.error }, 429);
    const m = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || 'Layerly <onboarding@resend.dev>', to: [email], subject: `Your Layerly code: ${r.code}`,
        text: `Your Layerly verification code is ${r.code}. It expires in 10 minutes. If you did not ask for it, ignore this email.` }) });
    if (!m.ok) { console.log('resend', m.status, await m.text()); return json({ error: 'We could not send the email. (Owner: check RESEND_API_KEY and MAIL_FROM in Resend.)' }, 502); }
    return json({ ok: true });
  }
  const o = OA[act], fail = (t) => Response.redirect(origin + '/login?error=' + encodeURIComponent(t), 302);
  if (!o) return json({ error: 'Not found' }, 404);
  if (!env[o.id] || !env[o.sec]) return fail('That sign-in is not set up yet');
  const redir = `${origin}/api/auth/${act}/callback`;
  if (seg[4] !== 'callback') {
    const st = rnd(16), q = new URLSearchParams({ client_id: env[o.id], redirect_uri: redir, response_type: 'code', scope: o.scope, state: st });
    return new Response(null, { status: 302, headers: { Location: o.auth + '?' + q, 'Set-Cookie': setCk('lay_o', st + '.' + encodeURIComponent(safeNext(url.searchParams.get('next'))), 600) } });
  }
  const raw = ck(request, 'lay_o'), i = raw.indexOf('.'), st = raw.slice(0, i), nx = safeNext(decodeURIComponent(raw.slice(i + 1))), code = url.searchParams.get('code');
  if (!st || st !== url.searchParams.get('state') || !code) return fail('Sign-in was canceled or expired');
  const tr = await fetch(o.tok, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env[o.id], client_secret: env[o.sec], code, redirect_uri: redir, grant_type: 'authorization_code' }) }).then((r) => r.json()).catch(() => ({}));
  if (!tr.access_token) return fail('Sign-in failed. Please try again');
  const p = await oauthProfile(act, tr.access_token).catch(() => null);
  if (!p || !p.email) return fail('We could not get a verified email from that account');
  const l = await users(env).login(p.email.toLowerCase(), p.name), h = new Headers({ Location: origin + nx });
  h.append('Set-Cookie', setCk('lay_s', l.token, 2592000)); h.append('Set-Cookie', setCk('lay_o', '', 0));
  return new Response(null, { status: 302, headers: h });
}

async function adminStl(request, env) {
  const u = await me(request, env);
  if (!u || !env.OWNER_EMAIL || u.email !== env.OWNER_EMAIL.toLowerCase().trim()) return json({ error: 'Not allowed' }, 403);
  const f = await files(env).read(new URL(request.url).searchParams.get('key') || '');
  if (!f) return json({ error: 'Not found' }, 404);
  return new Response(f.buf, { headers: { 'Content-Type': 'model/stl', 'Content-Disposition': `attachment; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"` } });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/auth/')) return auth(request, env, new URL(request.url));
    if (pathname === '/api/upload' && request.method === 'POST') return upload(request, env);
    if (pathname === '/api/admin/stl') return adminStl(request, env);
    if (pathname === '/api/reviews/live') return hub(env).fetch(request);
    if (pathname === '/api/reviews') {
      if (request.method === 'POST') return postReview(request, env);
      return hub(env).fetch('https://hub/list');
    }
    if (pathname === '/api/quote' || pathname === '/api/payment-intent') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      return handle(request, env, pathname);
    }
    return env.ASSETS.fetch(request); // serve the website from /public
  },
};
