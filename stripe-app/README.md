# The TinyTown Stripe App

This folder is the Stripe App that founders install to connect their Stripe account to TinyTown. It has no dashboard UI: it exists to ask for **read-only** access to subscriptions and prices over OAuth, so nobody pastes a secret key.

- `stripe-app.json`: the app manifest. Before uploading, replace `YOUR-TINYTOWN-DOMAIN` (twice) with the domain TinyTown runs on, e.g. `tinytown.vercel.app`.
- `icon.png`: the 300×300 icon shown in the Stripe App Marketplace.

Upload it with the Stripe CLI from this folder:

```bash
stripe login
stripe apps upload
```

The full walkthrough (creating the app, test install links, publishing) is in `docs/SETUP.md`, section "Stripe App".
