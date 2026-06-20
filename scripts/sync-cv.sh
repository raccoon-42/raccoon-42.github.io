#!/usr/bin/env sh
# Copy the latest compiled CV into the site's assets so the hosted copy
# tracks your real CV. Override the source with CV_PDF=/path/to/cv.pdf.
# Never blocks a commit: if the source is missing it just no-ops.

SRC="${CV_PDF:-$HOME/cv/cv.pdf}"
ROOT="$(git rev-parse --show-toplevel)"
DEST="$ROOT/assets/Ali_Ozkaya_CV.pdf"

if [ -f "$SRC" ]; then
  if ! cmp -s "$SRC" "$DEST" 2>/dev/null; then
    cp "$SRC" "$DEST" && git add "$DEST" && echo "sync-cv: updated $DEST"
  fi
else
  echo "sync-cv: source $SRC not found, skipping" >&2
fi

exit 0
