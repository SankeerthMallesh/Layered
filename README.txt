LAYERED - SETUP (read this once)

WHAT'S IN THIS FOLDER
  public/index.html     the shop
  public/checkout.html  the payment page
  worker.js             talks to Stripe (needs the two keys below)
  wrangler.jsonc        tells Cloudflare how to deploy

1) UPLOAD TO GITHUB
   Open your Layered repo > Add file > Upload files.
   Drag in: the "public" folder, worker.js, wrangler.jsonc.
   (Drag what is INSIDE this folder, not the folder itself.)
   Commit changes. Cloudflare redeploys in about a minute.

2) STRIPE KEYS IN CLOUDFLARE (one time)
   Workers & Pages > layered > Settings > Variables and secrets
     STRIPE_SECRET_KEY       type: Secret   value: sk_test_...
     STRIPE_PUBLISHABLE_KEY  type: Text     value: pk_test_...
   For real payments later, swap in the sk_live_ and pk_live_ keys.

3) ALWAYS TEST ON THE LIVE ADDRESS
   https://layered.sankeethe-best09.workers.dev
   Do NOT double-click index.html on your computer. Checkout only works on the live site.
   Press Cmd+Shift+R after each deploy so Chrome loads the newest version.
   Test card: 4242 4242 4242 4242, any future date, any CVC.

4) IF PRICES CHANGE
   Change the price in public/index.html AND in the list at the top of worker.js.
