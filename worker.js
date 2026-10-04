// Layered – Stripe Checkout backend (Cloudflare Worker)
// Prices are recomputed HERE from the catalog, never trusted from the browser.

const CATALOG = [
  ['Spiral Bloom Planter', 28, 1], ['Aria Lathe Vase', 34, 1], ['Halo Mood Lamp', 46, 1],
  ['Stackr Desk Organizer', 24, 1], ['Tilt Phone Stand', 16, 1], ['CableCrab Holder', 12, 1],
  ['Flexi Dragon', 22, 1], ['Fidget Gear Trio', 14, 1], ['Grandmaster Chess Set', 79, 1],
  ['Cosplay Visor Gem', 38, 0], ['Dice Tower Keep', 42, 1], ['Tiny Titan Mini', 18, 1],
  ['Pocket Orbit Gift Box', 32, 1], ['Name Block Keychain', 9, 1],
]; // [name, price USD, in stock]
const MATS = { PLA: 1, PETG: 1.15, Resin: 1.4 };
const SIZES = { S: 0.8, M: 1, L: 1.4 };
const TAX_RATE = 0.08;            // matches the "Est. tax (8%)" shown on the site
const FREE_SHIP_OVER = 50;        // dollars
const PROMOS = { PRINT10: 10 };   // code -> percent off
const COUNTRIES = ['US'];         // add more, e.g. 'CA','GB'

const cents = (n) => Math.round(n * 100);
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

// Stripe wants form-encoded nested keys: a[b][0][c]=1
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
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: enc(body).join('&'),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || 'Stripe error');
  return d;
}

async function createCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Payments are not configured yet' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 40) return json({ error: 'Your cart is empty' }, 400);

  const line_items = [];
  let sub = 0;
  for (const it of items) {
    const p = CATALOG[it.id];
    const qty = Math.floor(Number(it.qty));
    if (!p || !(it.mat in MATS) || !(it.size in SIZES) || !(qty >= 1 && qty <= 50))
      return json({ error: 'Invalid item in cart' }, 400);
    if (!p[2]) return json({ error: `${p[0]} is out of stock` }, 400);
    const unit = cents(p[1] * MATS[it.mat] * SIZES[it.size]);
    sub += unit * qty;
    line_items.push({
      quantity: qty,
      price_data: {
        currency: 'usd',
        unit_amount: unit,
        product_data: {
          name: p[0],
          description: `${it.mat} · Size ${it.size}`,
          metadata: { product_id: it.id, material: it.mat, size: it.size, color: String(it.color || '').slice(0, 20) },
        },
      },
    });
  }

  // Promo
  const code = String(body.promo || '').toUpperCase();
  const pct = PROMOS[code] || 0;

  // Estimated sales tax as its own line. Computed on the pre-discount subtotal because
  // the coupon below is applied to every line, which shrinks the tax by the same percent.
  const tax = Math.round(sub * TAX_RATE);
  if (tax > 0) {
    line_items.push({
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: tax, product_data: { name: 'Estimated sales tax (8%)' } },
    });
  }

  const standard = sub >= cents(FREE_SHIP_OVER) ? 0 : 599;
  const origin = new URL(request.url).origin;

  const params = {
    mode: 'payment',
    line_items,
    shipping_address_collection: { allowed_countries: COUNTRIES },
    phone_number_collection: { enabled: true },
    shipping_options: [
      { shipping_rate_data: { type: 'fixed_amount', display_name: 'Standard (3–5 days)',
          fixed_amount: { amount: standard, currency: 'usd' } } },
      { shipping_rate_data: { type: 'fixed_amount', display_name: 'Express (1–2 days)',
          fixed_amount: { amount: 999, currency: 'usd' } } },
    ],
    success_url: `${origin}/?checkout=success`,
    cancel_url: `${origin}/?checkout=cancel`,
    metadata: { promo: pct ? code : '' },
  };

  if (pct) {
    const coupon = await stripe(env, 'coupons', { percent_off: pct, duration: 'once', name: code });
    params.discounts = [{ coupon: coupon.id }];
  }

  try {
    const s = await stripe(env, 'checkout/sessions', params);
    return json({ url: s.url });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/checkout') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      return createCheckout(request, env);
    }
    return env.ASSETS.fetch(request); // serve the website from /public
  },
};
