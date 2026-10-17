# TinyTown FAQ

Customer-facing answers, written to paste into the site and into support replies. Keep them true: if the product changes, change the answer.

> **Before publishing:** two answers carry a **[confirm]** marker where the wording depends on a decision that's yours (data kept after cancelling; EU/UK refunds). Remove the markers once settled. Replace `support@YOUR-DOMAIN`.

---

## The basics

### What is TinyTown?
A little San Francisco Bay city that grows with your startup. It's built from your real numbers: Stripe revenue and paying customers, and (if you like) GitHub releases and commits. Every $1 of monthly recurring revenue becomes $10,000 a month for you to spend on the city, paid out daily. Your customers live there. Your own house moves up a rung each time your revenue gains a digit, from a hacker house all the way to a house on the moon.

### Is it a dashboard?
No. Your numbers are always one glance away, but the point is the city: something you built, that grows when your company grows.

### Can I buy in-game money or speed things up?
No, and you never will be able to. The only way to grow your city is to grow your startup. Your plan pays for the hosted game, never for money, land or unlocks.

---

## Price and billing

### How much is it?
**$29 a year.** That's $2.42 a month, paid once a year. There's one plan, with everything in it, and no monthly option. Payment is handled by Stripe.

### Is there a discount?
Sometimes, once. The first time you close the plan screen, we offer **$9 for your first year, then $29 a year** after that. It's a one-time offer: it stays open for 48 hours from when you first see it, it's for founders who haven't paid before, and it renews at the standard price (Checkout and the renewal reminder both say so). After 48 hours the price is $29 again.

### Can I pay in my own currency?
Usually, yes. The price is set in US dollars, and Stripe's checkout shows it in your local currency where it can, at Stripe's exchange rate (it includes a small conversion fee, and you can choose to pay in dollars instead). Your renewals are charged in the same currency.

### Is there a free trial?
No, but you can see a lot before paying. **The demo is free**, for as long as you like, with no account: it's the full game running on a sample startup's 540 days. **Setting up is free too**: create an account, connect Stripe, GitHub and your users, and you'll see your own MRR, residents and releases before you're asked to pay. The only thing behind the paywall is your own city.

### Why no free trial?
Because the demo already shows everything, and we'd rather you decide with your eyes open than with a card on file and a countdown. If the demo doesn't make you want your own city, TinyTown probably isn't for you, and that's fine.

### Can I get a refund?
Plans are **non-refundable**. That's stated on the plan screen and at checkout, before you pay. You can cancel any time and you keep your city until the end of the period you've paid for.

We do refund when we got it wrong: if you were charged twice, charged after cancelling, or charged the wrong amount, write to us and we'll put it right. [confirm: wording for EU/UK consumers' 14-day withdrawal right]

### How do I cancel?
In TinyTown, open **Manage billing** (in the account menu). It takes you to Stripe's billing page, where you can cancel in one click. You won't be charged again, and your city stays open until the end of the period you've paid for.

### Is there a monthly plan?
No. TinyTown is $29 a year and that's the only plan. If you subscribed when there was a monthly plan, you keep it until you cancel.

### Will I be reminded before my plan renews?
Yes. Stripe emails you before your plan renews each year, so it never comes as a surprise.

### Where are my invoices?
In **Manage billing**, under invoice history. Stripe also emails a receipt for each payment.

### My card failed. Will I lose my city?
No. Stripe retries the card over the next few weeks and emails you a link to update it. Your city stays open while it retries.

---

## Your data

### What does TinyTown read from my Stripe account?
You connect Stripe by installing the **TinyTown Stripe App** and approving it on Stripe. It asks for exactly two **read-only** permissions:

- **Subscriptions (read).** TinyTown lists every subscription on your account (all statuses, up to 5,000) and, for each one, uses its status, start date, end date, trial end, currency, and each item's price, billing interval and quantity, plus the customer ID so one customer with two subscriptions counts once.
- **Prices (read).** To turn those prices into monthly recurring revenue.

From that it works out, for every day since your first subscription, **how many paying customers you had and your MRR**. That's all the city needs.

What it **doesn't** ask for: your customers' names, emails or addresses, card or bank details, charges, invoices, payouts or balance. In a subscription record a customer appears only as an ID like `cus_…`. Stripe sends the whole subscription record, which can include descriptions or metadata you've set yourself; TinyTown ignores everything except the fields above and doesn't store the records.

### Can TinyTown change anything in my Stripe account?
No. Both permissions are read-only. TinyTown can't create, change, refund or cancel anything.

### What does TinyTown store from Stripe?
Your Stripe account ID, whether the connection is live or test, the daily totals above (paying customers and MRR per day), and the credential Stripe gives us to keep reading. That credential is **encrypted** (AES-256-GCM) and only our server can use it; your browser never sees it.

### How is my MRR worked out? It's slightly different from Stripe's number.
TinyTown adds up each running subscription's price, converted to a monthly amount (a yearly price divided by 12, and so on). It counts your main currency only (the one most of your subscriptions use), uses each subscription's current price for its whole history, and doesn't yet account for discounts or mid-month plan changes. So it can differ a little from Stripe's own MRR chart. Paying customers are the distinct customers with a subscription that's past any trial and hasn't ended; abandoned checkouts and unpaid subscriptions don't count.

### Why doesn't my test-mode data count?
Because the city only shows real numbers. Test-mode subscriptions aren't real revenue, so they never drive the game. If you connected a test-mode or sandbox account by mistake, connect your live account instead.

### What does TinyTown read from GitHub? Is GitHub required?
GitHub is **optional**. If you connect it, releases add floors to your HQ and commits speed up the train.

You connect by installing the **TinyTown GitHub App** on your account or organisation, choosing which repositories it can see, and then picking one repository for your city. It asks for two **read-only** permissions: **Metadata** and **Contents**.

TinyTown reads:
- the list of repositories you gave it access to (name, private or public, default branch), so you can pick one;
- your chosen repository's **recent commits** (up to the last 1,000), using only each commit's **date**;
- its **releases** (up to the last 500): name, tag, publish date, and whether it's a draft.

It stores the repository's name, your installation ID, commits per day, and your release names and dates.

**About "Contents: read":** GitHub requires this permission to list commits and releases. It would also allow reading files, and **TinyTown never does**: it only asks for commits and releases. GitHub's commit list also includes commit messages and author names; TinyTown counts the commits and throws the rest away.

### What about PostHog?
Optional. If you want your city's population to be your **monthly active users** rather than your paying customers, you can connect PostHog with a personal API key that has **Query: read** for one project. TinyTown runs one query: the number of monthly active users on each day of the last year. The key is stored encrypted and used only by our server. It could run other queries on that project, so create a key just for TinyTown, limited to that one project, and delete it in PostHog whenever you like.

You can also type a user count in by hand, or leave the population as your paying customers. TinyTown never invents users.

### Who can see my city?
Only you, when you're signed in. If you share a snapshot, your numbers are hidden unless you choose to show them.

### What do you keep about me, and who handles it?
Your email address, your city (the things you've built and where), your plan, your connections (as above), and your daily metrics. TinyTown runs on:

- **Vercel** (hosting the site and API),
- **Supabase** (sign-in and database),
- **Stripe** (taking payment for TinyTown; and, separately, the Stripe App you install),
- **Resend** (sending emails),
- **Sentry** (reports of errors in the app),
- **Cloudflare Turnstile** (the "are you human" check at sign-in),
- **Google** and **GitHub**, only if you sign in with them.

We don't sell data and don't show ads. The full detail is in the [privacy policy](/legal/privacy.html).

### Can I export my data?
Yes. In TinyTown's account menu choose **Export data**. You get a JSON file with everything we hold about you: your account, plan, connections (not the credentials themselves), your city, and your daily metrics.

### How do I delete my account?
In TinyTown's account menu choose **Delete account** and type your email to confirm. That cancels your plan (you won't be charged again), disconnects Stripe, GitHub and PostHog, and deletes your city, saves, connections and metrics. It can't be undone. It works whether or not you're on a plan.

TinyTown removes its GitHub App from your GitHub account where it can (not if a teammate's TinyTown city uses the same installation). Stripe doesn't let app makers uninstall their app for you, so uninstall the TinyTown app yourself in Stripe (Settings → Installed apps); once your account is deleted we hold no way to read it anyway. The delete screen tells you which of these is left for you. Stripe keeps a record of what you paid us, as it does for any purchase.

Can't get in? Email support@YOUR-DOMAIN **from your account's email address** and we'll do it for you.

### What happens to my city if I cancel?
You keep full access until the end of the period you've paid for. After that the city is locked: you can't open it, but it isn't deleted. **[confirm: We keep it until you delete your account.]** If you come back, it's exactly as you left it. And because your city's money is always worked out from your real revenue, the income from while you were away is waiting for you.

If you'd rather we didn't keep it, delete your account instead (above).

---

## Getting in

### I'm on the waitlist. When do I get in?
We're letting people in in waves, oldest sign-ups first, over a few days, so that everyone gets a city that works. You'll get an email when it's your turn. Sign in with the **same email address** you joined with.

### I didn't get the sign-in email.
It comes from auth@YOUR-DOMAIN and usually arrives within a minute. Check spam and "Promotions". You can ask for another after a minute. Or skip email entirely: **Continue with Google** or **Continue with GitHub** works too, as long as it's the same email address.

### Can I connect more than one startup?
One city per account today: one Stripe account and one GitHub repository.

---

## Browsers and phones

### What do I need to run it?
A recent **Chrome, Edge, Firefox or Safari** on a computer, with hardware acceleration turned on. TinyTown is a real 3D scene and needs **WebGL 2**, which every current browser has (Safari since version 15).

### Does it work on my phone?
Yes, on recent iPhones and Android phones, in the browser. It's a 3D city, so older phones may run it at lower detail or feel slow; a computer gives the best view.

### It says my browser can't show the city.
Usually hardware acceleration is off. Turn on "Use graphics acceleration" (Chrome, Edge) or the equivalent, then reload. Some work computers block the graphics driver; try another device.

---

## Still stuck?
Email **support@YOUR-DOMAIN**. A person reads every message, usually within a day.
