#!/bin/bash
set -e

# fpp-movingheads uninstall script

. ${FPPDIR}/scripts/common

# Release any overlay range this plugin may still be holding.
#
# Overlay ranges live in fppd until deleted, so uninstalling while a fixture is
# still "in control" would leave it frozen at its last values with no UI left to
# release it. We delete only OUR fixtures' channels, one range per channel, for
# two reasons:
#
#   * {"deleteAll":true} would also drop ranges belonging to anything else
#     using the same API, which is not ours to do.
#   * fppd matches a range on its exact start and end. A delete that matches
#     nothing pushes OverlayRange(start, end, -1), and that -1 lands in a
#     uint8_t channel buffer as 255 - so a sloppy delete drives channels to
#     full rather than releasing them. Deleting exactly what was created
#     avoids that entirely.

DATADIR="${MEDIADIR}/plugindata/fpp-movingheads"
FIXTURES="${DATADIR}/fixtures.json"
PLUGINCFG="${MEDIADIR}/config/plugin.fpp-movingheads"

if [ -r "${FIXTURES}" ]; then
    RANGES=$(php -r '
        $fx = json_decode(@file_get_contents($argv[1]), true);
        if (!is_array($fx)) { exit; }
        $bases = [];
        if (is_readable($argv[2])) {
            $cfg = file_get_contents($argv[2]);
            if (preg_match("/^controllerBases\s*=\s*\"?(.*?)\"?\s*$/m", $cfg, $m)) {
                $j = json_decode(stripslashes($m[1]), true);
                if (is_array($j)) { $bases = $j; }
            }
        }
        $out = [];
        foreach ($fx as $f) {
            $n = (int)($f["channelCount"] ?? 0);
            if ($n <= 0) { continue; }
            $abs = 0;
            if (!empty($f["override"]))                        { $abs = (int)$f["override"]; }
            elseif (($f["start"]["mode"] ?? "") === "absolute") { $abs = (int)($f["start"]["absolute"] ?? 0); }
            elseif (($f["start"]["mode"] ?? "") === "relative") {
                $c = $f["start"]["controller"] ?? "";
                if (!empty($bases[$c])) { $abs = (int)$bases[$c] + (int)$f["start"]["offset"] - 1; }
            }
            if ($abs <= 0) { continue; }
            for ($i = 0; $i < $n; $i++) { $ch = $abs + $i; $out[] = "$ch-$ch"; }
        }
        echo implode(",", array_unique($out));
    ' "${FIXTURES}" "${PLUGINCFG}" 2>/dev/null || true)

    if [ -n "${RANGES}" ]; then
        curl -s -X PUT -H 'Content-Type: application/json' -d '{}' \
             "http://localhost/api/overlays/range/${RANGES}/delete" >/dev/null 2>&1 || true
        echo "Released overlay ranges for known fixtures."
    fi
fi

# Imported fixtures are user data and are left in place, so reinstalling does
# not lose them. To wipe them:
#   rm -rf ${MEDIADIR}/plugindata/fpp-movingheads

echo "fpp-movingheads uninstalled."
