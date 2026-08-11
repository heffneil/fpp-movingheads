# fpp-movingheads — Design

**Status:** implemented and running on hardware. Kept as the record of why the
plugin is shaped the way it is; see the README for how to use it.
**Date:** 2026-08-11
**Target:** FPP v10 (script plugin; also expected to work on v9.5 — see Open Questions)

## Purpose

Import xLights moving-head model definitions, register each fixture against its DMX
address, then drive one fixture's channels live from a browser to verify it responds
correctly — pan, tilt, dimmer, shutter, colour, and every remaining channel.

This is a bench/setup tool: confirm a fixture is addressed correctly and each channel
does what the model claims. It is not a show-authoring or cue tool.

## Verified context

Everything in this section was read out of source or real data files, not inferred.

### Output mechanism — VERIFIED

`PUT /api/overlays/range/{ranges}/{value}` (`src/overlays/PixelOverlay.cpp:1068`)
sets **absolute channel ranges** to a value and holds them as a persistent overlay:

```
PUT /api/overlays/range/1-1/137        channel 1 = 137, held
PUT /api/overlays/range/7-9/255        channels 7,8,9 = 255
PUT /api/overlays/range/1-16/delete    release
```

Ranges are comma-separated, `start` or `start-end`, 1-indexed on input. One value per
request; multiple ranges per request. `{"deleteAll":true}` clears everything.

Consequences:

- No overlay model definition, no `model-overlays.json` write, no `fppd` restart.
- No C++ plugin and no ABI coupling. Pure PHP + JS.
- Ranges **persist in `fppd` until deleted** — see Lifecycle.

Rejected alternatives: `ChannelTester` (`/fppd/testing`) only offers fixed pattern
generators (`SingleChase`, `RGBChase`, `RGBFill`, `RGBCycle`, `Outputs`) with no
arbitrary per-channel values. `PUT /overlays/model/{m}/pixel` works but is RGB-triple
shaped, requiring channel→pixel arithmetic and a predefined model. `POST /models/raw`
is a config upload that sets a restart flag, not a data path.

### The live rig — VERIFIED

Show folder: `<show folder>`
(`xlights_rgbeffects.xml`, 4.5 MB, 467 models, saved 2026-08-11 07:21). **Two** DMX
models, both `DmxMovingHeadAdv`, both 16 channels:

| Model | `StartChannel` | Form | Zones | Port / addr |
|---|---|---|---|---|
| MH1 | `!Kulp32-A:1` | controller-relative | 2 | 1 / 1 |
| MH2 | `295200` | **absolute** | 1 | — / — |

- **`StartChannel` has two forms and the parser MUST handle both.** `!Name:N` is
  controller-relative and needs a base; a bare integer is already absolute and needs none.
  MH2 also has no `ControllerConnection` element at all.
- MH1 matches the exported `MH1.xmodel` exactly, so that export is valid live test data.
- Target controller: `Kulp32-A`, a KulpLights **K32-Max** at **<controller-ip>**
  over DDP, `MaxChannels=12466`. It is an outdoor controller.

### Why the controller base is user-entered — VERIFIED

`xlights_networks.xml` carries **no absolute start channel** for a controller. The
`<Controller>` element and its `<network>` child give IP, protocol and `MaxChannels`, but
with `AutoLayout=1` / `AutoSize=1` xLights *computes* each controller's channel block from
controller ordering and sizes. Auto-resolving a base would mean reimplementing that
allocation — rejected as fragile.

A better future path exists and is untried: FPP's own `config/channeloutputs.json` on the
show player holds the DDP output for `<controller-ip>` with its `startChannel`, which is
authoritative for the machine actually emitting the channels.

### Additional test data — an archived show (20 moving heads)

an older archived show file — 3.1 MB, 155 models,
**last modified 2026-03-27**, sitting beside archived model-mapping spreadsheets. **Not
the live rig** — it predates it and contains a different, more varied set: 8 fixtures of
9 channels and 12 of 16, none with zones, none with `DmxChannelCount`. Retained purely
because that variety exercises parser paths the 2-fixture live show does not.

Two fixture types, both `DmxMovingHeadAdv`, controller `Moving Heads`, `DMX-Open`:

| Fixtures | Channels | Addresses (`!Moving Heads:N`) |
|---|---|---|
| MH-1 … MH-8 | 9 | 1, 33, 49, 65, 81, 97, 113, 129 |
| MH2-1, MH2-2, MH6-1…6, MH4-1…4 | 16 | 145 … 321, spaced 16 |

- **`DmxChannelCount` is absent on all 20** show-file models. Channel count MUST be
  derived from the `NodeNames` comma-count. (It *was* present on an exported `.xmodel`,
  so the parser must handle both.)
- **`NodeNames` entries can be empty.** MH-1 has blanks at channels 5 and 6; MH2-1 at 10
  and 12. Empty labels need a positional fallback (e.g. "Channel 5"), not a dropped row.
- **A role attribute of `0` means unset, and may contradict the label.** MH2-1 declares
  `DmxDimmerChannel="0"` while its `NodeNames[8]` reads "Dimmer". `0` MUST NOT be treated
  as channel 0; the channel falls back to a `raw` slider carrying its label.
- **`DmxShutterOnValue` can be absent** (MH2-1). Treat as unset rather than defaulting
  silently to 255.
- All 20 share pan coarse/fine = 1/3 and tilt coarse/fine = 2/4.
- **No model has a `PositionZone`.** Zone support must tolerate total absence.
- `ControllerConnection channel` is **omitted when it is 1** (MH6-1) — default to 1.
- Port 2's fixtures show `StartChannel = dmxAddress + 176` consistently, i.e. the port
  offset is already folded into `N`. Ports need no special handling.

### Anomalies — flagged, NOT to be auto-corrected

- **Unallocated block at 17–32.** Spacing is 16 everywhere except MH-1→MH-2, which
  jumps 32, while MH-1 is a 9-channel fixture.
- **`MH1.xmodel` ≠ `MH-1`.** The export is 16 channels with 2 `PositionZone` rules;
  `MH-1` in the show file is 9 channels with none. They are different fixtures from
  different shows. The tool must never merge fixtures across import sources by
  name-similarity.

## Addressing model

Resolution depends on which `StartChannel` form a model uses:

- **Bare integer** (MH2 = `295200`) → already absolute. Used as-is, no base required.
- **`!Controller:N`** (MH1 = `!Kulp32-A:1`) → one **base channel per
  controller name**, not per fixture:

```
absolute = controllerBase + N − 1
```

So MH2 needs no configuration at all, while MH1 needs the `Kulp32-A` base set
once. Bases default to 1 and are editable per controller name; each fixture additionally
gets an optional manual absolute override.

A relative `StartChannel` cannot be resolved from the model file alone — the absolute
origin lives in the channel-output configuration of the FPP instance actually emitting the
channels, not in anything xLights exports. See "Why the controller base is user-entered".

## Architecture

Pure logic is separated from anything that touches FPP, so the parts most likely to
carry bugs are testable without hardware or a running `fppd`.

| Module | Language | Responsibility | Depends on |
|---|---|---|---|
| `XmodelParser` | PHP | model XML → fixture descriptor. Pure; no I/O. | — |
| `FixtureRegistry` | PHP | persist descriptors + controller bases + overrides | plugin settings file |
| `ControlSurface` | JS | descriptor → DOM controls | descriptor |
| `ChannelState` | JS | authoritative channel values; degrees ↔ 16-bit | descriptor |
| `ZoneGuard` | JS | (pan, tilt, zones) → forced overrides. Pure. | descriptor |
| `OverlayWriter` | JS | diff state, emit minimal PUTs, own take/release | FPP overlay API |

### Fixture descriptor

`XmodelParser` accepts either a single exported `.xmodel` or an
`xlights_rgbeffects.xml` (bulk) and emits, per fixture:

```json
{
  "name": "MH-1", "type": "DmxMovingHeadAdv",
  "controller": "Moving Heads", "relativeStart": 1,
  "channelCount": 9,
  "channels": [{"offset":1,"label":"Pan / X-axis / Horizontal","role":"panCoarse"}, "…"],
  "pan":  {"coarse":1,"fine":3,"rangeOfMotion":540,"reverse":true,"orientHome":270},
  "tilt": {"coarse":2,"fine":4,"rangeOfMotion":270,"reverse":false,"orientHome":135},
  "dimmer": 8,
  "shutter": {"channel":7,"onValue":255},
  "colorWheel": {"channel":9,"positions":[{"dmx":2,"hex":"#ffffff"}, "…"]},
  "positionZones": []
}
```

`channelCount` = `DmxChannelCount` when present, else the `NodeNames` count.

Role assignment precedence, in order:

1. An explicit attribute with a **non-zero** value claims that channel
   (`DmxDimmerChannel`, `DmxShutterChannel`, `DmxColorWheelChannel`, and the
   `PanMotor`/`TiltMotor` coarse/fine channels).
2. A value of `0`, or an absent attribute, claims nothing.
3. Every unclaimed channel becomes `role: "raw"`, labelled from `NodeNames`, or
   `"Channel N"` when that entry is empty.

This is why MH2-1's channel 8 ends up a labelled raw slider reading "Dimmer" rather than
a percentage control: the model itself declares no dimmer channel.

### Control surface generation

Role-driven, so unknown channels degrade gracefully instead of being dropped:

- `panCoarse`/`panFine`, `tiltCoarse`/`tiltFine` → a **polar radar aim pad** (bearing =
  pan, radius from centre = tilt), dragged to aim, written as 16-bit across both channel
  pairs applying `rangeOfMotion`, `reverse`, `orientHome`. Degree sliders remain available
  for precise numeric entry, but the pad is the primary control — dragging a head to aim
  it is how the fixture actually gets tested. A Home button returns to `orientHome`.
- `dimmer` → 0–100% slider
- `shutter` → open/closed using `DmxShutterOnValue`, plus a raw value entry for strobe
- `colorWheel` → clickable swatches from the wheel table (`DmxColorType=1`); RGB and CMY
  are out of scope until there is a fixture to test them against
- `raw` → labelled 0–255 slider using the `NodeNames` label

## Write throughput during a drag

The overlay endpoint accepts **one value per request** (many ranges, single value). A radar
position sets four channels to four different values, so a naive drag costs 4 requests per
position update — roughly 80/sec at a normal drag rate, through Apache to `fppd`. That is
more than this design is willing to spend.

`OverlayWriter` therefore:

1. Coalesces to the **latest** position via `requestAnimationFrame`, throttled to ~20 Hz —
   intermediate positions during a fast drag are dropped, never queued.
2. Sends **coarse channels only while the pointer is down** (2 requests per tick), then
   sends the fine channels once on release. 8-bit pan across a 540° range is 2.1° per
   step, so mid-drag accuracy is a couple of degrees and full 16-bit precision lands the
   moment the drag ends.
3. Sends nothing when a channel's value is unchanged.

This is the one place the pure-PHP/JS choice has a cost. It is contained: `OverlayWriter`
is the only module that would change if the mmap or C++ path were needed instead, and its
interface does not leak the transport.

## Lifecycle and safety

**Overlay ranges persist server-side.** Closing the page without releasing leaves the
fixture frozen at its last values indefinitely. This is the primary correctness risk in
the design, so control is explicit:

- **Take Control** — begin writing; only the selected fixture's block is ever written
- **Release** — `PUT /api/overlays/range/{abs}-{abs+count-1}/delete`
- `beforeunload` → release, mirroring the `StopPixelCount` guard in `www/currentmonitor.php`

**Test scope:** one fixture at a time, chosen from a list. No other fixture's channels
are written, ever.

**Position zones:** honoured by default, with a clearly-labelled override toggle for
deliberately exercising a fixture's full mechanical range. `ZoneGuard` is pure and the
toggle merely bypasses it, so both paths share one implementation. Absent zones are
normal, not an error.

## Verification plan

1. `XmodelParser` unit tests against real data: `MH1.xmodel` (16 ch, colour wheel,
   16-bit motors, 2 zones, `DmxChannelCount` present) and the 20 show-file models
   (9 and 16 ch, no zones, `DmxChannelCount` absent, one omitted `channel` attribute).
   Named cases that must be covered, from the live show: MH1 relative
   `!Kulp32-A:1` with 2 zones; MH2 **absolute** `295200` with no
   `ControllerConnection` element at all. From the archive: MH-1 empty labels at 5–6;
   MH2-1 `DmxDimmerChannel="0"` contradicting its "Dimmer" label; MH2-1 missing
   `DmxShutterOnValue`; MH6-1 omitted `ControllerConnection channel`; `DmxChannelCount`
   absent throughout, forcing the `NodeNames` fallback.
2. `ChannelState` unit tests for degrees→16-bit, specifically `reverse=true` with a
   540° range — the most likely place for a sign or scaling error.
3. Off-device: serve the plugin page under the PHP preview harness with
   `/api/overlays/range/…` mocked, asserting the exact URLs emitted per interaction, and
   that release fires on unload. Same technique used to verify Enable All.
4. On hardware last, against a real fixture.

## Out of scope

Multiple simultaneous fixtures; saved/recalled positions; chases and movement patterns;
RGB and CMY colour models; editing or writing back to xLights files.

## Open questions

- **v9.5 support is UNVERIFIED.** `--ALL--` port handling was confirmed on v9.5, but the
  `overlays/range` endpoint has not been checked there.
- **Controller base auto-resolution** was deferred in favour of a user-entered base.
  Deriving it from `config/channeloutputs.json` may be feasible but is unproven.
- The 17–32 gap and the `MH1` / `MH-1` discrepancy are unexplained and are the user's to
  resolve; the tool must not paper over either.
