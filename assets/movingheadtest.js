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
    var dimmerInput = null;   // held so the quick commands can move the control
    var shutterInput = null;
    var rawInputs = {};       // channel offset -> its range input
    var R = 144, C = 150;     // radar geometry, in the 300x300 viewBox

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
        if (fx.pan) {
            setFieldValue($('mhtPanDeg'), Math.round(panDeg));
            $('mhtPanRaw').textContent = 'ch' + fx.pan.coarse + '=' + vals[fx.pan.coarse] +
                (fx.pan.fine > 0 ? ' ch' + fx.pan.fine + '=' + vals[fx.pan.fine] : '');
        }
        if (fx.tilt) {
            setFieldValue($('mhtTiltDeg'), Math.round(tiltDeg));
            $('mhtTiltRaw').textContent = 'ch' + fx.tilt.coarse + '=' + vals[fx.tilt.coarse] +
                (fx.tilt.fine > 0 ? ' ch' + fx.tilt.fine + '=' + vals[fx.tilt.fine] : '');
        }
    }

    function panLimit() { return fx.pan ? Math.min(180, fx.pan.range / 2) : 180; }
    function tiltLimit() { return fx.tilt ? Math.min(180, fx.tilt.range / 2) : 135; }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    // Single entry point for aiming, so a drag and a typed angle behave
    // identically: clamp, move the dot, recompute channels, write.
    function setAim(p, t) {
        panDeg = clamp(p, -panLimit(), panLimit());
        tiltDeg = clamp(t, -tiltLimit(), tiltLimit());
        placeDot();
        recompute();
        flush();
    }

    // Inverse of the pointer mapping: put the dot where the current angles say.
    //
    // Horizontal is pan, vertical is tilt. A bearing-and-radius ("polar") mode
    // used to be offered here and was removed: radius is a magnitude, so it
    // could only ever reach positive tilt - the bottom half of the pad simply
    // duplicated the top - and dead center was degenerate, with atan2(0, -0)
    // snapping pan to 180. The rings and bearing labels give the radar look
    // without costing half the tilt range.
    function placeDot() {
        var dx = (panDeg / panLimit()) * R;
        var dy = -(tiltDeg / tiltLimit()) * R;
        $('mhtDot').setAttribute('cx', C + dx);
        $('mhtDot').setAttribute('cy', C + dy);
        $('mhtRay').setAttribute('x2', C + dx);
        $('mhtRay').setAttribute('y2', C + dy);
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
    /**
     * Light off / on as a symmetric pair, driving only the dimmer and shutter.
     *
     * Neither touches a lamp-control channel (MH1 channel 16, "Lamp / Reset").
     * On many fixtures that strikes or douses the arc lamp itself, takes time to
     * restrike, and shortens lamp life - not something a one-click button should
     * do. Use that channel's own slider if you really mean it.
     *
     * "On" uses the model's own DmxShutterOnValue where it declares one, rather
     * than assuming 255 means open.
     */
    function setLight(on) {
        if (!fx || !live) { return; }
        var touched = false;
        if (fx.dimmer) {
            vals[fx.dimmer] = on ? 255 : 0;
            if (dimmerInput) { dimmerInput.value = vals[fx.dimmer]; syncNumberFor(dimmerInput); }
            touched = true;
        }
        if (fx.shutter) {
            var openVal = (fx.shutter.onValue === null || fx.shutter.onValue === undefined)
                ? 255 : fx.shutter.onValue;
            vals[fx.shutter.channel] = on ? openVal : 0;
            if (shutterInput) { shutterInput.value = vals[fx.shutter.channel]; syncNumberFor(shutterInput); }
            touched = true;
        }
        if (touched) {
            log(on ? 'Light on: shutter open, dimmer full' : 'Light off: dimmer and shutter to 0');
            flush();
        }
    }

    function blackout() { setLight(false); }

    /**
     * Lamp strike / douse. Only available when the fixture has lamp config,
     * because the channel and its two values are fixture-specific and are never
     * guessed - the wrong value on an arc lamp is not a harmless mistake.
     */
    function setLamp(on) {
        if (!fx || !live || !fx.lamp) { return; }
        var ch = fx.lamp.channel;
        var v = on ? fx.lamp.onValue : fx.lamp.offValue;
        vals[ch] = v;
        var inp = rawInputs[ch];
        if (inp) { inp.value = v; syncNumberFor(inp); }
        log('Lamp ' + (on ? 'on' : 'off') + ': ch' + ch + ' = ' + v);
        flush();
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
        live = false;
        $('mhtState').textContent = 'Released';
        $('mhtState').className = 'mhtPill mhtOff';
        setControlsEnabled(false);
        put(releasePath());
    }

    // Best-effort release when the tab goes away. sendBeacon cannot issue a
    // PUT, so this is a keepalive fetch; if even that is dropped the range
    // stays until someone releases it, which is why the button exists.
    function releaseOnUnload() {
        if (!live) { return; }
        live = false;
        try {
            fetch(releasePath(), { method: 'PUT', body: '{}', keepalive: true });
        } catch (e) { /* nothing useful to do at unload */ }
    }

    /* ---------------------------------------------------------------- Radar */

    // Pointer position on the pad -> angles, then through the same setAim() a
    // typed angle uses, so the two input routes cannot drift apart.
    function radarPoint(e) {
        var svg = $('mhtRadar');
        var b = svg.getBoundingClientRect();
        var x = (e.clientX - b.left) / b.width * 300;
        var y = (e.clientY - b.top) / b.height * 300;
        var dx = x - C, dy = y - C;
        var d = Math.hypot(dx, dy);
        if (d > R) { dx *= R / d; dy *= R / d; }
        setAim((dx / R) * panLimit(), -(dy / R) * tiltLimit());
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

        dimmerInput = null;
        shutterInput = null;
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
            dimmerInput = dr.querySelector('input[type=range]');
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
            shutterInput = sr.querySelector('input[type=range]');
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
        var scopes = ['mhtSemantic', 'mhtRaw'];
        scopes.forEach(function (id) {
            var el = $(id);
            if (!el) { return; }
            el.querySelectorAll('input, button, select').forEach(function (c) {
                c.disabled = !on;
            });
        });
        ['mhtCenter', 'mhtLampOn', 'mhtLampOff', 'mhtLightOn', 'mhtBlackout', 'mhtPanDeg', 'mhtTiltDeg', 'mhtHonor'].forEach(function (id) {
            var el = $(id);
            if (el) { el.disabled = !on; }
        });
        // No lamp config means no lamp command, in control or not.
        var haveLamp = !!(fx && fx.lamp);
        ['mhtLampOn', 'mhtLampOff'].forEach(function (id) {
            var el = $(id);
            if (el) { el.disabled = !on || !haveLamp; }
        });
        var note = $('mhtLampNote');
        if (note) {
            note.textContent = haveLamp
                ? ('Lamp on channel ' + fx.lamp.channel + ': on = ' + fx.lamp.onValue +
                   ', off = ' + fx.lamp.offValue)
                : 'No lamp channel configured for this fixture - set one under Lamp Control below.';
        }
        var pad = $('mhtRadar');
        if (pad) { pad.classList.toggle('mhtInert', !on); }
        var wrap = $('mhtRadarWrap');
        if (wrap) { wrap.classList.toggle('mhtDimmed', !on); }
        var mask = $('mhtMask');
        if (mask) { mask.hidden = on; }
    }

    function selectFixture(name) {
        var list = window.MHT_FIXTURES || [];
        fx = null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name) { fx = list[i]; break; }
        }
        if (!fx) { return; }
        if (live) { release(); }
        base = fx.absoluteStart || 0;
        vals = new Array(fx.channelCount + 1);
        sent = new Array(fx.channelCount + 1);
        for (var o = 0; o <= fx.channelCount; o++) { vals[o] = 0; sent[o] = -1; }
        panDeg = 0; tiltDeg = 0;
        buildSurface();
        recompute();
        setAim(0, 0);
        setControlsEnabled(false);
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
                fetch(window.location.href, { method: 'POST', body: fd })
                    .then(function (r) { return r.ok ? r.text() : Promise.reject(r.status); })
                    .then(function () {
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
                                    offValue: parseInt(fd.get('lampOff'), 10) || 0
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

    function init() {
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
        $('mhtLightOn').addEventListener('click', function () { setLight(true); });
        $('mhtBlackout').addEventListener('click', blackout);
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

        window.addEventListener('beforeunload', releaseOnUnload);
        window.addEventListener('pagehide', releaseOnUnload);

        wireLampForm();
        if (sel && sel.options.length) { selectFixture(sel.value); }
    }

    return { init: init, release: release };
})();

if (document.readyState !== 'loading') {
    MHT.init();
} else {
    document.addEventListener('DOMContentLoaded', MHT.init);
}
