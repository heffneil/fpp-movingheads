<?php
// Seeds the preview media dir with real fixtures so the page has something to
// drive. Uses the same stubs and the same directory the preview server uses.
$ROOT = dirname(__DIR__);
$WORK = $ROOT . '/harness/.preview-media';
@mkdir($WORK . '/config', 0777, true);
@mkdir($WORK . '/plugindata', 0777, true);
$settings = ['mediaDirectory' => $WORK, 'configDirectory' => $WORK . '/config'];
$GLOBALS['settings'] = $settings;

function ReadSettingFromFile($n, $p = '') {
    $f = $GLOBALS['settings']['configDirectory'] . '/plugin.' . $p;
    if (!is_readable($f)) return '';
    foreach (file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $l)
        if (preg_match('/^' . preg_quote($n, '/') . '\s*=\s*"?(.*?)"?$/', $l, $m)) return $m[1];
    return '';
}
function WriteSettingToFile($n, $v, $p = '') {
    $f = $GLOBALS['settings']['configDirectory'] . '/plugin.' . $p;
    $lines = is_readable($f) ? file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : [];
    $out = []; $done = false;
    foreach ($lines as $l) {
        if (preg_match('/^' . preg_quote($n, '/') . '\s*=/', $l)) { $out[] = "$n = \"$v\""; $done = true; }
        else { $out[] = $l; }
    }
    if (!$done) $out[] = "$n = \"$v\"";
    file_put_contents($f, implode("\n", $out) . "\n");
}

require $ROOT . '/lib/XmodelParser.php';
require $ROOT . '/lib/FixtureStore.php';

if ($argc < 2) {
    fwrite(STDERR, "usage: php harness/seed.php <file.xmodel|xlights_rgbeffects.xml> [controllerName] [baseChannel]\n");
    exit(1);
}
$src = $argv[1];
$r = XmodelParser::parse(file_get_contents($src));
$m = FixtureStore::merge($r['fixtures']);
printf("imported %s: %d new, %d updated\n", basename($src), $m['added'], $m['replaced']);
foreach ($r['errors'] as $e) echo "  ERR: $e\n";

// Optional: a controller base, so relative-addressed fixtures resolve. Find the
// real value on the emitting device with:
//   curl -s http://<device>/api/channel/output/co-other
if ($argc >= 4) {
    FixtureStore::setBase($argv[2], (int) $argv[3]);
    printf("base for %s set to %d\n", $argv[2], (int) $argv[3]);
}
foreach (FixtureStore::fixtures() as $f) {
    printf("  %-8s %2d ch  -> %s\n", $f['name'], $f['channelCount'],
        FixtureStore::absoluteStart($f) ?? 'unresolved');
}
