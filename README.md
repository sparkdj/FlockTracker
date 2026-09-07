# FlockTracker

Mobile-friendly single-page map that shows **nearby ALPR / license-plate cameras** (including **Flock Safety** when tagged) using public [OpenStreetMap](https://www.openstreetmap.org/) data.

**Live site (GitHub Pages):** https://sparkdj.github.io/FlockTracker/

## What it does

1. Asks for your browser location and centers the map on you.
2. Queries the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) for nearby surveillance cameras tagged as ALPR / ANPR / license-plate recognition (and Flock Safety manufacturer/brand tags).
3. Plots cameras on a Leaflet + OpenStreetMap map and lists them by distance.
4. Lets you change the search radius (3–25 km) and refresh.

## Data source & disclaimer

- Data comes from **crowdsourced OSM** via Overpass. Coverage is **incomplete** and may be **outdated or inaccurate**.
- This is **not** an official Flock Safety product.
- It does **not** access Flock private systems or any proprietary camera network — **public OSM/Overpass only**.
- Map data © OpenStreetMap contributors ([ODbL](https://www.openstreetmap.org/copyright)).

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell |
| `styles.css` | Mobile-first layout |
| `app.js` | Geolocation, Overpass, Leaflet UI |
| `manifest.webmanifest` | PWA manifest (name, icons, standalone) |
| `sw.js` | Service worker (installability + shell cache) |
| `icons/` | App icons (192, 512, apple-touch) |

No build step — plain static files.

## Open locally

Any static file server works. From this directory:

```bash
# Python
python3 -m http.server 8080

# Node (if you have npx)
npx --yes serve -p 8080
```

Then open http://localhost:8080/

You can also open `index.html` directly in a browser, but **geolocation and Overpass fetch often require HTTPS or localhost**, so a local server is preferred.

## GitHub Pages

Deployed from branch `main` / folder `/` (repo is public).

**https://sparkdj.github.io/FlockTracker/**


## Install as an app (PWA)

The live site is a Progressive Web App. After opening **https://sparkdj.github.io/FlockTracker/** once:

- **iPhone (Safari):** tap **Share** → **Add to Home Screen** → Add. Open from the Home Screen icon for a full-screen (standalone) experience.
- **Android (Chrome):** open the browser menu (⋮) → **Install app** or **Add to Home screen**. Or use the install banner if shown.

Requires HTTPS (GitHub Pages provides this). A service worker is registered so the app meets install criteria; shell assets are cached for offline open of the UI (map tiles and Overpass still need network).

## Privacy

Location stays in your browser. Queries sent to Overpass include a lat/lon and radius so nearby OSM features can be fetched; nothing is uploaded to this repository’s servers (there are none beyond GitHub Pages static hosting).
