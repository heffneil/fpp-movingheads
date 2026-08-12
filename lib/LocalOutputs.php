<?php
/**
 * LocalOutputs - which channels this FPP instance actually puts on the wire.
 *
 * The plugin writes absolute channels through one instance's overlay API, and
 * that instance only emits channels inside its own output ranges. A write to a
 * channel outside them is accepted, returns {"Status":"OK"}, and does nothing
 * at all - the worst failure mode there is, because it is indistinguishable
 * from a wiring fault or a wrong address.
 *
 * So a fixture whose resolved block falls outside these ranges is not drivable
 * from here, and the UI needs to say so rather than let it look configured.
 *
 * Note the units: /api/system/info reports channelRanges 0-indexed, while
 * config/channeloutputs.json and the overlay API are 1-indexed. A DMX output
 * with startChannel 109433 and 16 channels appears as "109432-109447".
 */

class LocalOutputs
{
    /**
     * @return array|null List of [start0, end0] spans, or null when the
     *                    instance could not be asked - in which case callers
     *                    must not warn, since unknown is not the same as bad.
     */
    public static function ranges(): ?array
    {
        static $cached = false;
        static $value = null;
        if ($cached) {
            return $value;
        }
        $cached = true;

        $ctx = stream_context_create(['http' => ['timeout' => 3, 'ignore_errors' => true]]);
        $raw = @file_get_contents('http://localhost/api/system/info', false, $ctx);
        if ($raw === false) {
            return $value = null;
        }
        $j = json_decode($raw, true);
        if (!is_array($j) || !isset($j['channelRanges'])) {
            return $value = null;
        }

        $spans = [];
        foreach (explode(',', (string) $j['channelRanges']) as $part) {
            $part = trim($part);
            if ($part === '' || strpos($part, '-') === false) {
                continue;
            }
            list($a, $b) = explode('-', $part, 2);
            $a = (int) $a;
            $b = (int) $b;
            if ($b >= $a) {
                $spans[] = [$a, $b];
            }
        }
        // "0-0" is what an instance with nothing configured reports; treat it as
        // no usable information rather than as an empty output set.
        if (!$spans || ($spans === [[0, 0]])) {
            return $value = null;
        }
        return $value = $spans;
    }

    /**
     * Is a fixture's whole channel block emitted locally?
     *
     * @param int $start1 first channel, 1-indexed
     * @param int $count  channel count
     * @return bool|null  null when the ranges are unknown
     */
    public static function covers(int $start1, int $count): ?bool
    {
        $spans = self::ranges();
        if ($spans === null) {
            return null;
        }
        if ($start1 < 1 || $count < 1) {
            return false;
        }
        $lo = $start1 - 1;              // to 0-indexed, matching channelRanges
        $hi = $start1 + $count - 2;
        foreach ($spans as $s) {
            if ($s[0] <= $lo && $hi <= $s[1]) {
                return true;
            }
        }
        return false;
    }

    /** Human-readable ranges for a message, 1-indexed to match everything else. */
    public static function describe(): string
    {
        $spans = self::ranges();
        if ($spans === null) {
            return 'unknown';
        }
        $out = [];
        foreach ($spans as $s) {
            $out[] = ($s[0] + 1) . '-' . ($s[1] + 1);
        }
        return implode(', ', $out);
    }
}
