# MH1 test harness

Two ways to run the interface. Both drive the real fixture on 172.16.0.59
(base channel 109433, 16 channels).

## A. Local, via the proxy  — run from your own shell

    php -S 127.0.0.1:8123 -t harness harness/router.php

Then open http://127.0.0.1:8123/

The proxy exists because FPP's OPTIONS preflight returns 404, so a browser
cannot PUT to the device cross-origin. Serving the page and the API from one
origin avoids CORS entirely.

## B. On the device — same origin, works from a phone

    scp harness/mh-test.html fpp@172.16.0.59:/tmp/
    ssh fpp@172.16.0.59 'sudo cp /tmp/mh-test.html /opt/fpp/www/'

Then open http://172.16.0.59/mh-test.html — from any browser on the network,
including a phone while standing in the yard.

## Safety

- Dimmer starts at 0; nothing lights until you raise it.
- "Honour PositionZone rules" is on by default: pan 0–84 forces the dimmer to
  0, pan 155–255 forces pan to 0. Uncheck only deliberately.
- "Release" (and closing the tab) deletes the overlay range. Without that the
  fixture holds its last values indefinitely.

## C. Plugin page preview (no device needed)

    php harness/seed.php /Users/neilheuer/Desktop/MH1.xmodel
    php -S 127.0.0.1:8145 -t harness harness/plugin-preview.php

Open http://127.0.0.1:8145/ - the real status.php, with FPP stubbed and the
overlay API mocked. Every request is recorded; read them at /requests and clear
with /reset. This is how the write grouping, the diffing, the zone guard and the
release path were verified without touching hardware.
