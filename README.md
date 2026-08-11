# fpp-movingheads

Import xLights DMX moving-head models into FPP and drive one fixture live from a
browser, to check it is addressed correctly and that every channel does what the
model says it does.

A bench and setup tool, not a sequencing tool.

## What it gives you

- **A radar pad** you drag to aim. Pan and tilt are written 16-bit across the
  model's coarse and fine channels, applying its range of motion and reverse
  flag. Horizontal/vertical by default; a checkbox switches to bearing/radius.
- **Controls the model actually declares** — dimmer, shutter, and the colour
  wheel rendered as its own swatches with the DMX value behind each.
- **Labelled raw sliders** for everything else, named from `NodeNames`.
- **Position-zone safety**, honoured by default with a visible override.
- **A request log**, so you can see the exact URLs being sent.

## Installing

FPP's Plugin Manager, or by hand into `<mediadir>/plugins/`. Requires **FPP 10**;
the overlay range endpoint has not been verified on 9.x.

Then: **Status/Control → Moving Head Test**.

## Importing fixtures

Either an exported `.xmodel`, or a whole `xlights_rgbeffects.xml` to pick up every
DMX fixture in a show at once. Re-importing replaces same-named fixtures and keeps
any manual address override.

## Addresses

xLights writes `StartChannel` two ways, and both turn up in real show files:

| Form | Example | Needs |
|---|---|---|
| absolute | `295200` | nothing |
| controller-relative | `!Kulp32-A:1` | one base per controller |

A relative address cannot be resolved from the model file alone: the absolute
origin lives in the channel-output configuration of the FPP instance that emits
the channels, not in anything xLights exports. Set the base once per controller
and every fixture on it resolves. Any fixture can also be given a manual absolute
override.

To find the base on the emitting device, look at its DMX output's start channel
under **Input/Output Setup → Other**, or:

```bash
curl -s http://<device>/api/channel/output/co-other
```

## How it drives channels

One request per distinct value, through FPP's overlay range API:

```
PUT /api/overlays/range/{ch}-{ch},{ch}-{ch},.../{value}
```

No sequence, no output config change, no `fppd` restart, and no compiled code.

Channels that share a value ride in one request, so taking control of a
16-channel fixture is about four requests rather than sixteen. Nothing is sent
for a channel whose value has not changed. While the pointer is down only the
coarse pan/tilt channels are sent — 8-bit is roughly two degrees on a 540°
head — and the fine channels settle on release.

## Releasing matters

Overlay ranges are held by `fppd` until deleted. A fixture left in control keeps
its last values indefinitely. Release runs on the button, and best-effort on tab
close.

Release deletes **exactly** the ranges that were created, one per channel.
This is not cosmetic: `fppd` matches a range on its precise start and end, and a
delete that matches nothing does not no-op — it pushes a range with value `-1`,
which lands in a `uint8_t` channel buffer as **255**. Deleting one wide range
instead of the individual ones would therefore command full pan, full tilt and a
wide-open dimmer rather than releasing anything.

## Layout

```
status.php              the tool (Status/Control)
about.php               help (single 'help' menu entry)
menu.inc                menu entries
lib/XmodelParser.php    model XML -> fixture descriptor. Pure, no I/O
lib/FixtureStore.php    persistence + address resolution
assets/movingheadtest.js   client runtime
assets/movingheadtest.css  layout only; colour is inherited from FPP's theme
harness/                off-device preview, see harness/README.md
scripts/                install / uninstall
```

Assets are inlined by `status.php` at render time, and live in `assets/` rather
than `js/` and `css/` on purpose. `plugin.php` auto-includes anything in those
two directories, but serves it with `Cache-Control: max-age=31536000, immutable`
and **no version parameter** — while FPP busts cache on its own assets with
`?ref=<filemtime>`. A browser that has loaded the page once would therefore
never see a plugin update, and `immutable` means it would not even revalidate.
Inlining from a directory `plugin.php` does not scan sidesteps that, and avoids
loading the runtime twice.

## Developing off-device

```bash
php harness/seed.php /path/to/MH1.xmodel
php -S 127.0.0.1:8145 -t harness harness/plugin-preview.php
```

Then open <http://127.0.0.1:8145/>. The harness stands in for FPP, mocks the
overlay API, and records every request at `/requests` — enough to verify the
whole client path without hardware.

## Limitations

- One fixture at a time, by design.
- Colour wheels are supported. RGB and CMY colour models are parsed but have no
  dedicated control yet; their channels appear as raw sliders.
- Positions are not saved or recalled.
- A channel attribute of `0` means unset in xLights, so such a channel becomes a
  raw slider even when its label says otherwise — `MH2-1` in one real show
  declares `DmxDimmerChannel="0"` while its label reads "Dimmer".
