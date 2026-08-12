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
                // preserve a manual override the user set on the old entry
                if (isset($byName[$f['name']]['override'])) {
                    $f['override'] = $byName[$f['name']]['override'];
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
    public static function setLamp(string $name, ?int $channel, ?int $onValue, ?int $offValue): void
    {
        $out = [];
        foreach (self::fixtures() as $f) {
            if ($f['name'] === $name) {
                if ($channel === null || $channel < 1) {
                    unset($f['lamp']);
                } else {
                    $f['lamp'] = [
                        'channel' => $channel,
                        'onValue' => max(0, min(255, (int) $onValue)),
                        'offValue' => max(0, min(255, (int) $offValue)),
                    ];
                }
            }
            $out[] = $f;
        }
        self::saveFixtures($out);
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
