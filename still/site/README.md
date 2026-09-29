# Still download page

Canonical page assets are in `public/`. They use local CSS/JavaScript and system
fonts; there are no trackers, remote fonts, cookies, or analytics. The screenshot
is a copy of `../../designs/margin-ink-grayscale.png` and is clearly labeled an
interface preview/design study, not a released browser screenshot.

Stage only this page into the existing website checkout:

```
python3 still/site/copy-site.py --site-root /Users/jacob/code/jacobalbertschmidt
```

This copies files into `public/still/` only. It does not alter the homepage,
shared partials, server, deployment, authentication, or DNS. The existing site
serves this directory at `/still/`. Staging also copies the canonical release
manifest, so update the canonical manifest before copying a new release.

## Release manifest

`public/releases.json` starts with `{ "schemaVersion": 1, "releases": [] }`.
The page shows **Build pending** for all platforms and contains no download
links. No fabricated artifact is included. The publisher must upload and check
real artifacts before adding entries; browser-side validation cannot confirm
that a remote object's bytes actually match its declared hash.

A published release has `version`, `publishedAt` (UTC ISO timestamp), and
`artifacts`. Each artifact requires:

| Field | Accepted values |
| --- | --- |
| `platform` | `macos`, `windows`, or `linux` |
| `arch` | `arm64` or `x64` |
| `filename` | Starts `Still-`/`Still_` or lowercase equivalent; ASCII letters, numbers, dots, underscores and hyphens only |
| `url` | Stable public HTTPS URL, no credentials/query/fragment/custom port; final filename must match |
| `sha256` | Exactly 64 hexadecimal characters |
| `size` | Actual positive integer byte length, at most 20 GiB |

Allowed formats are DMG/ZIP on macOS, EXE/MSI/ZIP on Windows, and
AppImage/DEB/RPM/TAR.XZ on Linux. Version strings have 2–4 dotted numeric
components and an optional prerelease suffix. Impossible/future publication
dates are rejected. The newest valid artifact for each platform, architecture,
and format is selected. Invalid entries cannot become links; missing/malformed
manifest data displays an unavailable state. All text enters the DOM through
`textContent`, and no release data becomes HTML.

Keep the manifest empty until a release genuinely exists. Publishing automation
should copy the exact uploaded byte size, SHA-256, filename, and URL here only
after object upload and verification succeed. Linux/Windows installer packaging
and macOS signing/notarization are separate from this static page.

## Validation

`npm test` uses Node's built-in test runner, with no dependencies. For responsive
browser checks, provide an existing Playwright installation and Chromium:

```
STILL_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
STILL_CHROMIUM=/path/to/chromium npm run test:browser
```

Browser checks exercise 1440, 768, 390, and 320 pixel widths, preview loading,
no horizontal overflow, no external asset requests, empty/valid/malformed
manifest states, checksum disclosure, and absence of JavaScript errors.
Screenshots go to ignored `test-results/`. Test download URLs are intercepted
fixtures and are never published in the real manifest or followed.
