<?php
/**
 * fpp-movingheads - Status/Control page.
 *
 * Included by FPP's plugin.php inside the usual header/menu/footer, so
 * $settings and the FPP setting helpers are already available and this file
 * must not emit <html> or <head>.
 *
 * Assets live in assets/ and are inlined here, deliberately NOT in js/ and
 * css/. plugin.php auto-includes everything in those two directories, but it
 * serves them as:
 *
 *     plugin.php?plugin=<repoName>&file=js/<name>&nopage=1
 *
 * with "Cache-Control: max-age=31536000, immutable" and no version parameter -
 * while FPP busts cache on its own assets with ?ref=<filemtime>. A browser that
 * has loaded the page once will therefore never pick up a change to the runtime,
 * and "immutable" means it will not even revalidate. Naming the directory
 * something plugin.php does not scan, and inlining, means an update always takes
 * effect. It also avoids loading the runtime twice, which would give every
 * control two listeners and two conflicting state closures.
 */

require_once __DIR__ . '/lib/XmodelParser.php';
require_once __DIR__ . '/lib/FixtureStore.php';

$notices = [];
$problems = [];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['mhtAction'] ?? '';

    if ($action === 'import' && isset($_FILES['mhtFile'])) {
        $up = $_FILES['mhtFile'];
        if (($up['error'] ?? 1) !== UPLOAD_ERR_OK) {
            $problems[] = 'Upload failed (error code ' . (int) ($up['error'] ?? -1) . ').';
        } elseif (($up['size'] ?? 0) > 40 * 1024 * 1024) {
            $problems[] = 'That file is over 40 MB; refusing to parse it.';
        } else {
            $xml = (string) file_get_contents($up['tmp_name']);
            $res = XmodelParser::parse($xml);
            foreach ($res['errors'] as $e) {
                $problems[] = $e;
            }
            if ($res['fixtures']) {
                $r = FixtureStore::merge($res['fixtures']);
                $notices[] = sprintf('Imported %s: %d new, %d updated.',
                    htmlspecialchars($up['name']), $r['added'], $r['replaced']);
            }
        }
    } elseif ($action === 'base') {
        $c = trim((string) ($_POST['controller'] ?? ''));
        $b = (int) ($_POST['baseChannel'] ?? 0);
        if ($c !== '' && $b > 0) {
            FixtureStore::setBase($c, $b);
            $notices[] = 'Base channel for ' . htmlspecialchars($c) . ' set to ' . $b . '.';
        } else {
            $problems[] = 'A base channel must be 1 or greater.';
        }
    } elseif ($action === 'override') {
        $n = (string) ($_POST['fixture'] ?? '');
        $v = trim((string) ($_POST['absolute'] ?? ''));
        FixtureStore::setOverride($n, $v === '' ? null : max(1, (int) $v));
        $notices[] = 'Override updated for ' . htmlspecialchars($n) . '.';
    } elseif ($action === 'remove') {
        $n = (string) ($_POST['fixture'] ?? '');
        FixtureStore::remove($n);
        $notices[] = 'Removed ' . htmlspecialchars($n) . '.';
    }
}

$bases = FixtureStore::bases();
$fixtures = FixtureStore::fixtures();

// Resolve each fixture's absolute start once, here, so the client never has to
// know about controller bases or the two StartChannel forms.
$resolved = [];
foreach ($fixtures as $f) {
    $f['absoluteStart'] = FixtureStore::absoluteStart($f, $bases);
    $resolved[] = $f;
}
usort($resolved, function ($a, $b) {
    return strnatcasecmp($a['name'], $b['name']);
});
$ready = array_values(array_filter($resolved, function ($f) {
    return !empty($f['absoluteStart']);
}));
$unresolved = array_values(array_filter($resolved, function ($f) {
    return empty($f['absoluteStart']);
}));
?>
<style><?php readfile(__DIR__ . '/assets/movingheadtest.css'); ?></style>

<div class="container-fluid">
  <h2>Moving Head Test</h2>

  <?php foreach ($notices as $n): ?>
    <div class="alert alert-info"><?php echo $n; ?></div>
  <?php endforeach; ?>
  <?php foreach ($problems as $p): ?>
    <div class="alert alert-danger"><?php echo htmlspecialchars($p); ?></div>
  <?php endforeach; ?>

  <fieldset class="mhtFieldset">
    <legend>import fixtures</legend>
    <form method="post" enctype="multipart/form-data" class="mhtImport">
      <input type="hidden" name="mhtAction" value="import">
      <input type="file" name="mhtFile" accept=".xmodel,.xml" required>
      <button type="submit" class="buttons">Import</button>
      <span class="mhtNote">an exported <code>.xmodel</code>, or a whole
        <code>xlights_rgbeffects.xml</code> to pick up every DMX fixture at once</span>
    </form>
  </fieldset>

  <?php if ($unresolved): ?>
    <fieldset class="mhtFieldset">
      <legend>needs an address</legend>
      <p class="mhtNote">
        These fixtures use a controller-relative <code>StartChannel</code> and no base is set
        for their controller yet. A relative address cannot be resolved from the model file
        alone &mdash; the absolute origin lives in the channel-output configuration of the FPP
        instance that actually emits the channels. On that machine,
        <code>Input/Output Setup &rarr; Other</code> shows the DMX output's start channel.
      </p>
      <table class="mhtTable">
        <tr><th>fixture</th><th>controller</th><th>offset</th><th>base</th></tr>
        <?php foreach ($unresolved as $f): ?>
          <tr>
            <td><?php echo htmlspecialchars($f['name']); ?></td>
            <td><?php echo htmlspecialchars($f['start']['controller'] ?? '(unknown form)'); ?></td>
            <td><?php echo (int) ($f['start']['offset'] ?? 0); ?></td>
            <td>
              <?php if (($f['start']['mode'] ?? '') === 'relative'): ?>
                <form method="post" style="display:inline-flex;gap:6px">
                  <input type="hidden" name="mhtAction" value="base">
                  <input type="hidden" name="controller"
                         value="<?php echo htmlspecialchars($f['start']['controller']); ?>">
                  <input type="number" name="baseChannel" min="1" step="1" value="1" style="width:110px" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
                  <button type="submit" class="buttons">Set</button>
                </form>
              <?php else: ?>
                <form method="post" style="display:inline-flex;gap:6px">
                  <input type="hidden" name="mhtAction" value="override">
                  <input type="hidden" name="fixture" value="<?php echo htmlspecialchars($f['name']); ?>">
                  <input type="number" name="absolute" min="1" step="1" placeholder="absolute" style="width:110px" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
                  <button type="submit" class="buttons">Set</button>
                </form>
              <?php endif; ?>
            </td>
          </tr>
        <?php endforeach; ?>
      </table>
    </fieldset>
  <?php endif; ?>

  <?php if (!$ready): ?>
    <p class="mhtNote">No fixture has a resolved absolute channel yet. Import a model above.</p>
  <?php else: ?>

  <div class="mhtBar">
    <label for="mhtFixture" style="margin:0">Fixture</label>
    <select id="mhtFixture">
      <?php foreach ($ready as $f): ?>
        <option value="<?php echo htmlspecialchars($f['name']); ?>">
          <?php echo htmlspecialchars($f['name'] . '  (' . $f['channelCount'] . ' ch)'); ?>
        </option>
      <?php endforeach; ?>
    </select>
    <span class="mhtNote">channels <span id="mhtRange">&mdash;</span></span>
    <span class="mhtGrow"></span>
    <span id="mhtState" class="mhtPill mhtOff">released</span>
    <button type="button" id="mhtTake" class="buttons">Take control</button>
    <button type="button" id="mhtRelease" class="buttons">Release</button>
  </div>

  <div class="mhtStage">
    <div id="mhtMask" class="mhtMask">
      <div class="mhtMaskInner">
        <button type="button" id="mhtMaskBtn" class="buttons">Take control</button>
        <div class="mhtMaskNote">nothing is sent to the fixture until you do</div>
      </div>
    </div>
  <div class="mhtWrap">
    <div id="mhtRadarWrap">
      <svg id="mhtRadar" class="mhtRadar" viewBox="0 0 300 300" width="300" height="300">
        <circle class="mhtRadarBg" cx="150" cy="150" r="144"/>
        <circle class="mhtRadarRing" cx="150" cy="150" r="108"/>
        <circle class="mhtRadarRing" cx="150" cy="150" r="72"/>
        <circle class="mhtRadarRing" cx="150" cy="150" r="36"/>
        <line class="mhtRadarAxis" x1="150" y1="6" x2="150" y2="294"/>
        <line class="mhtRadarAxis" x1="6" y1="150" x2="294" y2="150"/>
        <text class="mhtRadarTick" x="150" y="20" text-anchor="middle">tilt +</text>
        <text class="mhtRadarTick" x="150" y="288" text-anchor="middle">tilt &minus;</text>
        <text class="mhtRadarTick" x="276" y="146" text-anchor="middle">pan +</text>
        <text class="mhtRadarTick" x="26" y="146" text-anchor="middle">pan &minus;</text>
        <line class="mhtRay" id="mhtRay" x1="150" y1="150" x2="150" y2="150"/>
        <circle class="mhtDot" id="mhtDot" cx="150" cy="150" r="7"/>
      </svg>
      <div class="mhtRow" style="margin-top:8px">
        <button type="button" id="mhtCenter" class="buttons">Center</button>
        <button type="button" id="mhtBlackout" class="buttons" title="Dimmer and shutter to 0. Works even when not in control. Does not touch a lamp-control channel.">Blackout</button>
        <label style="min-width:auto;display:inline-flex;align-items:center;gap:5px">
          <input type="checkbox" id="mhtPolar"> polar
        </label>
      </div>
    </div>

    <div class="mhtCol">
      <div class="mhtReadout">
        <div id="mhtPanWrap">
          <div class="mhtK">Pan</div>
          <div class="mhtBigWrap">
            <input type="number" class="mhtBig" id="mhtPanDeg" step="1" value="0" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"><span class="mhtDeg">&deg;</span>
          </div>
          <div class="mhtRaw" id="mhtPanRaw">&mdash;</div>
        </div>
        <div id="mhtTiltWrap">
          <div class="mhtK">Tilt</div>
          <div class="mhtBigWrap">
            <input type="number" class="mhtBig" id="mhtTiltDeg" step="1" value="0" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"><span class="mhtDeg">&deg;</span>
          </div>
          <div class="mhtRaw" id="mhtTiltRaw">&mdash;</div>
        </div>
      </div>

      <fieldset class="mhtFieldset">
        <legend>declared by the model</legend>
        <div id="mhtSemantic"></div>
      </fieldset>

      <fieldset class="mhtFieldset">
        <legend>raw channels</legend>
        <div id="mhtRaw"></div>
      </fieldset>

      <fieldset class="mhtFieldset" id="mhtZoneWrap">
        <legend>position zones</legend>
        <label style="display:flex;align-items:center;gap:7px;font-size:13px">
          <input type="checkbox" id="mhtHonor" checked> honor this model's PositionZone rules
        </label>
        <div class="mhtNote" id="mhtZoneDesc"></div>
        <div id="mhtZoneState" class="mhtZoneOff">not in a zone</div>
      </fieldset>
    </div>
  </div>

  </div><!-- /mhtStage -->

  <fieldset class="mhtFieldset">
    <legend>requests</legend>
    <pre id="mhtLog">idle</pre>
  </fieldset>

  <fieldset class="mhtFieldset">
    <legend>registered fixtures</legend>
    <table class="mhtTable">
      <tr><th>fixture</th><th>type</th><th>ch</th><th>absolute</th><th>source</th><th></th></tr>
      <?php foreach ($resolved as $f): ?>
        <tr>
          <td><?php echo htmlspecialchars($f['name']); ?></td>
          <td><?php echo htmlspecialchars($f['type']); ?></td>
          <td><?php echo (int) $f['channelCount']; ?></td>
          <td><?php echo $f['absoluteStart'] ? (int) $f['absoluteStart'] : '<span class="mhtWarn">unresolved</span>'; ?></td>
          <td class="mhtNote">
            <?php
            if (isset($f['override'])) {
                echo 'manual override';
            } elseif (($f['start']['mode'] ?? '') === 'absolute') {
                echo 'absolute in model';
            } elseif (($f['start']['mode'] ?? '') === 'relative') {
                echo htmlspecialchars($f['start']['controller']) . ' + ' . (int) $f['start']['offset'];
            } else {
                echo 'unknown';
            }
            ?>
          </td>
          <td>
            <form method="post" onsubmit="return confirm('Remove <?php echo htmlspecialchars($f['name']); ?>?')">
              <input type="hidden" name="mhtAction" value="remove">
              <input type="hidden" name="fixture" value="<?php echo htmlspecialchars($f['name']); ?>">
              <button type="submit" class="buttons">Remove</button>
            </form>
          </td>
        </tr>
      <?php endforeach; ?>
    </table>
  </fieldset>

  <script>window.MHT_FIXTURES = <?php echo json_encode($ready, JSON_UNESCAPED_SLASHES); ?>;</script>
  <script><?php readfile(__DIR__ . '/assets/movingheadtest.js'); ?></script>
  <?php endif; ?>
</div>
