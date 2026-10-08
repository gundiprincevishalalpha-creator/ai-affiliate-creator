# AI Affiliate Creator — Opera Mini Web App

A mobile-first, server-backed affiliate content generator. Open it in Opera Mini using the server URL; it is not an APK.

## What works without paid AI APIs
- Product URL analysis for HTML product pages and JSON product endpoints
- JSON-LD / OpenGraph / metadata extraction
- Verified/not-available fact states
- Legitimate product image URL collection from the retrieved page
- Affiliate URL kept separate from product URL
- Professional template-based platform copy
- SVG social poster generation
- Local project history
- Manual fallback
- MP4 image-to-video slideshow fallback when product images are downloadable and ffmpeg is available

## Optional AI provider
Set server environment variables:
- `AI_API_KEY`
- `AI_BASE_URL` (default: OpenAI-compatible `/v1` endpoint)
- `AI_MODEL` (default: `gpt-5-mini`)

The secret is server-side only. The browser never receives it.

## Run
```bash
npm start
```
Then open `http://SERVER-IP:8787/` in Opera Mini. For remote access, place the app behind HTTPS/reverse proxy.

## Security / production notes
This starter deliberately avoids automatic posting, mass messaging, fake engagement, fake reviews, or unsupported claims. Before public deployment add HTTPS, authentication, rate limiting, SSRF protection with an allow/deny policy, persistent database/object storage, job queue, image upload scanning, and a provider-specific legal/ToS policy.

## Test URL
A useful extraction test is `https://dummyjson.com/products/1` because it returns structured product data. Use any test affiliate URL for the second field. For a real retailer, extraction quality depends on the retailer's page/API, access controls, and terms.

### Opera Mini access
Run the server on a device/server reachable from the phone, then open its HTTP/HTTPS address in Opera Mini. For a public deployment, use a normal HTTPS domain and reverse proxy to port 8787.
