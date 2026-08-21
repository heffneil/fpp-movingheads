<?php
/**
 * Off-device preview harness for the plugin page.
 *
 * Stands in for FPP: provides $settings and the two setting helpers the plugin
 * uses, wraps status.php the way plugin.php would, and mocks the overlay API so
 * every request the client makes is recorded. Lets the whole client path -
 * descriptor to control surface to exact request URLs - be verified without a
 * device.
 *
 * Run from the plugin root:
 *   php -S 127.0.0.1:8145 -t harness harness/plugin-preview.php
 */

$ROOT = dirname(__DIR__);
// Fixed, not sys_get_temp_dir(): macOS hands back a per-user /var/folders path,
// so a seeding script and the server would silently use different directories.
$WORK = $ROOT . '/harness/.preview-media';
@mkdir($WORK . '/config', 0777, true);
@mkdir($WORK . '/plugindata', 0777, true);

$LOG = $WORK . '/requests.log';

// ---- stand in for FPP ------------------------------------------------------
$settings = [
    'mediaDirectory' => $WORK,
    'configDirectory' => $WORK . '/config',
    'logDirectory' => $WORK,
];

function ReadSettingFromFile($name, $plugin = '')
{
    global $settings;
    $f = $settings['configDirectory'] . '/plugin.' . $plugin;
    if (!is_readable($f)) {
        return '';
    }
    foreach (file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if (preg_match('/^' . preg_quote($name, '/') . '\s*=\s*"?(.*?)"?$/', $line, $m)) {
            return $m[1];
        }
    }
    return '';
}

function WriteSettingToFile($name, $value, $plugin = '')
{
    global $settings;
    $f = $settings['configDirectory'] . '/plugin.' . $plugin;
    $lines = is_readable($f) ? file($f, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : [];
    $out = [];
    $done = false;
    foreach ($lines as $line) {
        if (preg_match('/^' . preg_quote($name, '/') . '\s*=/', $line)) {
            $out[] = $name . ' = "' . $value . '"';
            $done = true;
        } else {
            $out[] = $line;
        }
    }
    if (!$done) {
        $out[] = $name . ' = "' . $value . '"';
    }
    file_put_contents($f, implode("\n", $out) . "\n");
}

// ---- mock the overlay API -------------------------------------------------
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// Stand in for /api/system/info so the "not driveable from this device" path is
// testable off-device. Without channelRanges, LocalOutputs treats the ranges as
// unknown and every fixture reads as driveable - which hides a whole class of
// state, including the one where the tool DOM is absent.
if ($uri === '/api/system/info') {
    header('Content-Type: application/json');
    $ranges = getenv('MHT_FAKE_RANGES');
    echo json_encode([
        'HostName' => 'harness',
        'channelRanges' => $ranges !== false ? $ranges : '109432-109447',
    ]);
    exit;
}

// Stand in for the channel-output endpoint the base derivation reads.
//
// Its canned response lives in .preview-media/dmx-outputs.json - the harness's
// own fixture data, deliberately NOT named after FPP's config file. The plugin
// reads this only through the API, per guideline 3.4, and nothing in the repo
// should even look like it opens FPP's internals.
if ($uri === '/api/channel/output/co-other') {
    header('Content-Type: application/json');
    $f = $WORK . '/dmx-outputs.json';
    echo is_readable($f) ? (string) file_get_contents($f) : json_encode(['channelOutputs' => []]);
    exit;
}

if (str_starts_with($uri, '/api/')) {
    file_put_contents($LOG, $_SERVER['REQUEST_METHOD'] . ' ' . $_SERVER['REQUEST_URI'] . "\n", FILE_APPEND);
    header('Content-Type: application/json');
    echo json_encode(['Status' => 'OK', 'Message' => '']);
    exit;
}

if ($uri === '/bootstrap.css') {
    if (is_readable($WORK . '/bootstrap.min.css')) {
        header('Content-Type: text/css');
        readfile($WORK . '/bootstrap.min.css');
    } else {
        http_response_code(404);
    }
    exit;
}
if ($uri === '/requests') {
    header('Content-Type: text/plain');
    readfile($LOG);
    exit;
}
if ($uri === '/reset') {
    @unlink($LOG);
    header('Content-Type: text/plain');
    echo "cleared\n";
    exit;
}

// ---- wrap the page the way plugin.php does --------------------------------
echo "<!DOCTYPE html><html><head><meta charset='utf-8'>";
// FPP's real pages carry this; without it a narrow window still lays out at ~980px
// and every responsive check silently passes.
echo "<meta name='viewport' content='width=device-width, initial-scale=1'>";
echo "<title>MHT plugin preview</title>";
// Real Bootstrap, because FPP serves it and the plugin's CSS depends on its theme
// variables and .table-responsive. Without it this harness silently tested only
// the var() fallbacks, and every responsive check passed by default because
// .table-responsive had no styles at all.
//
// Served from a local cache, never fetched from a CDN by this file. The plugin
// must not depend on an external CDN - a show network is frequently offline, and
// the plugin check rightly flags any CDN reference in shipped code. The one-time
// download command is in harness/README.md, and the cache lives under
// .preview-media/ which is gitignored, so nothing is committed or installed.
// MHT_THEME=light|dark picks the theme; default dark. MHT_NO_BOOTSTRAP=1 skips it
// to test the fallback colors deliberately.
$theme = getenv('MHT_THEME') ?: 'dark';
$bsCache = $WORK . '/bootstrap.min.css';
$useBs = getenv('MHT_NO_BOOTSTRAP') !== '1' && is_readable($bsCache);
if ($useBs) {
    echo "<link rel='stylesheet' href='/bootstrap.css'>";
    echo "<script>document.documentElement.setAttribute('data-bs-theme','" . htmlspecialchars($theme) . "');</script>";
}
echo "<style>body{font:14px system-ui;margin:18px}";
echo "input,select,button{font:inherit}.alert{padding:7px 10px;border-radius:6px;margin:6px 0}";
echo ".alert-info{background:var(--bs-info-bg-subtle)}.alert-danger{background:var(--bs-danger-bg-subtle)}";
echo "h2,h3{font-weight:500}code,pre{font-family:ui-monospace,Menlo,monospace}</style>";

// status.php inlines the plugin's own assets from assets/, so nothing to add
// here - plugin.php only auto-includes js/ and css/, which this plugin does not use.

echo "</head><body>";
if (!$useBs && getenv('MHT_NO_BOOTSTRAP') !== '1') {
    echo "<div class='alert alert-danger'>No cached Bootstrap, so this page is "
       . "rendering with the plugin's fallback colors only - theme and "
       . "<code>.table-responsive</code> behaviour are NOT being tested. "
       . "See <code>harness/README.md</code> for the one-line fetch.</div>";
}
include $ROOT . '/status.php';
echo "</body></html>";
