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
