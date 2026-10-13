# Support macros

Saved replies for the support inbox. Each one: when to use it, the reply, and what to do before sending. Personalise the first line every time; nobody likes a reply that obviously didn't read their email. Replace `[brackets]`; cut any sentence you can't make true.

Longer playbooks (webhooks, disputes, breaches) are in `docs/RUNBOOK.md`. Customer-facing answers in full are in `docs/FAQ.md`.

---

## 1. Sign-in email didn't arrive

**Use when:** "I never got the link", "the email didn't come".
**Before sending:** check Supabase → Logs → Auth for their address (rate limited? sent?) and Resend → Logs (delivered? bounced?). If more than a couple of people report it in an hour, go to the RUNBOOK playbook instead.

> Hi [name],
>
> Sorry about that. Sign-in emails come from auth@YOUR-DOMAIN and usually arrive within a minute, so it's probably in spam or "Promotions". You can ask for a fresh one after a minute.
>
> The quickest route of all is **Continue with Google** or **Continue with GitHub** on the sign-in screen, as long as that account uses the same email address you joined the waitlist with ([their email]).
>
> If neither works, reply and I'll look into it straight away.

---

## 2. Not invited yet

**Use when:** "I signed up but it says I'm not invited", "when do I get in?"
**Before sending:** check the admin console: are they on the waitlist? Under which address? Already invited under another one?

> Hi [name],
>
> You're on the list ([the address we have]). We're letting people in in waves, oldest sign-ups first, so everyone gets a city that works properly. You'll get an email when it's your turn, [expected: e.g. "within the next few days"].
>
> Make sure you sign in with that same address; invites are tied to it. In the meantime the demo is free to play: YOUR-DOMAIN/?demo

[If they signed up under a different address, invite the right one by hand and say so.]

---

## 3. How do I cancel?

**Use when:** someone asks how to cancel, or says they want to stop.

> Hi [name],
>
> In TinyTown, open the account menu → **Manage billing**. That takes you to Stripe's billing page, where you can cancel in one click. You won't be charged again, and you'll keep your city until [end of their period].
>
> [Optional, if they seem unhappy:] If something didn't work for you, I'd really like to hear what. It's the most useful thing you could tell me.

[If they can't get in, cancel for them in Stripe (Subscriptions → Cancel → at period end) and say you've done it.]

---

## 4. Refund request (no refund)

**Use when:** a refund request that isn't one of the exceptions (see the next macro and RUNBOOK, "Disputes and refund requests").
**Before sending:** find the charge in Stripe. Check it isn't a double charge, a charge after cancelling, or a billing error. ⚖ If they're an EU/UK consumer within 14 days, follow whatever you decided in LAUNCH.md, "Needs your judgement".

> Hi [name],
>
> Thanks for writing, and I'm sorry TinyTown wasn't what you hoped. Plans are non-refundable, as the plan screen and checkout say before payment, so I can't refund this charge.
>
> I've cancelled your plan so you won't be charged again, and you'll keep your city until [date].
>
> If something didn't work, I'd really like to know what. If it's something we got wrong, I'll do my best to make it right.

[Judgement call: someone threatening a chargeback on a $12 charge. A dispute costs $15 you never get back, more than the charge. Refunding is usually the better outcome for both of you. Use macro 5's wording.]

---

## 5. Charged twice or charged in error (refund)

**Use when:** two charges for one person, a charge after a confirmed cancellation, the wrong plan or amount, or an exception you've decided to make.
**Before sending:** refund in Stripe (the payment → Refund). For two live subscriptions, cancel the newer one immediately and refund it in full. Refunding doesn't cancel a subscription: cancel too if that's what they want.

> Hi [name],
>
> You're right, and I'm sorry: [what happened, e.g. "you were charged twice on [date]" / "you were charged after cancelling"]. I've refunded $[amount] to your card. It usually shows up within 5–10 business days, depending on your bank.
>
> [If relevant:] Your plan is still active until [date] / I've cancelled the duplicate, so you'll be charged once from now on.

---

## 6. Stripe won't connect, or my numbers look wrong

**Use when:** "Connect Stripe failed", "my city is empty", "my MRR is wrong".
**Before sending:** admin console → their connections. Live or test? Connected at all? Errors on `/api/connect/stripe/callback`? Is the Stripe App published, or are they on the external test?

> Hi [name],
>
> Thanks, let's sort it out. The usual causes:
>
> - **Test mode.** TinyTown only counts live data, so a test-mode or sandbox account shows an empty city. Connect your live Stripe account.
> - **Permissions on Stripe.** Installing an app needs an admin role on the Stripe account. If someone else owns it, they may need to approve.
> - **MRR a little different from Stripe's chart.** TinyTown counts your main currency only, uses each subscription's current price, and doesn't model discounts or mid-month plan changes yet, so small differences are expected.
>
> [What you found in their account, in one sentence, and the fix.] If it's still not right, reply with a screenshot of what you see (no need to include any numbers you'd rather keep private) and I'll dig in.

---

## 7. What does TinyTown read? Is my data safe?

**Use when:** privacy or security questions before or after connecting.

> Hi [name],
>
> Good question to ask. In short:
>
> - **Stripe:** a read-only Stripe App with two permissions, subscriptions and prices. From those TinyTown works out your paying customers and MRR for each day. It can't see your customers' names, emails or card details, and it can't change anything.
> - **GitHub (optional):** read-only access to the repositories you choose. TinyTown reads commit dates and releases; it never reads your code.
> - **Storage:** the daily totals, your city, and the credential Stripe issues us, which is encrypted and never reaches your browser.
>
> You can export everything we hold, or delete your account, from the account menu at any time. The full detail is at YOUR-DOMAIN/legal/privacy.html and in the FAQ.

---

## 8. Please delete my account

**Use when:** a deletion request by email.
**Before sending:** **only act if it comes from the account's own email address.** Otherwise send the first variant. Then follow RUNBOOK, "Account deletion requests by email".

**If it's from a different address:**

> Hi,
>
> Happy to help. To protect your account, I can only delete it on a request from the account's own email address. Could you write from that address? Or, if you can sign in, the account menu has **Delete account**, which does it straight away.

**Once done:**

> Hi [name],
>
> Done. I've deleted your TinyTown account and everything we held for it: your city, saves, connections and metrics. Your plan is cancelled and you won't be charged again.
>
> One or two things only you can do, if you haven't already: uninstall the TinyTown app in Stripe (Settings → Installed apps) and, if it's still there, on GitHub (Settings → Applications → Installed GitHub Apps). Stripe keeps a record of past payments, as it does for any purchase.
>
> Thanks for trying TinyTown.
