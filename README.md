# torr-edit

Inspect and edit torrent files and magnet links — **many at once**.

Inspired by [TorrentParts](https://torrent.parts). Built as a standalone static site with a
fresh UI, multi-torrent workbench, and a tracker list that refreshes itself daily.

![screenshot placeholder](https://img.shields.io/badge/torr--edit-static%20site-%230E7A6F)

## Features

- **Parse many torrents at once** — drop any number of `.torrent` files, or paste
  magnets / torrent URLs, one per line. Every one parses in parallel and opens in its
  own tab.
- **Full inspector** — info hash, name, created / created-by, comment, piece layout,
  tracker and webseed lists, and the file table (with total size).
- **Edit & export** — rename, re-comment, add/remove trackers and webseeds, then
  download the modified `.torrent`, copy the magnet, or copy a share link that opens
  the torrent right in the app.
- **Built-in working tracker list** — one click adds the stable
  [newTrackon](https://newtrackon.com/list) list. `trackers.txt` is re-fetched from
  newTrackon **every day at 04:23 UTC** by a GitHub Actions cron and committed only
  when it changes.
- **Batch actions** — add the tracker list to all torrents, download all as a single
  `.zip`, or copy every magnet at once.
- **Fetch file lists from peers** — for magnet-only torrents, pull the file list live
  via WebTorrent (WebSocket trackers) and then export a full `.torrent`.
- **Private by design** — everything runs in your browser; nothing is uploaded anywhere.

## How the tracker list works

| File | Purpose |
|------|---------|
| `trackers.txt` | snapshot of stable trackers from `https://newtrackon.com/api/stable` |
| `trackers-last-updated.txt` | timestamp of the last successful fetch |

`.github/workflows/update-trackers.yml` runs daily, fetches the list, normalizes it
(one per line, deduped, sorted), commits only if changed, and pushes — the Pages
workflow then re-deploys so the site always serves the fresh list.

The app loads `trackers.txt` from its own origin. If it's missing (e.g. opened as
`file://` or pre-first-run), it falls back to the live newTrackon API. The chip in the
top-right shows how many trackers are bundled and when the snapshot was taken; click it
to copy the whole list.

## Project layout

```
├── index.html               # input stage + workbench shell
├── trackers.txt             # daily-updated tracker snapshot (bot commits)
├── trackers-last-updated.txt
├── src/
│   ├── app.js               # multi-parse engine, editor, batch actions
│   └── style.css            # fingerprint-lab design system
└── .github/workflows/
    ├── update-trackers.yml  # daily tracker refresh (04:23 UTC)
    └── deploy.yml           # GitHub Pages deploy
```

No build step, no dependencies to install — plain ES modules over CDN
(`parse-torrent`, `buffer`, `bytes`, `mime-types`, `jszip`, `webtorrent`).

## Notes

- Share links are magnet URLs in the `#` fragment — parsing is 100% client-side.
- Torrents with no file metadata (pure magnets) can't be exported as `.torrent`
  until the file list is fetched from peers.
- Works best in a modern browser (ES2020+, Clipboard API). WebTorrent peer-fetching
  needs a live connection to WebSocket trackers.
