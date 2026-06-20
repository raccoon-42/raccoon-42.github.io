# raccoon-42.github.io

Personal portfolio site for Ali Özkaya. Static, multi-page, with a light/dark
theme, responsive mobile nav, project links, and a downloadable CV.

Live: https://raccoon-42.github.io/

## Structure

```
index.html              # home (projects list)
about.html              # about / bio
projects.html           # projects detail
drawings.html           # art gallery (generated)
404.html                # on-brand not-found page (GitHub Pages serves this)
sitemap.xml             # search-engine sitemap
robots.txt              # crawler rules + sitemap pointer
assets/
  css/                  # style.css + hover/starfield/project-card/drawings styles
  js/                   # theme.js (theme + mobile nav), drawings.js (lightbox)
  img/                  # profile photo + icons
  img/drawings/         # gallery images (generated copy, do not edit by hand)
  og.png, favicon.*     # link-preview and favicons
  Ali_Ozkaya_CV.pdf     # downloadable CV (auto-synced, see below)
scripts/sync-cv.sh      # copies ~/cv/cv.pdf into assets/ before each commit
scripts/build-drawings.py  # regenerates drawings.html from a local source folder
```

## CV sync

`assets/Ali_Ozkaya_CV.pdf` is kept in sync with the real CV by a pre-commit
hook that runs `scripts/sync-cv.sh` (copies `~/cv/cv.pdf`, override with
`CV_PDF=/path/to/cv.pdf`). Install it on a fresh clone with:

```
ln -sf ../../scripts/sync-cv.sh .git/hooks/pre-commit
```

## Develop

It's plain HTML/CSS/JS. Open `index.html` in a browser, or serve locally:

```
python3 -m http.server
```
