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
