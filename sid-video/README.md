# sid-video

A phone-shaped video of any C64 tune on Games Explained, shown in the music player's full-screen
bouncing-ball view, with its sound. It's made for posting to Twitter/X and similar sites.

Nothing is recorded off a screen, so the picture and the sound can't drift apart. Each video frame
is the page's own ball view (`site/lib/bounce.js`), drawn at the exact music frame for its moment.
The page encodes the frames itself (H.264 through WebCodecs), and ffmpeg makes the final file.
The sound is the site's own SID model (`site/lib/sid.js`) running the page's own music driver,
rendered offline.

## What it needs

- Node 18 or newer
- Playwright and its Chromium: `npm i playwright && npx playwright install chromium`
  (Claude's cloud machines have both already)
- ffmpeg with libx264 (`brew install ffmpeg` on a Mac)

## Use

Point it at a game page, either on the live site or in a local build of the site:

```sh
# see which players and tunes a page has
node sid-video/sid-video.js https://gamesexplained.com/c64/wizball/ --list

# Wizball's title tune, from the live site
node sid-video/sid-video.js https://gamesexplained.com/c64/wizball/ --tune 3

# from a local build (python3 kit/scripts/build.py in the gamesexplained repo)
node sid-video/sid-video.js c64/master-of-magic/ --site ../gamesexplained/_site --tune 0
```

The default output is 1080x1920 at 60 fps: H.264 (High profile) video with 256 kb/s AAC stereo
sound at 48 kHz. Each video starts with one second of the sheet before the first note, and the
picture fades to black over the last second.

How long the video runs depends on the tune:

- **A tune that ends by itself** plays to its end, plus one second.
- **A tune that loops** stops at 2:19.6 with a 6-second fade-out, inside the 2:20 that a free
  Twitter/X account accepts. Use `--end` and `--fade` to choose another length, such as
  `--end 322 --fade 0` for the whole of Master of Magic's main theme, which fades itself out.

## Options

| Option | Default | What it does |
|---|---|---|
| `--list` | | print the page's players and tunes, then stop |
| `--player N` | 0 | which player on the page, numbered as `--list` shows them |
| `--tune N` | 0 | which tune of that player |
| `--end S` | see above | where the video stops, in seconds of the tune |
| `--fade S` | 0, or 6 for a loop | fade the sound out over the last S seconds |
| `--lead S` | 1 | seconds of the sheet before the tune starts |
| `--size WxH` | 1080x1920 | picture size; `1920x1080` gives the landscape view |
| `--fps N` | 60 | frames a second |
| `--workers N` | 3 | renderers in parallel |
| `--crf N` | 16 | x264 quality: lower is better and bigger |
| `--preset P` | medium | x264 preset; `fast` takes about half the time |
| `--raw` | | send each frame's pixels to ffmpeg as they are, instead of having the page encode them: exact, but about six times slower |
| `--out FILE` | `<game>-<tune>.mp4` | where to write the MP4 |
| `--keep` | | keep the work folder (segments and the WAV) beside the MP4 |

## How long it takes

On a 4-core cloud machine, 3 renderers draw about 37 frames a second at 1080x1920, so a
five-minute video takes about 8 minutes to draw. The final x264 pass takes about as long again
(`--preset fast` halves it), and the sound takes a few seconds. With `--raw` the drawing is about
five times slower.

## Things to know

- The page works out a tune's notes for its first 5 minutes only (`LONG` in `sid.js`). The script
  serves `sid.js` with that limit raised, so a long tune keeps its notes to the end. If `sid.js`
  stops having that line, the script says so, and the ball's notes stop at the page's own limit.
- Requests to other sites (analytics, fonts) are blocked while the page renders. The ball view
  draws no text, so the fonts don't matter.
- Every renderer checks that the page gave it the same notes as the first run, and stops if not.
- At the end it checks the file: that its sound matches the sound rendered (0 ms), and how far
  after each note the ball lands on the sound rises most, per voice. Notes that start with an
  attack give 0 or 1 ms. A voice that changes pitch under a held note has no attack to find, and
  then the voices disagree and the script says so instead of warning.
- The page's encoder (OpenH264 in Chromium) is close to the canvas but not exact: 42-43 dB PSNR,
  and colours within a level or two. `--raw` is exact up to the final x264 pass.
- Players are numbered in the order they appear on the page. Some pages mount their players
  late, after loading their data; the script waits for them.
