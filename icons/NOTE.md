# PWA Icons — replace before deploying

The `manifest.webmanifest` references three PNG files that need to exist
in this folder:

- `icon-192.png` — 192×192, used for Android homescreen and as the iOS
  apple-touch-icon when no specific size matches.
- `icon-512.png` — 512×512, used for splash screens and high-DPI homescreens.
- `icon-512-maskable.png` — 512×512 with the safe zone in the centre 80%
  (used by Android's "adaptive icon" rendering; iOS ignores it).

## Quickest path: generate from one source

1. Open the included `source.svg` (a 512×512 dark "K" badge as a starting point)
   in any image editor that exports PNG. Inkscape, Affinity Designer, Figma,
   Photoshop all work. Or a free CLI like ImageMagick:

   ```bash
   magick convert source.svg -resize 192x192 icon-192.png
   magick convert source.svg -resize 512x512 icon-512.png
   magick convert source.svg -resize 512x512 icon-512-maskable.png
   ```

2. For the maskable variant, ensure the meaningful content stays inside the
   centre 80% of the canvas (a 410×410 inscribed square inside the 512×512).

3. Drop the three PNGs into this folder and commit.

## What happens if you skip this

The PWA will still work, but iOS Add-to-Home-Screen will fall back to a
generic icon (usually a screenshot of the page rendered as a tile). The
splash screen will also be undefined.
