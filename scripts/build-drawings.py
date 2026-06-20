#!/usr/bin/env python3
"""Build drawings.html from a local folder of images.

Usage:
  python3 scripts/build-drawings.py [SOURCE_DIR]
Images are copied into assets/img/drawings/ and drawings.html is regenerated.
"""
import os
import re
import shutil
import subprocess
import sys
from html import escape
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else Path.home() / "Downloads" / "drawings"
DST_DIR = REPO / "assets" / "img" / "drawings"
WEB_DIR = "assets/img/drawings"
OUT = REPO / "drawings.html"

HEX32 = re.compile(r"^[0-9a-f]{32}$")
HIGHLIGHT = re.compile(r"^highlight(\d+)$", re.I)


def dims(path):
    try:
        out = subprocess.check_output(
            ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
            text=True, stderr=subprocess.DEVNULL,
        )
        w = h = None
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("pixelWidth:"):
                w = int(line.split(":")[1])
            elif line.startswith("pixelHeight:"):
                h = int(line.split(":")[1])
        return w, h
    except Exception:
        return None, None


def slugify(stem):
    return re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")


# Titles that can't be derived from a plain ASCII, lowercase filename
# (diacritics, proper nouns). Keyed by the normalized lowercase title.
TITLE_OVERRIDES = {
    "baskaldiri": "başkaldırı",
    "a targaryen": "a Targaryen",
}


def titleize(stem):
    name = re.sub(r"\s+", " ", stem.replace("_", " ").replace("-", " ")).strip().lower()
    return TITLE_OVERRIDES.get(name, name)


def figure(item):
    title = item["title"]
    attrs = [
        'class="art"',
        f'data-full="{WEB_DIR}/{item["name"]}"',
        'tabindex="0"',
    ]
    alt = title or "Drawing by Ali Ozkaya"
    if title:
        attrs.insert(2, f'data-title="{escape(title, quote=True)}"')
    dim = ""
    if item["w"] and item["h"]:
        dim = f' width="{item["w"]}" height="{item["h"]}"'
    cap = f"\n        <figcaption>{escape(title)}</figcaption>" if title else ""
    return (
        f'      <figure {" ".join(attrs)}>\n'
        f'        <img src="{WEB_DIR}/{item["name"]}" alt="{escape(alt, quote=True)}" loading="lazy"{dim}>{cap}\n'
        f'      </figure>'
    )


def main():
    if not SRC.is_dir():
        sys.exit(f"source folder not found: {SRC}")
    DST_DIR.mkdir(parents=True, exist_ok=True)
    # clear previous copies so removed drawings disappear on rerun
    for old in DST_DIR.glob("*"):
        old.unlink()

    highlights, titled, untitled = [], [], []
    for p in sorted(SRC.iterdir()):
        if p.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        stem = p.stem
        w, h = dims(p)
        m = HIGHLIGHT.match(stem)
        if m:
            name = p.name.lower()
            shutil.copy2(p, DST_DIR / name)
            highlights.append({"name": name, "title": None, "w": w, "h": h, "order": int(m.group(1))})
        elif HEX32.match(stem):
            shutil.copy2(p, DST_DIR / p.name)
            untitled.append({"name": p.name, "title": None, "w": w, "h": h})
        else:
            slug = slugify(stem)
            name = f"{slug}{p.suffix.lower()}"
            shutil.copy2(p, DST_DIR / name)
            titled.append({"name": name, "title": titleize(stem), "w": w, "h": h})

    highlights.sort(key=lambda x: x["order"])
    titled.sort(key=lambda x: x["title"].lower())
    untitled.sort(key=lambda x: x["name"])

    hl_html = "\n".join(figure(i) for i in highlights)
    rest_html = "\n".join(figure(i) for i in titled + untitled)

    highlights_block = (
        f'    <p class="section-label">Highlights</p>\n'
        f'    <div class="highlights">\n{hl_html}\n    </div>\n' if highlights else ""
    )
    rest_label = '    <p class="section-label">More</p>\n' if highlights and rest_html else ""

    OUT.write_text(PAGE.format(
        highlights=highlights_block,
        rest_label=rest_label,
        masonry=rest_html,
    ))
    print(f"drawings.html: {len(highlights)} highlights, {len(titled)} titled, {len(untitled)} untitled "
          f"({len(highlights) + len(titled) + len(untitled)} total)")


PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Drawings | CodeSpace by Ali</title>
    <meta name="description" content="A gallery of drawings by Ali Ozkaya." />
    <link rel="icon" type="image/svg+xml" href="assets/favicon.svg" />
    <link rel="icon" type="image/png" sizes="32x32" href="assets/favicon-32.png" />
    <link rel="apple-touch-icon" href="assets/apple-touch-icon.png" />

    <!-- Open Graph / link preview -->
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Drawings | CodeSpace by Ali" />
    <meta property="og:description" content="A gallery of drawings by Ali Ozkaya." />
    <meta property="og:url" content="https://raccoon-42.github.io/drawings.html" />
    <meta property="og:image" content="https://raccoon-42.github.io/assets/og.png" />
    <meta name="twitter:card" content="summary_large_image" />

    <link rel="stylesheet" href="assets/css/style.css" />
    <link rel="stylesheet" href="assets/css/drawings.css" />

    <!-- Privacy-friendly analytics (GoatCounter) -->
    <script data-goatcounter="https://aliozkaya.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
</head>
<body class="page drawings-page">
    <nav>
        <button id="nav-toggle" class="nav-toggle" aria-label="Toggle menu" aria-expanded="false" aria-controls="nav-menu">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
            </svg>
        </button>
        <ul class="nav-menu" id="nav-menu">
            <li><a href="index.html">Home</a></li>
            <li><a href="about.html">About</a></li>
            <li><a href="projects.html">Projects</a></li>
            <li><a href="drawings.html" aria-current="page">Drawings</a></li>
            <li><a href="mailto:aliozkaya00@gmail.com">Contact</a></li>
            <li><a href="assets/Ali_Ozkaya_CV.pdf" download>CV</a></li>
        </ul>
        <button id="theme-toggle" class="change-color-theme" title="Toggle Theme">&#9728;&#65039;</button>
    </nav>

    <header>
        <div class="header-inner">
            <div class="content">
                <h1 class="drawings-title">Drawings</h1>
                <p class="drawings-subtitle">memories from a sketchbook</p>
            </div>
        </div>
    </header>

    <section class="gallery">
{highlights}{rest_label}    <div class="masonry">
{masonry}
    </div>
    </section>

    <div class="lightbox" id="lightbox" aria-hidden="true">
        <button class="close" aria-label="Close">&times;</button>
        <img src="" alt="">
        <figcaption></figcaption>
    </div>

    <script src="assets/js/theme.js"></script>
    <script src="assets/js/drawings.js"></script>
</body>
</html>
"""


if __name__ == "__main__":
    main()
