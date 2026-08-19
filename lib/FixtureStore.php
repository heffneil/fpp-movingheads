<?php
/**
 * FixtureStore - persistence for imported fixtures and per-controller bases.
 *
 * Follows PLUGIN_GUIDELINES.md #5 on filesystem boundaries:
 *   fixture data  -> <mediadir>/plugindata/<repoName>/fixtures.json
 *   small config  -> config/plugin.<repoName> via WriteSettingToFile()
 *
 * FPP's own helpers are used for settings rather than touching the file
 * directly (guideline #3), and nothing is written outside those two places.
 */

class FixtureStore
{
    const REPO = 'fpp-movingheads';

    private static function dataDir(): string
    {
        global $settings;
        $base = $settings['mediaDirectory'] ?? '/home/fpp/media';
        return rtrim($base, '/') . '/plugindata/' . self::REPO;
    }

    private static function dataFile(): string
    {
        return self::dataDir() . '/fixtures.json';
    }

    /** @return array list of fixture descriptors, possibly empty */
    public static function fixtures(): array
    {
        $f = self::dataFile();
        if (!is_readable($f)) {
            return [];
        }
        $j = json_decode((string) file_get_contents($f), true);
        return is_array($j) ? $j : [];
    }

    public static function saveFixtures(array $fixtures): bool
    {
        $dir = self::dataDir();
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
            return false;
        }
        $tmp = self::dataFile() . '.tmp';
        $json = json_encode($fixtures, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false || @file_put_contents($tmp, $json) === false) {
            return false;
        }
        // rename so a partial write can never leave a truncated fixture list
        return @rename($tmp, self::dataFile());
    }

    /**
     * Merge newly imported fixtures in, replacing same-named entries.
     * Fixtures are never merged across sources by name similarity - only an
     * exact name match replaces, because two shows can legitimately contain
     * different fixtures with confusingly similar names.
     *
     * @return array{added:int, replaced:int}
     */
    public static function merge(array $incoming): array
    {
        $existing = self::fixtures();
        $byName = [];
        foreach ($existing as $f) {
            $byName[$f['name']] = $f;
        }
        $added = 0;
        $replaced = 0;
        foreach ($incoming as $f) {
            if (isset($byName[$f['name']])) {
                $old = $byName[$f['name']];
                // Carry across everything the user set by hand, because none of
                // it is in the model file and re-importing must not silently
                // undo it. Re-importing is routine - it is how you pick up an
                // edit made in xLights - so losing this is losing real work.
                if (isset($old['override'])) {
                    $f['override'] = $old['override'];
                }
                // The lamp block especially: the channel is a guess the user
                // confirmed, the values come off a DMX chart, and lastOffAt is a
                // restrike cooldown in progress. Dropping that last one would
                // re-enable Lamp On on a lamp that is still cooling.
                if (isset($old['lamp'])) {
                    $f['lamp'] = $old['lamp'];
                }
                $replaced++;
            } else {
                $added++;
            }
            $byName[$f['name']] = $f;
        }
        self::saveFixtures(array_values($byName));
        return ['added' => $added, 'replaced' => $replaced];
    }

    public static function remove(string $name): void
    {
        $out = [];
        foreach (self::fixtures() as $f) {
            if ($f['name'] !== $name) {
                $out[] = $f;
            }
        }
        self::saveFixtures($out);
    }

    public static function setOverride(string $name, ?int $absolute): void
    {
        $out = [];
        foreach (self::fixtures() as $f) {
            if ($f['name'] === $name) {
                if ($absolute === null) {
                    unset($f['override']);
                } else {
                    $f['override'] = $absolute;
                }
            }
            $out[] = $f;
        }
        self::saveFixtures($out);
    }

    /**
     * Lamp control is per-fixture config, not model data.
     *
     * xLights cannot express it: its "Number of Fixed Channels" holds one fixed
     * value per channel, not a selectable on/off pair. And the values are
     * fixture-specific - striking an arc lamp with the wrong value is not
     * something to guess at - so they are entered, never inferred. Absent lamp
     * config means no lamp buttons at all.
     */
    /**
     * Default restrike cooldown, in seconds.
     *
     * A discharge lamp must cool before it will strike again, and forcing it
     * shortens lamp life or fails outright. Five minutes is a conservative
     * middle ground - it is NOT read from the fixture, so it is editable and
     * should be set from the fixture's own manual.
     */
    const DEFAULT_COOLDOWN = 300;

    public static function setLamp(string $name, ?int $channel, ?int $onValue, ?int $offValue,
                                   ?int $cooldownSec = null): void
    {
        $out = [];
        foreach (self::fixtures() as $f) {
            if ($f['name'] === $name) {
                if ($channel === null || $channel < 1) {
                    unset($f['lamp']);
                } else {
                    $existing = $f['lamp'] ?? [];
                    $f['lamp'] = [
                        'channel' => $channel,
                        'onValue' => max(0, min(255, (int) $onValue)),
                        'offValue' => max(0, min(255, (int) $offValue)),
                        // preserved across an edit: a cooldown in progress is a
                        // property of the hardware, not of this config form
                        'cooldownSec' => $cooldownSec !== null
                            ? max(0, $cooldownSec)
                            : (int) ($existing['cooldownSec'] ?? self::DEFAULT_COOLDOWN),
                        'lastOffAt' => (int) ($existing['lastOffAt'] ?? 0),
                    ];
                }
            }
            $out[] = $f;
        }
        self::saveFixtures($out);
    }

    /**
     * Record that the lamp was just switched off, so the restrike cooldown
     * survives a page reload and applies in any browser. Stored server-side
     * deliberately: the cooling lamp is a shared physical fact, not a per-tab one.
     */
    public static function markLampOff(string $name): void
    {
        $out = [];
        foreach (self::fixtures() as $f) {
            if ($f['name'] === $name && isset($f['lamp'])) {
                $f['lamp']['lastOffAt'] = time();
            }
            $out[] = $f;
        }
        self::saveFixtures($out);
    }

    /** Seconds still to wait before a restrike, 0 when clear. */
    public static function cooldownRemaining(array $fixture): int
    {
        $lamp = $fixture['lamp'] ?? null;
        if (!$lamp) {
            return 0;
        }
        $secs = (int) ($lamp['cooldownSec'] ?? self::DEFAULT_COOLDOWN);
        $last = (int) ($lamp['lastOffAt'] ?? 0);
        if ($secs <= 0 || $last <= 0) {
            return 0;
        }
        // Capped at the configured span as well as floored at zero: an FPP that
        // has no RTC picks up the real time from NTP after boot, which can leave
        // a timestamp in the future and would otherwise stretch the wait.
        return (int) max(0, min($secs, $secs - (time() - $last)));
    }

    /** @return array<string,int> controller name => base channel */
    public static function bases(): array
    {
        $raw = ReadSettingFromFile('controllerBases', self::REPO);
        if (!is_string($raw) || $raw === '') {
            return [];
        }
        $j = json_decode($raw, true);
        return is_array($j) ? $j : [];
    }

    public static function setBase(string $controller, int $base): void
    {
        $b = self::bases();
        $b[$controller] = max(1, $base);
        WriteSettingToFile('controllerBases', json_encode($b), self::REPO);
    }

    /**
     * Resolve a fixture's absolute start channel.
     * Precedence: manual override, then an already-absolute StartChannel,
     * then controllerBase + offset - 1. Null when it cannot be determined.
     */
    public static function absoluteStart(array $fixture, ?array $bases = null): ?int
    {
        if (isset($fixture['override']) && (int) $fixture['override'] > 0) {
            return (int) $fixture['override'];
        }
        $s = $fixture['start'] ?? [];
        if (($s['mode'] ?? '') === 'absolute' && (int) ($s['absolute'] ?? 0) > 0) {
            return (int) $s['absolute'];
        }
        if (($s['mode'] ?? '') === 'relative') {
            $bases = $bases ?? self::bases();
            $c = $s['controller'] ?? '';
            if (isset($bases[$c]) && (int) $bases[$c] > 0) {
                return (int) $bases[$c] + (int) $s['offset'] - 1;
            }
        }
        return null;
    }

    /** Controller names referenced by relative fixtures, for the bases form. */
    public static function controllers(): array
    {
        $out = [];
        foreach (self::fixtures() as $f) {
            if (($f['start']['mode'] ?? '') === 'relative') {
                $out[$f['start']['controller']] = true;
            }
        }
        return array_keys($out);
    }
}
