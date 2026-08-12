<?php
/**
 * Help / about page. One 'help' menu entry per guideline #9.1, so usage,
 * safety notes, limitations and credits all live here rather than on
 * separate pages.
 */
?>
<div class="container-fluid">
  <h2>Moving Head Test &mdash; help</h2>

  <h3>What it does</h3>
  <p>
    Imports xLights DMX model definitions, works out each fixture's absolute DMX address,
    and lets you drive one fixture at a time from the browser. It is a bench and setup tool:
    confirm a fixture is addressed correctly and that each channel does what the model says.
    It is not a sequencing or cue tool.
  </p>

  <h3>Importing</h3>
  <p>
    Either an exported <code>.xmodel</code> (one fixture) or a whole
    <code>xlights_rgbeffects.xml</code> (every DMX fixture in the show at once). Re-importing
    replaces same-named fixtures and keeps any manual address override you set. Fixtures are
    only ever matched by exact name &mdash; two shows can contain different fixtures with
    confusingly similar names, so nothing is merged by similarity.
  </p>

  <h3>Addresses</h3>
  <p>
    xLights writes <code>StartChannel</code> two ways. A bare number is already absolute and
    needs nothing from you. A <code>!Controller Name:12</code> form is relative to that
    controller, and the absolute origin is not in the model file &mdash; it lives in the
    channel-output configuration of the FPP instance that actually emits the channels. Set the
    base once per controller and every fixture on it resolves. Any fixture can also be given a
    manual absolute override.
  </p>

  <h3>How channels are driven</h3>
  <p>
    Through FPP's overlay range API, one request per changed channel:
  </p>
  <pre>PUT /api/overlays/range/{channel}-{channel}/{value}</pre>
  <p>
    No sequence, no output configuration change, and no <code>fppd</code> restart. Overlay
    ranges are held by <code>fppd</code> until deleted, which is why releasing matters &mdash;
    see below. Only the selected fixture's channel block is ever written.
  </p>

  <h3>Controls</h3>
  <ul>
    <li><strong>Nothing works until Take control.</strong> Every control is disabled behind a
        grey mask until then, so no value reaches a fixture by accident and anything a fixture
        holds was put there deliberately.</li>
    <li><strong>Radar pad</strong> &mdash; drag to aim. Horizontal is pan, vertical is tilt.
        Both are written 16-bit across the model's coarse and fine channels, applying its range
        of motion, home offset and reverse flag. The Pan and Tilt boxes accept typed angles for
        exact positioning.</li>
    <li><strong>Quick Commands</strong> &mdash; <em>Lamp On/Off</em> strikes or douses the arc
        lamp using values you configure under Lamp Control; <em>Beam On/Off</em> opens or closes
        the shutter and drives the dimmer, passing or blocking light the lamp already makes.
        If the lamp is not lit, Beam On produces nothing.</li>
    <li><strong>Declared by the model</strong> &mdash; dimmer, shutter and color wheel appear
        only when the model actually declares them. A channel attribute of <code>0</code> means
        unset in xLights, so such a channel becomes a raw slider instead, even if its label
        says otherwise.</li>
    <li><strong>Raw channels</strong> &mdash; anything the model does not describe, labelled
        from <code>NodeNames</code>, or <code>Channel N</code> where that entry is blank.</li>
  </ul>

  <h3>Safety</h3>
  <ul>
    <li>All channels start at 0, so nothing lights until you raise the dimmer.</li>
    <li><strong>Position zones are honored by default.</strong> Where a model defines
        <code>PositionZone</code> rules, a channel is forced to its zone value while pan and
        tilt sit inside that box &mdash; typically a blackout arc pointed somewhere you do not
        want lit. The checkbox disables that, which is worth doing only deliberately.</li>
    <li><strong>Closing or refreshing the page blacks out but does not release.</strong>
        Releasing is not neutral: once the ranges are gone the channels fall back to
        <code>fppd</code>'s underlying data, and DMX 0 on pan is one end of travel, not center.
        So closing kills the light and leaves the aim alone &mdash; a refresh does not move the
        head, and a forgotten tab leaves a dark fixture rather than a lit one. <strong>Release</strong>
        fully releases when you actually mean it.</li>
    <li>The page remembers the last values it wrote, per fixture, so a reload reports where a
        fixture really is instead of claiming center. <code>fppd</code> offers no way to read
        channel data back, so this is the closest available answer &mdash; and it means taking
        control after a refresh re-asserts the same numbers rather than moving anything.</li>
    <li>While dragging, only the coarse pan and tilt channels are sent; the fine channels
        settle when you let go. On a 540&deg; head that is roughly two degrees of precision
        mid-drag, which halves the request rate during the one high-rate action.</li>
  </ul>

  <h3>Known limitations</h3>
  <ul>
    <li>One fixture at a time, by design.</li>
    <li>Color is supported for wheel-type fixtures. RGB and CMY color models are parsed but
        have no dedicated control yet &mdash; their channels appear as raw sliders.</li>
    <li>Positions are remembered per fixture in this browser only, not saved as recallable
        presets.</li>
    <li>Requires FPP 10. The overlay range endpoint has not been verified on 9.x.</li>
  </ul>

  <h3>Source</h3>
  <p>
    <a href="https://github.com/heffneil/fpp-movingheads">github.com/heffneil/fpp-movingheads</a>
  </p>
</div>
