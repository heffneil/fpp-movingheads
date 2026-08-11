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

if (str_starts_with($uri, '/api/')) {
    file_put_contents($LOG, $_SERVER['REQUEST_METHOD'] . ' ' . $_SERVER['REQUEST_URI'] . "\n", FILE_APPEND);
    header('Content-Type: application/json');
    echo json_encode(['Status' => 'OK', 'Message' => '']);
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
echo "<title>MHT plugin preview</title>";
echo "<style>body{font:14px system-ui;margin:18px;background:#15161a;color:#e7e8ea}";
echo "input,select,button{font:inherit}.alert{padding:7px 10px;border-radius:6px;margin:6px 0}";
echo ".alert-info{background:#1d3a52}.alert-danger{background:#4a2020}";
echo "h2,h3{font-weight:500}code,pre{font-family:ui-monospace,Menlo,monospace}</style>";

// status.php inlines the plugin's own assets from assets/, so nothing to add
// here - plugin.php only auto-includes js/ and css/, which this plugin does not use.

echo "</head><body>";
include $ROOT . '/status.php';
echo "</body></html>";
