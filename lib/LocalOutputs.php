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
        // Always localhost:80 on a real player - FPP's own web server. The env
        // override exists only so the off-device harness can serve a stand-in on
        // another port; without it this call silently failed there (port 80 on a
        // dev machine is not FPP), which is why the not-driveable path went
        // untested for so long while appearing to be a threading limitation.
        $base = getenv('MHT_API_BASE') ?: 'http://localhost';
        $raw = @file_get_contents(rtrim($base, '/') . '/api/system/info', false, $ctx);
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
        // An empty list is NOT the same as not knowing. "0-0", or an empty
        // channelRanges, is a definite answer: this instance emits nothing. It
        // used to be folded in with "could not ask" and returned null, which made
        // every fixture read as driveable on an instance whose outputs had just
        // been deleted - the exact silent-write failure this class exists to
        // prevent, produced by the class itself. Only an unanswerable question
        // returns null now; a clear "nothing" returns [].
        if ($spans === [[0, 0]]) {
            $spans = [];
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

    /**
     * DMX outputs this instance emits, read from its own channel-output config.
     *
     * A controller-relative StartChannel needs a base channel, and the plugin was
     * telling people to go and find it: "Input/Output Setup -> Other shows the
     * DMX output's start channel". That number is in a config file on this very
     * machine, so read it and offer it instead of sending someone hunting.
     *
     * Only enabled outputs, and only DMX types - an E1.31 or pixel-string output
     * start channel is not a DMX fixture's base and offering it would be worse
     * than offering nothing.
     *
     * @return array<int,array{start:int,count:int,device:string,type:string}>
     */
    public static function dmxOutputs(): array
    {
        global $settings;
        static $cached = null;
        if ($cached !== null) {
            return $cached;
        }
        $cached = [];

        $dir = $settings['configDirectory'] ?? '';
        if ($dir === '') {
            $media = $settings['mediaDirectory'] ?? '/home/fpp/media';
            $dir = rtrim($media, '/') . '/config';
        }
        $file = rtrim($dir, '/') . '/co-other.json';
        if (!is_readable($file)) {
            return $cached;
        }
        $j = json_decode((string) @file_get_contents($file), true);
        if (!is_array($j) || !isset($j['channelOutputs']) || !is_array($j['channelOutputs'])) {
            return $cached;
        }
        foreach ($j['channelOutputs'] as $o) {
            if (!is_array($o) || empty($o['enabled'])) {
                continue;
            }
            $type = (string) ($o['type'] ?? '');
            if (stripos($type, 'DMX') === false) {
                continue;
            }
            $start = (int) ($o['startChannel'] ?? 0);
            $count = (int) ($o['channelCount'] ?? 0);
            if ($start < 1 || $count < 1) {
                continue;
            }
            $cached[] = [
                'start' => $start,
                'count' => $count,
                'device' => (string) ($o['device'] ?? ''),
                'type' => $type,
            ];
        }
        return $cached;
    }

    /**
     * The single obvious base channel, or 0 when it is not obvious.
     *
     * One enabled DMX output means one candidate and it can be offered as a
     * prefilled value. Several means guessing which one a given fixture hangs
     * off, so they are listed for the user to choose from instead.
     */
    public static function suggestedBase(): int
    {
        $outs = self::dmxOutputs();
        return count($outs) === 1 ? $outs[0]['start'] : 0;
    }

    /** Human-readable ranges for a message, 1-indexed to match everything else. */
    public static function describe(): string
    {
        $spans = self::ranges();
        if ($spans === null) {
            return 'unknown';
        }
        if ($spans === []) {
            return 'none - this instance has no channel outputs configured';
        }
        $out = [];
        foreach ($spans as $s) {
            $out[] = ($s[0] + 1) . '-' . ($s[1] + 1);
        }
        return implode(', ', $out);
    }
}
