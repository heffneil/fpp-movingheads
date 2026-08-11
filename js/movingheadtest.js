/*
 * fpp-plugin-MovingHeadTest - client runtime
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
    var honourZones = true;
    var polar = false;
    var dimmerInput = null;   // held so "Lamp off" can move the control itself
    var shutterInput = null;
    var R = 144, C = 150;     // radar geometry, in the 300x300 viewBox

    function $(id) { return document.getElementById(id); }

    /* ------------------------------------------------------------- Channels */

    // Degrees to a 16-bit position across the motor's full range of motion.
    // A fixture with no fine channel gets the high byte only.
    function degTo16(deg, motor) {
        var half = motor.range / 2;
        var v = Math.round(((deg + half) / motor.range) * 65535);
        if (v < 0) { v = 0; }
        if (v > 65535) { v = 65535; }
        return motor.reverse ? (65535 - v) : v;
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
    function placeDot() {
        var dx, dy;
        if (polar) {
            var a = panDeg * Math.PI / 180;
            var r = (Math.abs(tiltDeg) / tiltLimit()) * R;
            dx = Math.sin(a) * r;
            dy = -Math.cos(a) * r;
        } else {
            dx = (panDeg / panLimit()) * R;
            dy = -(tiltDeg / tiltLimit()) * R;
        }
        $('mhtDot').setAttribute('cx', C + dx);
        $('mhtDot').setAttribute('cy', C + dy);
        $('mhtRay').setAttribute('x2', C + dx);
        $('mhtRay').setAttribute('y2', C + dy);
    }

    /* ---------------------------------------------------------------- Zones */

    // PositionZone: while pan/tilt sit inside the box, a channel is forced to
    // a value. Pure - returns a copy, never mutates vals, so the honour/ignore
    // toggle is just whether the caller uses the result.
    function withZones(src) {
        if (!honourZones || !fx.zones || !fx.zones.length || !fx.pan || !fx.tilt) {
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
            el.textContent = hit.length ? ('active: ' + hit.join(', ')) : 'not in a zone';
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

    function takeControl() {
        if (!fx || !base) { return; }
        live = true;
        for (var i = 0; i <= fx.channelCount; i++) { sent[i] = -1; }
        $('mhtState').textContent = 'in control';
        $('mhtState').className = 'mhtPill mhtLive';
        log('--- took control of ' + fx.name + ' at ' + base + '-' + (base + fx.channelCount - 1));
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
        $('mhtState').textContent = 'released';
        $('mhtState').className = 'mhtPill mhtOff';
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
        if (polar) {
            setAim(Math.atan2(dx, -dy) * 180 / Math.PI, (Math.hypot(dx, dy) / R) * tiltLimit());
        } else {
            setAim((dx / R) * panLimit(), -(dy / R) * tiltLimit());
        }
    }

    function centre() { setAim(0, 0); }

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
            '<input type="number" class="mhtVal" min="0" max="' + max + '" step="1" value="' + value + '">';
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

        if (fx.dimmer) {
            var dr = row(base + fx.dimmer - 1, 'Dimmer', 0, 255, function (v) {
                vals[fx.dimmer] = v; flush();
            });
            dimmerInput = dr.querySelector('input');
            sem.appendChild(dr);
        }

        if (fx.shutter) {
            var d = document.createElement('div');
            d.className = 'mhtRow';
            var on = fx.shutter.onValue;
            d.innerHTML = '<span class="mhtCh">' + (base + fx.shutter.channel - 1) + '</span>' +
                '<label title="Shutter">Shutter</label>';
            if (on !== null && on !== undefined) {
                var bOpen = document.createElement('button');
                bOpen.type = 'button'; bOpen.textContent = 'Open';
                var bShut = document.createElement('button');
                bShut.type = 'button'; bShut.textContent = 'Closed'; bShut.className = 'mhtOn';
                bOpen.addEventListener('click', function () {
                    vals[fx.shutter.channel] = on;
                    bOpen.className = 'mhtOn'; bShut.className = ''; flush();
                });
                bShut.addEventListener('click', function () {
                    vals[fx.shutter.channel] = 0;
                    bShut.className = 'mhtOn'; bOpen.className = ''; flush();
                });
                d.appendChild(bOpen); d.appendChild(bShut);
            }
            // Always offer the raw value too: DmxShutterOnValue is often absent,
            // and strobe lives at values between closed and open anyway.
            var sl = document.createElement('input');
            sl.type = 'range'; sl.min = 0; sl.max = 255; sl.step = 1; sl.value = 0;
            var sv = document.createElement('input');
            sv.type = 'number'; sv.className = 'mhtVal';
            sv.min = 0; sv.max = 255; sv.step = 1; sv.value = 0;
            bindPair(sl, sv, 255, function (v) {
                vals[fx.shutter.channel] = v;
                flush();
            });
            d.appendChild(sl); d.appendChild(sv);
            sem.appendChild(d);
            shutterInput = sl;
        }

        if (fx.colorWheel && fx.colorWheel.positions.length) {
            var w = document.createElement('div');
            w.className = 'mhtRow mhtRowTop';
            w.innerHTML = '<span class="mhtCh">' + (base + fx.colorWheel.channel - 1) + '</span>' +
                '<label>Colour</label>';
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
                raw.appendChild(row(base + off - 1, fx.labels[off] || ('Channel ' + off),
                    0, 255, function (v) { vals[off] = v; flush(); }, true));
            })(o);
        }
        if (!any) {
            raw.innerHTML = '<div class="mhtNote">every channel on this fixture has a declared role</div>';
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
        $('mhtRange').textContent = base
            ? (base + ' – ' + (base + fx.channelCount - 1))
            : 'no absolute channel - set a controller base';
        $('mhtTake').disabled = !base;
        log('--- selected ' + fx.name + ' (' + fx.channelCount + ' channels)');
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
        $('mhtRelease').addEventListener('click', release);
        $('mhtCentre').addEventListener('click', centre);
        // Update the two inputs in place rather than rebuilding the surface:
        // buildSurface() renders every slider at 0, so rebuilding here would
        // show every other channel as 0 while its real value was still live.
        $('mhtLampOff').addEventListener('click', function () {
            if (fx.dimmer) {
                vals[fx.dimmer] = 0;
                if (dimmerInput) {
                    dimmerInput.value = 0;
                    dimmerInput.dispatchEvent(new Event('input'));
                }
            }
            if (fx.shutter) {
                vals[fx.shutter.channel] = 0;
                if (shutterInput) {
                    shutterInput.value = 0;
                    shutterInput.dispatchEvent(new Event('input'));
                }
            }
            flush();
        });
        var z = $('mhtHonour');
        if (z) {
            z.addEventListener('change', function () { honourZones = z.checked; flush(); });
        }
        var p = $('mhtPolar');
        if (p) {
            p.addEventListener('change', function () { polar = p.checked; centre(); });
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
            dragging = true;
            svg.setPointerCapture(e.pointerId);
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

        if (sel && sel.options.length) { selectFixture(sel.value); }
    }

    return { init: init, release: release };
})();

if (document.readyState !== 'loading') {
    MHT.init();
} else {
    document.addEventListener('DOMContentLoaded', MHT.init);
}
