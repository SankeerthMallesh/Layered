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

5) LIVE REVIEWS (new)
   Nothing extra to set up: the review database (a Cloudflare Durable Object) and the
   safety check (Cloudflare Workers AI) are created automatically from wrangler.jsonc on deploy.
   Only customers with a paid Stripe order can review (they enter their checkout email).
   Reviews start empty. Every new review appears instantly for everyone, live.
   To allow anyone to review, set REQUIRE_PURCHASE to false at the top of the reviews
   section in worker.js (not recommended: then reviews can't be proven real).

6) PAYMENT METHODS
   Checkout now falls back to card automatically if Stripe can't load your dashboard's methods.
   For more (Cash App, Klarna, etc.) turn them on in Stripe > Settings > Payment methods,
   in the SAME mode (test/live) as your keys.

7) LOGIN + CUSTOM PRINTS (new) - add these in Cloudflare > layered > Settings > Variables and secrets
   EMAIL CODES (needed for the verification code): make a free account at resend.com, create an API key.
     RESEND_API_KEY (Secret). Without your own domain verified in Resend, it can only email YOU.
     To email customers: verify your domain in Resend and set MAIL_FROM (Text) = Layerly <login@yourdomain.com>
   GOOGLE (optional): Google Cloud Console > Credentials > OAuth client (Web). Redirect URI:
     https://layered.sankeethe-best09.workers.dev/api/auth/google/callback
     GOOGLE_CLIENT_ID (Text), GOOGLE_CLIENT_SECRET (Secret)
   GITHUB (optional): GitHub > Settings > Developer settings > OAuth Apps. Callback URL:
     https://layered.sankeethe-best09.workers.dev/api/auth/github/callback
     GITHUB_CLIENT_ID (Text), GITHUB_CLIENT_SECRET (Secret)
   A sign-in button only appears once its keys are set.
   OWNER_EMAIL (Text) = your email. Log in with it, then open the link in a Stripe payment's
     "custom" metadata to download a customer's STL file.
   Custom prints: uploaded STLs are added to the cart, priced on the server, paid at checkout; the file
   link is saved in the Stripe payment metadata.
