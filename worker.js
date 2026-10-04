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
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

class Bad extends Error {}

function quote(body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 40) throw new Bad('Your cart is empty');
  const lines = [];
  let sub = 0;
  for (const it of items) {
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
    const q = quote(body);

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
      automatic_payment_methods: { enabled: true },
      receipt_email: email,
      description: 'Layerly order',
      shipping: { name, address },
      metadata: {
        items: q.lines.map((l) => l.key).join(';').slice(0, 480),
        promo: q.pct ? s(body.promo).toUpperCase() : '',
        shipping: q.shipping,
      },
    });
    return json({ clientSecret: pi.client_secret });
  } catch (e) {
    return json({ error: e.message }, e instanceof Bad ? 400 : 502);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/quote' || pathname === '/api/payment-intent') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      return handle(request, env, pathname);
    }
    return env.ASSETS.fetch(request); // serve the website from /public
  },
};
