# Deployment

## Current status

The prototype is live at **[interpretle.com](https://interpretle.com)**, first deployed on October 16, 2026. The app is a static React/Vite build. `wrangler.jsonc` configures Cloudflare Workers Static Assets, a single-page fallback, and the custom domain. There is no application server code and none is planned.

Deployments are manual. GitHub Actions checks changes but does not publish them. Cloudflare credentials stay outside the repository.

`public/_headers` adds `no-transform` to the default cache policy. This prevents Cloudflare from automatically injecting its Web Analytics script; see [Cloudflare's documented behavior](https://developers.cloudflare.com/web-analytics/get-started/). Keep this header when publishing updates.

Cloudflare currently recommends Workers for new projects. The relevant primary documentation is [Static Assets setup](https://developers.cloudflare.com/workers/static-assets/get-started/) and [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## Local validation

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
npm run deploy:check
```

`deploy:check` runs a local build and `wrangler deploy --dry-run`; it does not publish or change DNS. The configuration contains the requested `interpretle.com` custom domain. It contains no account ID or credential. A real deployment attaches that domain; a dry run does not.

## Publish an update

After verifying the intended Cloudflare account:

```sh
npx wrangler login
npm run build
npx wrangler deploy
```

The configuration attaches `interpretle.com` as a Worker custom domain. Review existing zone records before assigning a domain, then check the custom domain over HTTPS. The demo disclosure remains visible while data is synthetic. The repository itself can be public independently of the domain launch.

Workers Builds can connect directly to the public GitHub repository. Use Node 24+, build command `npm ci && npm run build`, and deployment command `npx wrangler deploy`. Keep account credentials in Cloudflare or secret storage; never put them in client-side `VITE_*` variables.

## When measured data arrives

Publish static puzzle packs and versioned model assets. Large offline activation caches or browser weight files can live in R2 or another static object store; the web server still only handles file requests. Fetch just the active puzzle's data. Load browser inference assets only when a player opts into a custom guess, with a download-size/progress display and persistent browser caching.

The browser scores custom input using WebGPU. If local inference is unsupported or runs out of memory, keep the precomputed passage game playable and report custom scoring as unavailable. Do not proxy the text to a server as a fallback. Keep browser-local attempts and quotas; competitive anti-cheat is outside scope.

The only hosted workload is static file delivery. Offline GPU preprocessing is a separate bounded job, not a live game dependency.
