# Nutflix

No Nut November, the streaming parody. Starring HODL, the peanut with diamond hands.
Static site: one `index.html` plus the artwork in `public/`. No build step.

## Run locally

```bash
cd public && python3 -m http.server 8080
```

Then open http://localhost:8080. Wallet extensions (Phantom, MetaMask) only inject on `http://localhost` or `https://` pages, not on `file://`.

## Deploy on Cloudflare Pages

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick the repo.
3. Build settings: Framework preset **None**, Build command **(empty)**, Build output directory **`public`**.
4. Deploy. Add your domain under the project's Custom domains tab.

## What works where

| Feature | Static hosting (this repo) | claude.ai artifact |
|---|---|---|
| Landing, profiles, shows, tempters, guest mode | ✅ | ✅ |
| Wallet sign-in (Phantom / MetaMask signature) | ✅ | depends on the browser extension |
| Nut Rewards streak | ✅ saved in the visitor's browser | ✅ saved in the shared database |
| Admin view of every linked wallet | ❌ needs a backend | ✅ |

The admin view and shared storage use the claude.ai runtime (`window.claude`), which does not exist on your own domain; the page detects that and falls back to browser storage. Adding a Cloudflare backend (Pages Functions + D1) brings them back.

## Notes

- `$NUT` is a points system in the page, not a token. Rewards are not paid on-chain.
- Watch and claim dates are reported by the visitor's browser and can be faked; only the wallet signature is proof.
- Nutflix is a parody. No explicit content, just innuendo.
