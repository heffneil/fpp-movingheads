# Off-device preview harness

Runs the real `status.php` without an FPP device. FPP is stubbed, the overlay API
is mocked, and every request the client makes is recorded — enough to verify the
whole client path (control surface, write grouping, diffing, zone guard, release
URLs) before touching hardware.

## Use

    php harness/seed.php path/to/YourFixture.xmodel [controllerName] [baseChannel]
    php -S 127.0.0.1:8145 -t harness harness/plugin-preview.php

Then open <http://127.0.0.1:8145/>.

- `/requests` — every request the page has made, newest last
- `/reset` — clear that log

Seeded fixtures and settings live in `harness/.preview-media/`, which is
gitignored. Delete it to start clean.

## Why the requests matter

Values reach a fixture as `PUT /api/overlays/range/{ch}-{ch}/{value}`, and
releasing must delete *exactly* the ranges that were created. Watching
`/requests` is the cheapest way to confirm both, since a wrong release does not
fail quietly — it drives channels to 255. See the note in the top-level README.

## Bootstrap for theme and responsive testing

The plugin's stylesheet takes its colors from Bootstrap's theme variables
(`--bs-danger-text-emphasis` and friends) and relies on `.table-responsive`, both
of which FPP provides on the real page. The harness has to supply them too, or it
silently tests only the fallback colors and every responsive check passes by
default because `.table-responsive` has no styles at all.

It is **not** fetched from a CDN by the harness: the plugin must never depend on
one, since a show network is often offline, and the plugin check flags any CDN
reference in shipped code. Cache a copy once instead — it lands in
`.preview-media/`, which is gitignored, so it is never committed or installed:

    mkdir -p harness/.preview-media
    curl -sL -o harness/.preview-media/bootstrap.min.css \
      https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css

Then:

    MHT_THEME=light php -S 127.0.0.1:8145 -t harness harness/plugin-preview.php
    MHT_THEME=dark  php -S 127.0.0.1:8145 -t harness harness/plugin-preview.php

`MHT_NO_BOOTSTRAP=1` renders without it on purpose, to check the fallback colors
hold up on their own. Without a cached copy the page says so rather than looking
fine while testing nothing.

## Exercising the not-driveable path

`LocalOutputs` asks FPP for the channels this instance actually emits, which on a
real player is `http://localhost/api/system/info`. Port 80 on a dev machine is not
FPP, so that call used to fail silently here and every fixture read as driveable —
hiding the whole "Not Driveable From This Device" branch. It looked like a
consequence of `php -S` being single-threaded; it was the port.

Two things are needed, and both are just environment:

    PHP_CLI_SERVER_WORKERS=4 \
    MHT_API_BASE="http://127.0.0.1:8145" \
    MHT_FAKE_RANGES="172287-172302" \
    php -S 127.0.0.1:8145 -t harness harness/plugin-preview.php

`MHT_API_BASE` points `LocalOutputs` at the harness instead of port 80.
`PHP_CLI_SERVER_WORKERS` forks the built-in server so the page can fetch from the
server rendering it. `MHT_FAKE_RANGES` is what the stand-in `/api/system/info`
reports, **0-indexed** like the real one — `172287-172302` means channels
172288–172303.

Set a base that falls outside those ranges and the page shows the not-driveable
panel with the derived-base fix; set one inside and the fixture becomes
selectable.

## Suggesting a base from local outputs

Drop a `co-other.json` into `.preview-media/config/` to give the page a DMX output
to derive a base from:

    { "channelOutputs": [
        { "channelCount": 16, "device": "DMX1", "enabled": 1,
          "startChannel": 172288, "type": "DMX-Open" } ] }

One enabled DMX output is prefilled and derived on load; two or more are listed
without a guess.
