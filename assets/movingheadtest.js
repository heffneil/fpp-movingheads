/*
 * fpp-movingheads - client runtime
 *
 * Drives one fixture at a time by writing absolute DMX channels through
 * FPP's overlay range API:
 *
 *     PUT /api/overlays/range/{ch}-{ch}/{value}
 *     PUT /api/overlays/range/{first}-{last}/delete
 *
 * Overlay ranges persist inside fppd until deleted, so releasing matters:
 * a page closed without releasing leaves the fixture frozen at its last
 * values indefinitely. Release runs on the button, on unload, and on pagehide.
 *
 * Sections: Channels (state + geometry), Zones, Writer (transport),
 * Radar (aim pad), Surface (DOM). Channels and Zones are pure - no DOM,
 * no fetch - so they can be reasoned about on their own.
 */
'use strict';

var MHT = (function () {

    /* ---------------------------------------------------------------- state */

    var fx = null;        // active fixture descriptor
    var base = 0;         // resolved absolute start channel
    var vals = [];        // channel values, 1-indexed by offset
    var sent = [];        // last value actually written, for diffing
    var live = false;
    var dragging = false;
    var panDeg = 0, tiltDeg = 0;
    var honorZones = true;
    var rawInputs = {};       // channel offset -> its range input
    // Pad geometry, recomputed per fixture. CELL is degrees per grid block;
    // PX is its size in viewBox units, so cells stay square whatever the ranges.
    var CELL = 45, PX = 40;
    // A fixture whose reachable pan span is only 180 degrees gets 4 blocks, and 4
    // x 40 units is a cramped little pad. Blocks are grown towards MIN_W so a
    // small grid is still comfortable, capped by MAX_PX and by MAX_H.
    //
    // One scale for both axes, because a 45 degree block should look square. That
    // makes MIN_W and MAX_H genuinely conflicting on a lopsided fixture (narrow
    // pan, wide tilt), and the PX floor wins both: such a pad ends up narrow and
    // over MAX_H rather than sub-40 units per block. Squareness and legible cells
    // matter more than the envelope, and nothing depends on the pad's size -
    // pointer maths reads the rendered rect, and the pan/tilt spans are stated in
    // the caption underneath rather than lettered across the top.
    var MIN_W = 320, MAX_H = 420, MAX_PX = 64;
    var padW = 320, padH = 240, padCX = 160, padCY = 120;

    // Password managers latch onto bare number inputs and pop their autofill UI
    // over a field that is just a DMX value. Each vendor honors its own opt-out;
    // autocomplete="off" alone does not stop 1Password.
    var PM_OPTOUT = 'autocomplete="off" data-1p-ignore data-lpignore="true" ' +
                    'data-bwignore data-form-type="other"';

    function $(id) { return document.getElementById(id); }

    /* ------------------------------------------------------------- Channels */

    /**
     * Requested angle -> 16-bit motor position, mirroring xLights' DmxMotor:
     *
     *     cmd = max * orientHome / range  +  max * position / range * rev
     *
     * The home offset is a position within the motor's range and is NOT
     * necessarily mid-scale; the earlier version assumed it was, which happened
     * to be harmless on a fixture whose home is exactly half its range (pan
     * 270 of 540, tilt 135 of 270) and would have been wrong on any other.
     * Reverse negates the requested angle rather than mirroring the result -
     * the same thing at mid-scale home, different anywhere else.
     */
    function degTo16(deg, motor) {
        var rev = motor.reverse ? -1 : 1;
        var pos = motor.upsideDown ? -deg : deg;
        var perDeg = 65535 / motor.range;
        var v = Math.round(perDeg * ((motor.orientHome || 0) + pos * rev));
        // xLights folds a whole revolution back into range when it can, rather
        // than clamping, so a wrapped position still reaches its target.
        var fullSpin = Math.round(perDeg * 360);
        if (v < 0 && (v + fullSpin) <= 65535) { v += fullSpin; }
        if (v > 65535 && (v - fullSpin) >= 0) { v -= fullSpin; }
        return clamp(v, 0, 65535);
    }

    function applyMotor(motor, deg) {
        if (!motor) { return; }
        var v = degTo16(deg, motor);
        vals[motor.coarse] = (v >> 8) & 255;
        if (motor.fine > 0) { vals[motor.fine] = v & 255; }
        return v;
    }

    // Never overwrite a field the user is typing into. recompute() runs on every
    // pointer move, so without this a typed value would be clobbered mid-entry.
    function setFieldValue(el, v) {
        if (el && document.activeElement !== el) { el.value = v; }
    }

    function recompute() {
        applyMotor(fx.pan, panDeg);
        applyMotor(fx.tilt, tiltDeg);
        // Only the coarse channel is shown. The fine channel is still written -
        // 16-bit precision is unchanged - but two numbers per axis read as noise
        // when what you want at a glance is "what DMX value is on pan".
        if (fx.pan) {
            setFieldValue($('mhtPanDeg'), Math.round(panDeg));
            $('mhtPanRaw').textContent = 'DMX ch' + fx.pan.coarse + ' = ' + vals[fx.pan.coarse];
        }
        if (fx.tilt) {
            setFieldValue($('mhtTiltDeg'), Math.round(tiltDeg));
            $('mhtTiltRaw').textContent = 'DMX ch' + fx.tilt.coarse + ' = ' + vals[fx.tilt.coarse];
        }
    }

    /**
     * Inverse of degTo16: a coarse/fine channel pair back to degrees.
     * Mirrors the same orientHome offset and reverse handling, so a value that
     * was written and then read back yields the angle it came from.
     */
    function degFrom16(v, motor) {
        var raw = (v[motor.coarse] << 8) | (motor.fine > 0 ? v[motor.fine] : 0);
        var perDeg = 65535 / motor.range;
        var pos = (raw / perDeg) - (motor.orientHome || 0);
        if (motor.reverse) { pos = -pos; }
        if (motor.upsideDown) { pos = -pos; }
        return pos;
    }

    /**
     * The angles an axis can actually reach, which depend on where home sits.
     *
     * A DMX position must satisfy 0 <= orientHome + deg*rev <= range, so the
     * reachable span is anchored on home and is NOT symmetric about zero unless
     * home happens to be mid-range. Assuming a symmetric +/-180 offered angles
     * the fixture could not reach: the command went out of range and got folded
     * a whole revolution, so the mapping stopped being monotonic and dragging
     * one way could move the head the other. Intersected with the model's own
     * MinLimit/MaxLimit, which are a separate, tighter constraint.
     */
    function axisBounds(m, fallback) {
        if (!m) { return { lo: -fallback, hi: fallback }; }
        var rev = m.reverse ? -1 : 1;
        var a, b;
        if (rev === 1) {
            a = -(m.orientHome || 0);
            b = m.range - (m.orientHome || 0);
        } else {
            a = (m.orientHome || 0) - m.range;
            b = (m.orientHome || 0);
        }
        var lo = Math.max(a, m.min);
        var hi = Math.min(b, m.max);
        if (!(hi > lo)) { return { lo: -fallback, hi: fallback }; }
        return { lo: lo, hi: hi };
    }

    function panB()  { return axisBounds(fx.pan, 180); }
    function tiltB() { return axisBounds(fx.tilt, 135); }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    // Single entry point for aiming, so a drag and a typed angle behave
    // identically: clamp, move the dot, recompute channels, write.
    function setAim(p, t) {
        var pb = panB(), tb = tiltB();
        panDeg = clamp(p, pb.lo, pb.hi);
        tiltDeg = clamp(t, tb.lo, tb.hi);
        placeDot();
        recompute();
        flush();
    }

    /**
     * Build the aim grid for the current fixture.
     *
     * One block per CELL degrees in both axes, sized so blocks are square. The
     * extent comes from the fixture's own range of motion, so a 540/270 head
     * gets 8 x 6 blocks and something else gets whatever its ranges imply.
     *
     * Rectangular, not circular. The old round pad clamped the pointer to a
     * radius, which made the corners unreachable - pan 180 together with tilt
     * 135 could not be expressed at all.
     */
    function buildPad() {
        var svg = $('mhtRadar');
        if (!svg || !fx) { return; }
        var pb = panB(), tb = tiltB();
        var cols = Math.max(2, Math.round((pb.hi - pb.lo) / CELL));
        var rows = Math.max(2, Math.round((tb.hi - tb.lo) / CELL));
        var px = Math.min(MAX_PX, Math.max(PX, MIN_W / cols));
        px = Math.max(PX, Math.min(px, MAX_H / rows));
        padW = cols * px;
        padH = rows * px;
        // Zero is not necessarily the middle: it is wherever 0 degrees falls
        // within the reachable span, which is offset whenever home is not
        // mid-range. Drawing it at the centre regardless would misplace the one
        // reference you aim against.
        padCX = ((0 - pb.lo) / (pb.hi - pb.lo)) * padW;
        padCY = ((tb.hi - 0) / (tb.hi - tb.lo)) * padH;
        svg.setAttribute('viewBox', '0 0 ' + padW + ' ' + padH);
        // Explicit width/height give the element an intrinsic size. Relying on
        // CSS width:100% inside a content-sized flex item is circular and
        // resolves to zero, which collapsed the pad and made every pointer
        // measurement a divide-by-zero.
        svg.setAttribute('width', padW);
        svg.setAttribute('height', padH);

        var p = [];
        p.push('<rect class="mhtPadBg" x="0.5" y="0.5" width="' + (padW - 1) +
               '" height="' + (padH - 1) + '"/>');
        for (var c = 1; c < cols; c++) {
            p.push('<line class="mhtPadGrid" x1="' + (c * px) + '" y1="0" x2="' +
                   (c * px) + '" y2="' + padH + '"/>');
        }
        for (var r = 1; r < rows; r++) {
            p.push('<line class="mhtPadGrid" x1="0" y1="' + (r * px) + '" x2="' +
                   padW + '" y2="' + (r * px) + '"/>');
        }
        // tilt 0 and pan 0 references, drawn over the grid
        p.push('<line class="mhtPadAxis" x1="0" y1="' + padCY + '" x2="' + padW +
               '" y2="' + padCY + '"/>');
        p.push('<line class="mhtPadZero" x1="' + padCX + '" y1="0" x2="' + padCX +
               '" y2="' + padH + '"/>');

        p.push('<text class="mhtRadarDir"  x="' + padCX + '" y="14" text-anchor="middle">BACK</text>');
        p.push('<text class="mhtRadarTick" x="' + padCX + '" y="26" text-anchor="middle">tilt +</text>');
        p.push('<text class="mhtRadarTick" x="' + padCX + '" y="' + (padH - 16) + '" text-anchor="middle">tilt \u2212</text>');
        p.push('<text class="mhtRadarDir"  x="' + padCX + '" y="' + (padH - 5) + '" text-anchor="middle">FRONT</text>');
        p.push('<text class="mhtRadarTick" x="' + (padW - 4) + '" y="' + (padCY - 6) + '" text-anchor="end">pan +</text>');
        p.push('<text class="mhtRadarTick" x="4" y="' + (padCY - 6) + '">pan \u2212</text>');

        p.push('<rect class="mhtMark" id="mhtDot" x="0" y="0" width="13" height="13"/>');
        svg.innerHTML = p.join('');

        // Each fact is its own nowrap span so the caption wraps between them and
        // never mid-range - "tilt -135...            135" reads as two numbers.
        var cap = $('mhtPadCaption');
        if (cap) {
            cap.innerHTML = [
                CELL + '\u00b0 per block',
                'pan ' + Math.round(pb.lo) + '\u2026' + Math.round(pb.hi) + '\u00b0',
                'tilt ' + Math.round(tb.lo) + '\u2026' + Math.round(tb.hi) + '\u00b0'
            ].map(function (t) { return '<span>' + t + '</span>'; }).join(' \u00b7 ');
        }
        placeDot();
    }

    // Put the marker where the current angles say.
    function placeDot() {
        var m = $('mhtDot');
        if (!m) { return; }
        var pb = panB(), tb = tiltB();
        var x = ((panDeg - pb.lo) / (pb.hi - pb.lo)) * padW;
        var y = ((tb.hi - tiltDeg) / (tb.hi - tb.lo)) * padH;
        m.setAttribute('x', x - 6.5);
        m.setAttribute('y', y - 6.5);
    }

    /* ---------------------------------------------------------------- Zones */

    // PositionZone: while pan/tilt sit inside the box, a channel is forced to
    // a value. Pure - returns a copy, never mutates vals, so the honor/ignore
    // toggle is just whether the caller uses the result.
    function withZones(src) {
        if (!honorZones || !fx.zones || !fx.zones.length || !fx.pan || !fx.tilt) {
            return src;
        }
        var out = src.slice();
        var p = src[fx.pan.coarse], t = src[fx.tilt.coarse];
        var hit = [];
        for (var i = 0; i < fx.zones.length; i++) {
            var z = fx.zones[i];
            if (p >= z.panMin && p <= z.panMax && t >= z.tiltMin && t <= z.tiltMax) {
                out[z.channel] = z.value;
                hit.push('ch' + z.channel + '=' + z.value);
            }
        }
        var el = $('mhtZoneState');
        if (el) {
            el.textContent = hit.length ? ('Active: ' + hit.join(', ')) : 'Not in a zone';
            el.className = hit.length ? 'mhtZoneOn' : 'mhtZoneOff';
        }
        return out;
    }

    /* --------------------------------------------------------------- Writer */

    function log(msg) {
        var el = $('mhtLog');
        if (!el) { return; }
        el.textContent = (msg + '\n' + el.textContent).split('\n').slice(0, 16).join('\n');
    }

    function put(path) {
        return fetch(path, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        }).then(function (r) {
            log((r.ok ? '  ' : 'FAIL ') + r.status + '  ' + path);
            return r.ok;
        }).catch(function (e) {
            log('FAIL  ' + path + '  ' + e.message);
            return false;
        });
    }

    // Coalescing must not depend on requestAnimationFrame alone: rAF does not
    // fire in a hidden tab, and this page controls physical hardware. Without
    // the fallback, backgrounding the tab silently swallows every change -
    // including dragging the dimmer to zero, which is the one change that most
    // needs to get through. 40ms keeps the same ~25Hz intent when hidden.
    function schedule(cb) {
        if (document.visibilityState === 'visible' && window.requestAnimationFrame) {
            window.requestAnimationFrame(cb);
        } else {
            window.setTimeout(cb, 40);
        }
    }

    var queued = false;
    function flush() {
        if (queued || !live) { return; }
        queued = true;
        // Coalesce to one write pass per frame. A fast drag emits far more
        // input events than fppd needs, and stale positions are worthless -
        // only the latest matters.
        schedule(function () {
            queued = false;
            if (!live) { return; }
            var eff = withZones(vals);

            // Group the changed channels by value. The endpoint takes many
            // ranges but a single value, so every channel moving to the same
            // number rides in one request - which turns the 16 writes of a
            // fresh take-control into about four, and keeps concurrent
            // in-flight requests (and therefore any chance of them landing out
            // of order) to a minimum.
            var byValue = {};
            for (var o = 1; o <= fx.channelCount; o++) {
                // While the pointer is down, skip the fine channels: 8-bit is
                // ~2 degrees on a 540 degree head, and they settle on release.
                if (dragging && fx.pan && o === fx.pan.fine) { continue; }
                if (dragging && fx.tilt && o === fx.tilt.fine) { continue; }
                if (eff[o] === sent[o]) { continue; }
                sent[o] = eff[o];
                var ch = base + o - 1;
                if (!byValue[eff[o]]) { byValue[eff[o]] = []; }
                byValue[eff[o]].push(ch + '-' + ch);
            }
            Object.keys(byValue).forEach(function (v) {
                put('/api/overlays/range/' + byValue[v].join(',') + '/' + v);
            });
            saveVals();
        });
    }

    /**
     * Kill the light - dimmer and shutter to zero.
     *
     * Like every other control, this does nothing until the page is in control.
     * That is deliberate: the tool asserts a known state on take-control and
     * nothing before it, so there is never a question of which values a fixture
     * is holding or who put them there. The controls are visibly disabled until
     * then, so this cannot be pressed and silently ignored.
     *
     * Note this is a blackout, not a lamp off: it does not touch a lamp-control
     * channel (often labelled "Lamp" or "Lamp / Reset"), which on many fixtures
     * strikes or douses the arc lamp itself and is not something to toggle
     * casually. Use that channel's own slider if you really mean it.
     */

    // A lamp strike is a momentary command, not a level: the fixture latches on
    // the transition, and a lamp/reset channel's value ranges usually mean
    // something different when held. So the value is pulsed and then released
    // back to idle rather than left sitting on the channel.
    var LAMP_PULSE_MS = 5000;
    var LAMP_IDLE = 0;
    var lampTimer = null;

    /**
     * Pulse the lamp channel: hold the configured value for LAMP_PULSE_MS, then
     * return the channel to idle.
     *
     * Only available when the fixture has lamp config, because the channel and
     * its values are fixture-specific and are never guessed - the wrong value on
     * an arc lamp is not a harmless mistake.
     */
    function setLamp(on) {
        if (!fx || !live || !fx.lamp) { return; }
        if (on && coolMsLeft() > 0) {
            log('Lamp on refused: ' + fmtDuration(coolMsLeft()) + ' of cooldown left');
            return;
        }
        var ch = fx.lamp.channel;
        var v = on ? fx.lamp.onValue : fx.lamp.offValue;

        cancelLampPulse();
        writeLampChannel(ch, v);
        log('Lamp ' + (on ? 'on' : 'off') + ': ch' + ch + ' = ' + v +
            ' for ' + (LAMP_PULSE_MS / 1000) + 's');
        if (!on) { startCooldown(); }
        refreshLampButtons();

        lampTimer = window.setTimeout(function () {
            lampTimer = null;
            refreshLampButtons();
            // Do not clobber a value the user set by hand mid-pulse.
            if (!live || vals[ch] !== v) {
                log('Lamp pulse ended; channel changed meanwhile, left alone');
                return;
            }
            writeLampChannel(ch, LAMP_IDLE);
            log('Lamp pulse ended: ch' + ch + ' back to ' + LAMP_IDLE);
        }, LAMP_PULSE_MS);
    }

    // ---- restrike cooldown ---------------------------------------------------
    //
    // A discharge lamp has to cool before it will strike again. Forcing an early
    // restrike either fails or shortens lamp life, and neither is visible from
    // here - so the tool holds Lamp On rather than trusting whoever is at the
    // keyboard to remember. The deadline is recorded server-side on lamp off, so
    // it survives a page reload, a different tab, and a different browser: the
    // cooling lamp is a property of the fixture, not of this page. The countdown
    // is shown whether or not you are in control, because the lamp does not care.

    function coolMsLeft() {
        if (!fx || !fx.coolUntilMs) { return 0; }
        return Math.max(0, fx.coolUntilMs - Date.now());
    }

    function startCooldown() {
        var secs = fx.lamp ? (fx.lamp.cooldownSec || 0) : 0;
        if (secs <= 0) { return; }
        fx.coolUntilMs = Date.now() + secs * 1000;
        // Persist through the server so the deadline is not lost with this tab.
        var fd = new FormData();
        fd.append('mhtAction', 'lampoff');
        fd.append('fixture', fx.name);
        fetch(window.location.href, { method: 'POST', body: fd })
            .catch(function (err) {
                log('WARN cooldown not recorded server-side (' + err + '); ' +
                    'it will not survive a reload');
            });
        tickCooldown();
    }

    function fmtDuration(ms) {
        var t = Math.ceil(ms / 1000);
        var m = Math.floor(t / 60);
        var sec = t % 60;
        return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    function tickCooldown() {
        var el = $('mhtCooldown');
        var left = coolMsLeft();
        if (el) {
            el.hidden = left <= 0;
            if (left > 0) {
                el.textContent = 'Lamp cooling down - ' + fmtDuration(left) +
                    ' before it may be struck again. Lamp On is held until then.';
            }
        }
        refreshLampButtons();
    }

    // Seed each fixture's deadline from the server's remaining seconds rather
    // than an absolute time, so a clock offset between browser and player cannot
    // make a cooling lamp look ready.
    function initCooldowns() {
        (window.MHT_FIXTURES || []).forEach(function (f) {
            var left = f.cooldownRemaining || 0;
            if (left > 0) { f.coolUntilMs = Date.now() + left * 1000; }
        });
    }

    function writeLampChannel(ch, v) {
        vals[ch] = v;
        var inp = rawInputs[ch];
        if (inp) { inp.value = v; syncNumberFor(inp); }
        flush();
    }

    function cancelLampPulse() {
        if (lampTimer) {
            window.clearTimeout(lampTimer);
            lampTimer = null;
            refreshLampButtons();
        }
    }

    /**
     * Both lamp buttons derive their state from the same four facts rather than
     * being enabled and disabled from a dozen call sites: in control, lamp
     * configured, no pulse already running, and - for Lamp On only - no restrike
     * cooldown outstanding.
     */
    function refreshLampButtons() {
        var ready = live && !!(fx && fx.lamp) && lampTimer === null;
        var on = $('mhtLampOn');
        var off = $('mhtLampOff');
        if (on) { on.disabled = !ready || coolMsLeft() > 0; }
        if (off) { off.disabled = !ready; }
    }

    // Move a slider's paired number field without firing its input handler,
    // which would route back through flush() and be swallowed when not live.
    function syncNumberFor(slider) {
        var row = slider.closest('.mhtRow');
        var num = row ? row.querySelector('input[type=number]') : null;
        if (num) { num.value = slider.value; }
    }

    function takeControl() {
        if (!fx || !base) { return; }
        live = true;
        for (var i = 0; i <= fx.channelCount; i++) { sent[i] = -1; }
        $('mhtState').textContent = 'In control';
        $('mhtState').className = 'mhtPill mhtLive';
        setControlsEnabled(true);
        log('Took control of ' + fx.name + ' at ' + base + '-' + (base + fx.channelCount - 1));
        flush();
    }

    // Release MUST delete exactly the ranges that were created - one per
    // channel - because fppd matches a range on its precise start and end
    // (PixelOverlay.cpp render_PUT). A delete that matches nothing does not
    // silently no-op: it pushes OverlayRange(start, end, -1), and doOverlays()
    // assigns that int into a uint8_t buffer, so every channel in it is driven
    // to 255. Deleting one 16-wide range here would therefore not release the
    // fixture, it would command full pan, full tilt and a wide open dimmer.
    //
    // The endpoint accepts comma-separated ranges, so all of them still go in
    // a single request - which also makes the unload path as reliable as it can
    // be.
    function releasePath() {
        var parts = [];
        for (var o = 0; o < fx.channelCount; o++) {
            var ch = base + o;
            parts.push(ch + '-' + ch);
        }
        return '/api/overlays/range/' + parts.join(',') + '/delete';
    }

    function release() {
        if (!live) { return; }
        cancelLampPulse();
        live = false;
        $('mhtState').textContent = 'Released';
        $('mhtState').className = 'mhtPill mhtOff';
        setControlsEnabled(false);
        put(releasePath());
    }

    /**
     * On unload: go dark, but do NOT release.
     *
     * Releasing is not a neutral act. Once the ranges are gone the channels fall
     * back to fppd's underlying data, which with no sequence playing is 0 - and
     * DMX 0 on pan is not center, it is one end of travel. So releasing on unload
     * made every page refresh swing the head to a limit, and the reloaded page
     * then claimed center, disagreeing with the fixture until you took control
     * and it snapped there. Two unwanted movements per refresh.
     *
     * Unload cannot tell a refresh from closing the tab, so it does the thing
     * that is right for both: kill the light, leave the aim alone. A refresh
     * becomes invisible to the fixture, and a forgotten tab leaves it dark rather
     * than lit. The Release button still fully releases, which is its job.
     */
    function blackoutOnUnload() {
        if (!live || !fx) { return; }
        var parts = [];
        if (fx.dimmer) {
            parts.push((base + fx.dimmer - 1) + '-' + (base + fx.dimmer - 1));
        }
        if (fx.shutter) {
            parts.push((base + fx.shutter.channel - 1) + '-' + (base + fx.shutter.channel - 1));
        }
        if (!parts.length) { return; }
        try {
            fetch('/api/overlays/range/' + parts.join(',') + '/0',
                  { method: 'PUT', body: '{}', keepalive: true });
        } catch (e) { /* nothing useful to do at unload */ }
    }

    /**
     * Remember the values per fixture so a reload can show the truth.
     *
     * fppd offers no way to read back the final channel data - overlay ranges
     * bypass the model buffers entirely - so the page cannot ask the device where
     * a fixture is. Storing what we last wrote is the closest available answer,
     * and it is what makes take-control after a refresh a no-op rather than a
     * jump to center.
     */
    function valsKey() { return 'mht:vals:' + (fx ? fx.name : '?'); }

    var saveTimer = null;
    function saveVals() {
        if (!fx) { return; }
        if (saveTimer) { return; }
        // debounced: flush can run 25 times a second during a drag
        saveTimer = window.setTimeout(function () {
            saveTimer = null;
            try {
                window.localStorage.setItem(valsKey(), JSON.stringify(vals));
            } catch (e) { /* private browsing, quota - not worth failing over */ }
        }, 400);
    }

    function loadVals() {
        if (!fx) { return false; }
        try {
            var raw = window.localStorage.getItem(valsKey());
            if (!raw) { return false; }
            var v = JSON.parse(raw);
            if (!Array.isArray(v) || v.length !== fx.channelCount + 1) { return false; }
            for (var i = 0; i <= fx.channelCount; i++) {
                vals[i] = Math.max(0, Math.min(255, parseInt(v[i], 10) || 0));
            }
            // Unload blacked these out, so the fixture really is dark now -
            // restoring the old values here would misreport it.
            if (fx.dimmer) { vals[fx.dimmer] = 0; }
            if (fx.shutter) { vals[fx.shutter.channel] = 0; }
            return true;
        } catch (e) { return false; }
    }

    /* ---------------------------------------------------------------- Radar */

    // Pointer position on the pad -> angles, then through the same setAim() a
    // typed angle uses, so the two input routes cannot drift apart.
    function radarPoint(e) {
        var svg = $('mhtRadar');
        var b = svg.getBoundingClientRect();
        // A collapsed or not-yet-laid-out pad would divide by zero here and
        // carry NaN all the way into the channel values. Ignore the gesture
        // instead: better to do nothing than to command a garbage position.
        if (!(b.width > 0) || !(b.height > 0)) { return; }
        var x = (e.clientX - b.left) / b.width * padW;
        var y = (e.clientY - b.top) / b.height * padH;
        // clamped per axis, so every corner of the range is reachable
        var pb = panB(), tb = tiltB();
        setAim(pb.lo + (x / padW) * (pb.hi - pb.lo),
               tb.hi - (y / padH) * (tb.hi - tb.lo));
    }

    function center() { setAim(0, 0); }

    /* -------------------------------------------------------------- Surface */

    /**
     * Slider plus an editable number, bound both ways. Dragging is fine for
     * aiming but useless for "set this channel to exactly 137", so the readout
     * is a real input rather than a label.
     */
    function row(chAbs, label, value, max, onInput, muted) {
        var d = document.createElement('div');
        d.className = 'mhtRow';
        d.innerHTML = '<span class="mhtCh">' + chAbs + '</span>' +
            '<label title="' + label + '"' + (muted ? ' class="mhtMuted"' : '') + '>' + label + '</label>' +
            '<input type="range" min="0" max="' + max + '" step="1" value="' + value + '">' +
            '<input type="number" class="mhtVal" min="0" max="' + max + '" step="1" value="' + value + '"' +
            ' ' + PM_OPTOUT + '>';
        var slider = d.querySelector('input[type=range]');
        var num = d.querySelector('input[type=number]');
        bindPair(slider, num, max, onInput);
        return d;
    }

    /**
     * Keep a range and a number input in step. The number is only clamped on
     * blur/Enter, not on every keystroke - clamping mid-entry makes typing
     * "137" impossible, because "1" would immediately become the minimum.
     */
    function bindPair(slider, num, max, onInput) {
        slider.addEventListener('input', function () {
            num.value = slider.value;
            onInput(parseInt(slider.value, 10));
        });
        function commit() {
            var v = parseInt(num.value, 10);
            if (isNaN(v)) { v = 0; }
            v = clamp(v, 0, max);
            num.value = v;
            slider.value = v;
            onInput(v);
        }
        // 'input' so a typed value takes effect as it is entered, without
        // clamping; commit() on change/blur tidies it up and fixes the range.
        num.addEventListener('input', function () {
            var v = parseInt(num.value, 10);
            if (isNaN(v)) { return; }
            if (v < 0 || v > max) { return; }
            slider.value = v;
            onInput(v);
        });
        num.addEventListener('change', commit);
        num.addEventListener('blur', commit);
        num.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { commit(); num.blur(); }
        });
        return { slider: slider, num: num };
    }

    function buildSurface() {
        var sem = $('mhtSemantic');
        var raw = $('mhtRaw');
        sem.innerHTML = '';
        raw.innerHTML = '';

        rawInputs = {};

        // The lamp channel is deliberately NOT here. This group is what the model
        // itself declares; lamp control is config entered in this plugin, so its
        // slider lives with the other raw channels and only the Lamp On/Off
        // shortcuts appear in Quick Commands. Putting it here made the group's
        // own heading untrue.
        if (fx.dimmer) {
            var dr = row(base + fx.dimmer - 1, 'Dimmer', vals[fx.dimmer] || 0, 255, function (v) {
                vals[fx.dimmer] = v; flush();
            });
            sem.appendChild(dr);
        }

        // Shutter is a plain slider, not open/closed buttons. It is not a two
        // state channel: the range between closed and open is where strobe rate
        // lives on most fixtures, and DmxShutterOnValue is frequently absent
        // anyway. Quick Commands carries the open/closed shortcut.
        if (fx.shutter) {
            var sr = row(base + fx.shutter.channel - 1, 'Shutter', vals[fx.shutter.channel] || 0, 255, function (v) {
                vals[fx.shutter.channel] = v; flush();
            });
            sem.appendChild(sr);
        }

        if (fx.colorWheel && fx.colorWheel.positions.length) {
            var w = document.createElement('div');
            w.className = 'mhtRow mhtRowTop';
            w.innerHTML = '<span class="mhtCh">' + (base + fx.colorWheel.channel - 1) + '</span>' +
                '<label>Color</label>';
            var sw = document.createElement('div');
            sw.className = 'mhtSwatches';
            fx.colorWheel.positions.forEach(function (p) {
                var b = document.createElement('button');
                b.type = 'button';
                b.style.background = p.hex;
                b.title = 'DMX ' + p.dmx;
                b.addEventListener('click', function () {
                    vals[fx.colorWheel.channel] = p.dmx;
                    Array.prototype.forEach.call(sw.children, function (c) { c.className = ''; });
                    b.className = 'mhtOn';
                    flush();
                });
                sw.appendChild(b);
            });
            w.appendChild(sw);
            sem.appendChild(w);
        }

        // Everything the model did not claim: a labelled 0-255 slider. Blank
        // NodeNames entries already arrive as "Channel N" from the parser.
        var any = false;
        for (var o = 1; o <= fx.channelCount; o++) {
            if (fx.roles[o] !== 'raw') { continue; }
            any = true;
            (function (off) {
                var r = row(base + off - 1, fx.labels[off] || ('Channel ' + off),
                    vals[off] || 0, 255, function (v) { vals[off] = v; flush(); }, true);
                rawInputs[off] = r.querySelector('input[type=range]');
                raw.appendChild(r);
            })(o);
        }
        if (!any) {
            raw.innerHTML = '<div class="mhtNote">Every channel on this fixture has a declared role</div>';
        }

        $('mhtPanWrap').style.display = fx.pan ? '' : 'none';
        $('mhtTiltWrap').style.display = fx.tilt ? '' : 'none';
        $('mhtRadarWrap').style.display = (fx.pan || fx.tilt) ? '' : 'none';

        var zc = $('mhtZoneWrap');
        if (zc) {
            zc.style.display = (fx.zones && fx.zones.length) ? '' : 'none';
            var desc = (fx.zones || []).map(function (z) {
                return 'pan ' + z.panMin + '-' + z.panMax + ' forces ch' + z.channel + ' to ' + z.value;
            }).join(' · ');
            $('mhtZoneDesc').textContent = desc;
        }
    }

    /* ----------------------------------------------------------------- init */

    /**
     * Nothing is operable until Take control. The controls were previously live
     * to the eye but inert in code - pressing one silently did nothing, which is
     * indistinguishable from a broken tool. Disabling them makes the state
     * obvious, and means every value a fixture holds was put there deliberately
     * after taking control.
     *
     * The fixture selector and Take control itself stay enabled, for obvious
     * reasons.
     */
    function setControlsEnabled(on) {
        // Show only the action that applies. Release does nothing when no ranges
        // are held, and Take control does nothing while they are - offering both
        // at once invites a click that is a no-op, and on a page whose whole
        // point is knowing whether anything is being driven, the visible button
        // should answer that on its own. Hidden rather than disabled: a disabled
        // Release still reads as "there is something to release".
        var take = $('mhtTake'), rel = $('mhtRelease');
        if (take) { take.hidden = on; }
        if (rel) { rel.hidden = !on; }

        var scopes = ['mhtSemantic', 'mhtRaw'];
        scopes.forEach(function (id) {
            var el = $(id);
            if (!el) { return; }
            el.querySelectorAll('input, button, select').forEach(function (c) {
                c.disabled = !on;
            });
        });
        ['mhtCenter', 'mhtLampOn', 'mhtLampOff', 'mhtPanDeg', 'mhtTiltDeg', 'mhtHonor'].forEach(function (id) {
            var el = $(id);
            if (el) { el.disabled = !on; }
        });
        // No lamp config means no lamp command, in control or not. Both buttons
        // are owned by refreshLampButtons so the cooldown hold is not undone
        // here every time the surface is re-enabled.
        var haveLamp = !!(fx && fx.lamp);
        refreshLampButtons();
        var note = $('mhtLampNote');
        if (note) {
            // Built with DOM nodes rather than innerHTML: the only variable part
            // is the fixture name, which is model-supplied text.
            note.textContent = '';
            if (haveLamp) {
                note.appendChild(document.createTextNode(
                    'Lamp on channel ' + fx.lamp.channel + ': on = ' + fx.lamp.onValue +
                    ', off = ' + fx.lamp.offValue + ' - '));
                note.appendChild(lampJumpLink('change it'));
                note.appendChild(document.createTextNode('.'));
            } else {
                note.appendChild(document.createTextNode('No lamp channel configured for this fixture - '));
                note.appendChild(lampJumpLink('set one under Lamp Control'));
                note.appendChild(document.createTextNode('.'));
            }
        }
        var pad = $('mhtRadar');
        if (pad) { pad.classList.toggle('mhtInert', !on); }
        var wrap = $('mhtRadarWrap');
        if (wrap) { wrap.classList.toggle('mhtDimmed', !on); }
        var mask = $('mhtMask');
        if (mask) { mask.hidden = on; }
        tickCooldown();
    }

    function selectFixture(name) {
        var list = window.MHT_FIXTURES || [];
        fx = null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name) { fx = list[i]; break; }
        }
        if (!fx) { return; }
        cancelLampPulse();
        if (live) { release(); }
        base = fx.absoluteStart || 0;
        vals = new Array(fx.channelCount + 1);
        sent = new Array(fx.channelCount + 1);
        for (var o = 0; o <= fx.channelCount; o++) { vals[o] = 0; sent[o] = -1; }

        // Restore what was last written so the page reports where the fixture
        // actually is. Without this a refresh showed center while the head was
        // wherever it had been left, and taking control then moved it.
        var restored = loadVals();
        panDeg = 0;
        tiltDeg = 0;
        if (restored) {
            if (fx.pan) { panDeg = degFrom16(vals, fx.pan); }
            if (fx.tilt) { tiltDeg = degFrom16(vals, fx.tilt); }
        }
        buildSurface();
        buildPad();
        recompute();
        setControlsEnabled(false);
        if (restored) { log('Restored last known position for ' + fx.name); }
        $('mhtRange').textContent = base
            ? (base + ' – ' + (base + fx.channelCount - 1))
            : 'No absolute channel - set a controller base';
        $('mhtTake').disabled = !base;
        log('Selected ' + fx.name + ' (' + fx.channelCount + ' channels)');
    }

    /**
     * Save the lamp form without navigating.
     *
     * A normal form POST reloads the page, and a reload drops every bit of
     * client state - including being in control, which pagehide then releases on
     * the way out. Discovering the lamp values is something you do *while*
     * testing, so losing control to record them is exactly the wrong moment.
     * The same POST goes through fetch, the descriptor is updated in place, and
     * the surface is rebuilt from current values.
     */
    function wireLampForm() {
        var table = document.querySelectorAll('.mhtFieldset form[method="post"]');
        Array.prototype.forEach.call(table, function (form) {
            var action = form.querySelector('input[name="mhtAction"]');
            if (!action || action.value !== 'lamp') { return; }
            form.addEventListener('submit', function (e) {
                e.preventDefault();
                var fd = new FormData(form);
                var name = fd.get('fixture');
                fd.append('mhtAjax', '1');
                fetch(window.location.href, { method: 'POST', body: fd })
                    .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
                    .then(function (body) {
                        var res = parseResult(body);
                        // A rejected save must not report success, or a row that
                        // stored nothing looks identical to one that worked.
                        if (!res.ok) {
                            (res.problems || ['Lamp config not saved']).forEach(function (m) {
                                log('FAIL ' + stripTags(m));
                            });
                            showLampError(form, (res.problems || [])[0] || 'Not saved');
                            return;
                        }
                        showLampError(form, null);
                        var ch = parseInt(fd.get('lampChannel'), 10);
                        var target = null;
                        (window.MHT_FIXTURES || []).forEach(function (f) {
                            if (f.name === name) { target = f; }
                        });
                        if (target) {
                            if (isNaN(ch) || ch < 1) {
                                delete target.lamp;
                            } else {
                                target.lamp = {
                                    channel: ch,
                                    onValue: parseInt(fd.get('lampOn'), 10) || 0,
                                    offValue: parseInt(fd.get('lampOff'), 10) || 0,
                                    cooldownSec: parseInt(fd.get('lampCooldown'), 10) || 0
                                };
                            }
                        }
                        if (fx && fx.name === name) {
                            buildSurface();
                            setControlsEnabled(live);
                        }
                        var flag = form.querySelector('.mhtLampSaved');
                        if (flag) {
                            flag.hidden = false;
                            window.setTimeout(function () { flag.hidden = true; }, 2500);
                        }
                        log('Lamp config saved for ' + name + (live ? ' - still in control' : ''));
                    })
                    .catch(function (err) { log('FAIL saving lamp config: ' + err); });
            });
        });
    }

    /**
     * Pull the server's result out of the page it sends back.
     *
     * The plugin page is rendered inside FPP's own page shell, so the reply is
     * always HTML and cannot be a JSON response - the marker is the contract. A
     * reply with no marker means the request did not reach this version of the
     * page, which is treated as a failure rather than assumed to be a success.
     */
    function parseResult(body) {
        var m = /<!--MHT-RESULT:([\s\S]*?)-->/.exec(body || '');
        if (!m) {
            return { ok: false, problems: ['No reply from the plugin page - reload and retry'] };
        }
        try {
            return JSON.parse(m[1]);
        } catch (e) {
            return { ok: false, problems: ['Unreadable reply from the plugin page'] };
        }
    }

    // Server messages are built for HTML (names are escaped there); the log is a
    // text node, so undo that rather than showing &amp; to the user.
    function stripTags(m) {
        var d = document.createElement('div');
        d.innerHTML = m;
        return d.textContent || '';
    }

    function lampJumpLink(text) {
        var a = document.createElement('a');
        a.href = '#mhtLampControl';
        a.className = 'mhtJumpLamp';
        a.textContent = text;
        return a;
    }

    /**
     * Find the Lamp Control row belonging to a fixture.
     *
     * Matched on the form's own hidden fixture field rather than by building an
     * id or a selector out of the name - model names are free text and would
     * need escaping to survive either.
     */
    function lampRowFor(name) {
        var rows = document.querySelectorAll('form[data-lamp-row]');
        for (var i = 0; i < rows.length; i++) {
            var f = rows[i].querySelector('input[name="fixture"]');
            if (f && f.value === name) { return rows[i]; }
        }
        return null;
    }

    /**
     * Jump to where the lamp values are entered, for the fixture being driven.
     *
     * The plain href is a working anchor on its own, so this only has to improve
     * on it: land on the right fixture's row rather than the top of the section,
     * put the cursor in the Channel box ready to type, and flash the row so it is
     * obvious which of several rows was meant.
     */
    function jumpToLamp(e) {
        var row = fx ? lampRowFor(fx.name) : null;
        var target = row || $('mhtLampControl');
        if (!target) { return; }              // no section: let the href do its thing
        if (e) { e.preventDefault(); }

        scrollIntoViewSafely(target);
        row = row || null;
        var input = row ? row.querySelector('input[name="lampChannel"]') : null;
        if (input) {
            input.focus({ preventScroll: true });
            input.select();
        } else {
            $('mhtLampControl').focus({ preventScroll: true });
        }
        if (row) {
            row.classList.remove('mhtLampFlash');
            // Reading offsetWidth restarts the animation when the link is
            // clicked twice; without it the class is re-added in the same frame
            // and nothing appears to happen the second time.
            void row.offsetWidth;
            row.classList.add('mhtLampFlash');
            window.setTimeout(function () { row.classList.remove('mhtLampFlash'); }, 1600);
        }
    }

    function inViewport(el) {
        var r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= (window.innerHeight || 0);
    }

    /**
     * Scroll an element into view, and make sure it actually happened.
     *
     * Smooth scrolling is not always honored - it is a silent no-op in some
     * environments, and the user may have asked for reduced motion - and a jump
     * link that quietly does nothing is the very problem this link exists to
     * solve. So the smooth attempt is checked shortly afterwards and redone
     * instantly if the page has not moved and the target is still off screen.
     */
    function scrollIntoViewSafely(target) {
        var reduce = window.matchMedia &&
                     window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        var y0 = window.scrollY;
        try {
            target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        } catch (e) {
            target.scrollIntoView();   // ancient signature, no options object
        }
        if (reduce) { return; }
        window.setTimeout(function () {
            if (window.scrollY === y0 && !inViewport(target)) {
                target.scrollIntoView({ behavior: 'auto', block: 'center' });
            }
        }, 250);
    }

    function showLampError(form, msg) {
        var el = form.querySelector('.mhtLampErr');
        if (!el) {
            el = document.createElement('span');
            el.className = 'mhtLampErr';
            form.appendChild(el);
        }
        el.hidden = !msg;
        el.textContent = msg ? stripTags(msg) : '';
    }

    function init() {
        // The lamp form is wired FIRST, before the tool-DOM guard below. It does
        // not need the pad or the control surface, and the state where it matters
        // most is the one where those do not exist yet: nothing driveable, so you
        // are still configuring. Wiring it after the guard meant the form fell
        // back to a native POST exactly then - which reloads the page, which is
        // what "it doesn't take effect until I refresh" actually was.
        wireLampForm();

        // Delegated so it covers the note's link, which is rebuilt on every
        // setControlsEnabled(), as well as the static one in the warning text.
        document.addEventListener('click', function (e) {
            var a = e.target.closest ? e.target.closest('.mhtJumpLamp') : null;
            if (a) { jumpToLamp(e); }
        });

        // Seeded and ticking before the tool-DOM guard: a cooling lamp is worth
        // reporting even on a page with nothing driveable.
        initCooldowns();
        tickCooldown();
        window.setInterval(tickCooldown, 1000);

        // plugin.php auto-includes this file on every render of any page in the
        // plugin, including status.php with no fixtures imported yet and
        // about.php. Bail out quietly when the tool's DOM is not present rather
        // than throwing on a null element.
        if (!$('mhtRadar') || !$('mhtTake')) { return; }

        var sel = $('mhtFixture');
        if (sel) {
            sel.addEventListener('change', function () { selectFixture(sel.value); });
        }
        $('mhtTake').addEventListener('click', takeControl);
        // the mask is the obvious thing to click when it is covering everything
        var maskBtn = $('mhtMaskBtn');
        if (maskBtn) { maskBtn.addEventListener('click', takeControl); }
        var mask = $('mhtMask');
        if (mask) {
            mask.addEventListener('click', function (e) {
                if (e.target === mask) { takeControl(); }
            });
        }
        $('mhtRelease').addEventListener('click', release);
        $('mhtCenter').addEventListener('click', center);
        $('mhtLampOn').addEventListener('click', function () { setLamp(true); });
        $('mhtLampOff').addEventListener('click', function () { setLamp(false); });
        var z = $('mhtHonor');
        if (z) {
            z.addEventListener('change', function () { honorZones = z.checked; flush(); });
        }

        // Typed angles. setAim() clamps to the motor's own range of motion, so
        // an out-of-range entry lands at the limit rather than being rejected;
        // recompute() then writes the clamped number back into the field once
        // focus leaves it.
        ['mhtPanDeg', 'mhtTiltDeg'].forEach(function (id) {
            var el = $(id);
            if (!el) { return; }
            function apply() {
                var v = parseFloat(el.value);
                if (isNaN(v)) { return; }
                if (id === 'mhtPanDeg') { setAim(v, tiltDeg); } else { setAim(panDeg, v); }
            }
            el.addEventListener('input', apply);
            el.addEventListener('change', function () {
                apply();
                el.value = Math.round(id === 'mhtPanDeg' ? panDeg : tiltDeg);
            });
            el.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { apply(); el.blur(); }
            });
        });

        var svg = $('mhtRadar');
        svg.addEventListener('pointerdown', function (e) {
            if (!live) { return; }
            dragging = true;
            // Capture keeps the drag alive if the pointer leaves the pad, but it
            // is not essential - and it throws NotFoundError for a pointer id it
            // does not recognise. Uncaught, that abandons the handler before the
            // fixture is ever aimed, so the whole gesture silently does nothing.
            try {
                svg.setPointerCapture(e.pointerId);
            } catch (err) { /* drag still works, just not outside the pad */ }
            radarPoint(e);
        });
        svg.addEventListener('pointermove', function (e) {
            if (dragging) { radarPoint(e); }
        });
        svg.addEventListener('pointerup', function () {
            dragging = false;
            flush();   // settle the fine channels now the drag has ended
        });

        window.addEventListener('beforeunload', blackoutOnUnload);
        window.addEventListener('pagehide', blackoutOnUnload);

        if (sel && sel.options.length) { selectFixture(sel.value); }
    }

    return { init: init, release: release };
})();

if (document.readyState !== 'loading') {
    MHT.init();
} else {
    document.addEventListener('DOMContentLoaded', MHT.init);
}
