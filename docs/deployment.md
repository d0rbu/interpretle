# Deployment

## Current status

The app is a static React/Vite build. `wrangler.jsonc` configures Cloudflare Workers Static Assets, with a single-page fallback. There is no application server code and none is planned. No deployment or custom-domain route has been created by this initial implementation.

Cloudflare currently recommends Workers for new projects. The relevant primary documentation is [Static Assets setup](https://developers.cloudflare.com/workers/static-assets/get-started/) and [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## Local validation

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
npm run deploy:check
```

`deploy:check` runs a local build and `wrangler deploy --dry-run`; it does not publish or change DNS. The configuration deliberately contains no account ID or custom-domain route.

## Publish the prototype

After verifying the intended Cloudflare account:

```sh
npx wrangler login
npm run build
npx wrangler deploy
```

Check the resulting preview address. The demo disclosure should remain visible while data is synthetic. Add `interpretle.com` under the Worker's custom domains when ready. Review existing zone records before assigning the domain. The repository itself can be public independently of the domain launch.

Workers Builds can connect directly to the public GitHub repository. Use Node 24+, build command `npm ci && npm run build`, and deployment command `npx wrangler deploy`. Keep account credentials in Cloudflare or secret storage; never put them in client-side `VITE_*` variables.

## When measured data arrives

Publish static puzzle packs and versioned model assets. Large offline activation caches or browser weight files can live in R2 or another static object store; the web server still only handles file requests. Fetch just the active puzzle's data. Load browser inference assets only when a player opts into a custom guess, with a download-size/progress display and persistent browser caching.

The browser scores custom input using WebGPU. If local inference is unsupported or runs out of memory, keep the precomputed passage game playable and report custom scoring as unavailable. Do not proxy the text to a server as a fallback. Keep browser-local attempts and quotas; competitive anti-cheat is outside scope.

The only hosted workload is static file delivery. Offline GPU preprocessing is a separate bounded job, not a live game dependency.
