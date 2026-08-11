<?php
/**
 * XmodelParser - turns xLights model XML into fixture descriptors.
 *
 * Pure: takes a string of XML, returns arrays. No I/O, no FPP dependencies,
 * no globals. That is deliberate - this is the part most likely to carry bugs
 * and it must be testable without a device or a running fppd.
 *
 * Accepts either shape:
 *   - an exported .xmodel   (<models type="exported"><model .../></models>)
 *   - a whole xlights_rgbeffects.xml (every <model> anywhere in the tree)
 */

class XmodelParser
{
    /**
     * @return array{fixtures: array, errors: array}
     */
    public static function parse(string $xml): array
    {
        $errors = [];
        $prev = libxml_use_internal_errors(true);
        $doc = simplexml_load_string($xml);
        foreach (libxml_get_errors() as $e) {
            $errors[] = 'XML: ' . trim($e->message);
        }
        libxml_clear_errors();
        libxml_use_internal_errors($prev);

        if ($doc === false) {
            return ['fixtures' => [], 'errors' => $errors ?: ['Could not parse the file as XML.']];
        }

        $fixtures = [];
        foreach ($doc->xpath('//model') as $m) {
            $displayAs = (string) ($m['DisplayAs'] ?? '');
            if (stripos($displayAs, 'Dmx') === false) {
                continue; // not a DMX fixture, nothing for us to drive
            }
            $f = self::descriptor($m);
            if ($f !== null) {
                $fixtures[] = $f;
            }
        }

        if (!$fixtures && !$errors) {
            $errors[] = 'No DMX models found in that file.';
        }
        return ['fixtures' => $fixtures, 'errors' => $errors];
    }

    private static function descriptor(SimpleXMLElement $m): ?array
    {
        $name = (string) ($m['name'] ?? '');
        if ($name === '') {
            return null;
        }

        $labels = self::labels($m);
        $count = self::intAttr($m, 'DmxChannelCount');
        if ($count <= 0) {
            // Show-file models routinely omit DmxChannelCount even though
            // exported .xmodel files carry it. NodeNames is the fallback.
            $count = count($labels);
        }
        if ($count <= 0) {
            return null;
        }

        $roles = array_fill(1, $count, 'raw');
        $claim = function (int $ch, string $role) use (&$roles, $count): bool {
            // 0 means "unset" in xLights and must never be treated as a channel.
            if ($ch >= 1 && $ch <= $count) {
                $roles[$ch] = $role;
                return true;
            }
            return false;
        };

        $pan = self::motor($m, 'PanMotor', 540.0);
        $tilt = self::motor($m, 'TiltMotor', 270.0);
        if ($pan) {
            $claim($pan['coarse'], 'panCoarse');
            $claim($pan['fine'], 'panFine');
        }
        if ($tilt) {
            $claim($tilt['coarse'], 'tiltCoarse');
            $claim($tilt['fine'], 'tiltFine');
        }

        $dimmer = self::intAttr($m, 'DmxDimmerChannel');
        if ($dimmer <= 0) {
            $dimmer = self::intAttr($m, 'MhDimmerChannel');
        }
        if (!$claim($dimmer, 'dimmer')) {
            $dimmer = 0;
        }

        $shutter = null;
        $sc = self::intAttr($m, 'DmxShutterChannel');
        if ($claim($sc, 'shutter')) {
            $onAttr = $m['DmxShutterOnValue'] ?? null;
            $shutter = [
                'channel' => $sc,
                // absent is not the same as 255; leave it unknown and let the
                // UI offer a raw value instead of inventing an "open" level.
                'onValue' => $onAttr === null ? null : (int) $onAttr,
            ];
        }

        $wheel = null;
        $wc = self::intAttr($m, 'DmxColorWheelChannel');
        if ($claim($wc, 'colorWheel')) {
            $wheel = ['channel' => $wc, 'positions' => self::wheel($m)];
        }

        return [
            'name' => $name,
            'type' => (string) ($m['DisplayAs'] ?? ''),
            'channelCount' => $count,
            'labels' => $labels,
            'roles' => $roles,
            'start' => self::startChannel($m),
            'pan' => $pan,
            'tilt' => $tilt,
            'dimmer' => $dimmer ?: null,
            'shutter' => $shutter,
            'colorWheel' => $wheel,
            'zones' => self::zones($m),
        ];
    }

    /** NodeNames, 1-indexed, with a positional fallback for blank entries. */
    private static function labels(SimpleXMLElement $m): array
    {
        $raw = (string) ($m['NodeNames'] ?? '');
        if ($raw === '') {
            return [];
        }
        $out = [];
        foreach (explode(',', $raw) as $i => $lab) {
            $lab = trim($lab);
            $out[$i + 1] = $lab !== '' ? $lab : ('Channel ' . ($i + 1));
        }
        return $out;
    }

    /**
     * StartChannel comes in two forms and both occur in real show files:
     *   "!Controller Name:12"  -> relative, needs a per-controller base
     *   "295200"               -> already absolute
     */
    private static function startChannel(SimpleXMLElement $m): array
    {
        $s = trim((string) ($m['StartChannel'] ?? ''));
        if ($s !== '' && $s[0] === '!') {
            $pos = strrpos($s, ':');
            if ($pos !== false) {
                return [
                    'mode' => 'relative',
                    'controller' => substr($s, 1, $pos - 1),
                    'offset' => max(1, (int) substr($s, $pos + 1)),
                    'raw' => $s,
                ];
            }
        }
        if ($s !== '' && ctype_digit($s)) {
            return ['mode' => 'absolute', 'absolute' => (int) $s, 'raw' => $s];
        }
        return ['mode' => 'unknown', 'raw' => $s];
    }

    private static function motor(SimpleXMLElement $m, string $tag, float $defaultRange): ?array
    {
        $n = $m->{$tag};
        if (!$n || !count($n)) {
            return null;
        }
        $n = $n[0];
        $coarse = (int) ($n['ChannelCoarse'] ?? 0);
        if ($coarse <= 0) {
            return null;
        }
        $range = (float) ($n['RangeOfMotion'] ?? $defaultRange);
        return [
            'coarse' => $coarse,
            'fine' => (int) ($n['ChannelFine'] ?? 0),
            'range' => $range > 0 ? $range : $defaultRange,
            'reverse' => ((string) ($n['Reverse'] ?? '0')) === '1',
            'orientHome' => (float) ($n['OrientHome'] ?? 0),
            'min' => (float) ($n['MinLimit'] ?? -180),
            'max' => (float) ($n['MaxLimit'] ?? 180),
        ];
    }

    /** DmxColorWheelDMXn / DmxColorWheelColorn pairs, ordered by index. */
    private static function wheel(SimpleXMLElement $m): array
    {
        $out = [];
        foreach ($m->attributes() as $k => $v) {
            if (preg_match('/^DmxColorWheelDMX(\d+)$/', (string) $k, $mm)) {
                $i = (int) $mm[1];
                $hex = (string) ($m['DmxColorWheelColor' . $i] ?? '');
                $out[$i] = [
                    'dmx' => (int) $v,
                    'hex' => preg_match('/^#[0-9a-fA-F]{6}$/', $hex) ? $hex : '#888888',
                ];
            }
        }
        ksort($out);
        return array_values($out);
    }

    /**
     * PositionZone: when pan/tilt fall inside the box, force a channel to a
     * value. Absent zones are normal - most models have none.
     */
    private static function zones(SimpleXMLElement $m): array
    {
        $out = [];
        foreach ($m->PositionZone as $z) {
            $ch = (int) ($z['Channel'] ?? 0);
            if ($ch <= 0) {
                continue;
            }
            $out[] = [
                'panMin' => (int) ($z['PanMin'] ?? 0),
                'panMax' => (int) ($z['PanMax'] ?? 255),
                'tiltMin' => (int) ($z['TiltMin'] ?? 0),
                'tiltMax' => (int) ($z['TiltMax'] ?? 255),
                'channel' => $ch,
                'value' => (int) ($z['Value'] ?? 0),
            ];
        }
        return $out;
    }

    private static function intAttr(SimpleXMLElement $m, string $attr): int
    {
        return isset($m[$attr]) ? (int) $m[$attr] : 0;
    }
}
