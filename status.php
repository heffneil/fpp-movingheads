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
require_once __DIR__ . '/lib/LocalOutputs.php';

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
    } elseif ($action === 'lamp') {
        $n = (string) ($_POST['fixture'] ?? '');
        $ch = trim((string) ($_POST['lampChannel'] ?? ''));
        $onRaw = trim((string) ($_POST['lampOn'] ?? ''));
        $offRaw = trim((string) ($_POST['lampOff'] ?? ''));
        $lampFailed = false;
        // A blank channel means "no lamp control", which is a legitimate thing to
        // want - but only when the values are blank too. Values with no channel is
        // someone filling the row in and missing a box, and silently storing
        // "no lamp" while reporting success is how that goes unnoticed.
        if ($ch === '' && ($onRaw !== '' || $offRaw !== '')) {
            $problems[] = 'Lamp not saved for ' . htmlspecialchars($n)
                . ': a channel number is required. Clear the On and Off values too if you '
                . 'meant to remove lamp control.';
            $lampFailed = true;
        } elseif ($ch !== '' && $onRaw === '' && $offRaw === '') {
            $problems[] = 'Lamp not saved for ' . htmlspecialchars($n)
                . ': channel ' . (int) $ch . ' needs both an On and an Off value.';
            $lampFailed = true;
        }
        if (!$lampFailed) {
            FixtureStore::setLamp(
                $n,
                $ch === '' ? null : (int) $ch,
                (int) ($_POST['lampOn'] ?? 0),
                (int) ($_POST['lampOff'] ?? 0),
                isset($_POST['lampCooldown']) ? (int) $_POST['lampCooldown'] : null
            );
            $notices[] = $ch === ''
                ? 'Lamp control cleared for ' . htmlspecialchars($n) . '.'
                : 'Lamp control for ' . htmlspecialchars($n) . ' set to channel ' . (int) $ch . '.';
        }
    } elseif ($action === 'lampoff') {
        // Client tells us the lamp was just doused so the restrike cooldown is
        // recorded server-side and survives a reload or a different browser.
        FixtureStore::markLampOff((string) ($_POST['fixture'] ?? ''));
        $silent = true;
    } elseif ($action === 'remove') {
        $n = (string) ($_POST['fixture'] ?? '');
        FixtureStore::remove($n);
        $notices[] = 'Removed ' . htmlspecialchars($n) . '.';
    }
}

// The lamp form saves through fetch() so it does not reload the page and drop
// control. That only works honestly if the reply says whether the save actually
// happened - otherwise a rejected save still logs "saved".
//
// Emitted as a comment marker inside the page rather than as a JSON response:
// this file is included by plugin.php well after FPP has sent its own page shell,
// so headers are long gone and a Content-Type of application/json is not
// available. The client pulls the marker out of the text it gets back.
if (!empty($_POST['mhtAjax'])) {
    echo "\n<!--MHT-RESULT:" . json_encode([
        'ok' => empty($problems),
        'problems' => array_map('html_entity_decode', $problems),
        'notices' => array_map('html_entity_decode', $notices),
    ]) . "-->\n";
    return;
}

$bases = FixtureStore::bases();
$fixtures = FixtureStore::fixtures();

// Resolve each fixture's absolute start once, here, so the client never has to
// know about controller bases or the two StartChannel forms.
$resolved = [];
foreach ($fixtures as $f) {
    $f['absoluteStart'] = FixtureStore::absoluteStart($f, $bases);
    // null means we could not ask this instance; that is not a fault, so the UI
    // stays quiet rather than crying wolf.
    $f['cooldownRemaining'] = FixtureStore::cooldownRemaining($f);
    $f['emittedHere'] = $f['absoluteStart']
        ? LocalOutputs::covers((int) $f['absoluteStart'], (int) $f['channelCount'])
        : null;
    $resolved[] = $f;
}
usort($resolved, function ($a, $b) {
    return strnatcasecmp($a['name'], $b['name']);
});
$ready = array_values(array_filter($resolved, function ($f) {
    // A fixture outside this instance's output ranges accepts every write and
    // does nothing, so it must not be selectable - that silence is impossible
    // to tell from a wiring fault.
    return !empty($f['absoluteStart']) && $f['emittedHere'] !== false;
}));
$notEmitted = array_values(array_filter($resolved, function ($f) {
    return !empty($f['absoluteStart']) && $f['emittedHere'] === false;
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
    <legend>Import Fixtures</legend>
    <form method="post" enctype="multipart/form-data" class="mhtImport">
      <input type="hidden" name="mhtAction" value="import">
      <input type="file" name="mhtFile" accept=".xmodel,.xml" required>
      <button type="submit" class="buttons">Import</button>
      <span class="mhtNote">An exported <code>.xmodel</code>, or a whole
        <code>xlights_rgbeffects.xml</code> to pick up every DMX fixture at once</span>
    </form>
  </fieldset>

  <?php if ($unresolved): ?>
    <fieldset class="mhtFieldset">
      <legend>Needs an Address</legend>
      <p class="mhtNote">
        These fixtures use a controller-relative <code>StartChannel</code> and no base is set
        for their controller yet. A relative address cannot be resolved from the model file
        alone &mdash; the absolute origin lives in the channel-output configuration of the FPP
        instance that actually emits the channels. On that machine,
        <code>Input/Output Setup &rarr; Other</code> shows the DMX output's start channel.
      </p>
      <table class="mhtTable">
        <tr><th>Fixture</th><th>Controller</th><th>Offset</th><th>Base</th></tr>
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

  <?php if ($notEmitted): ?>
    <fieldset class="mhtFieldset">
      <legend>Not Driveable From This Device</legend>
      <p class="mhtNote">
        These fixtures have a valid absolute address, but it falls outside the channels this
        FPP instance actually puts on the wire (<?php echo htmlspecialchars(LocalOutputs::describe()); ?>).
        Writes to them would be accepted and silently do nothing, so they are not offered for
        control. Drive them from the instance that emits their channels, or correct the address.
      </p>
      <table class="mhtTable">
        <tr><th>Fixture</th><th>Channels</th><th>Ch</th></tr>
        <?php foreach ($notEmitted as $f): ?>
          <tr>
            <td><?php echo htmlspecialchars($f['name']); ?></td>
            <td class="mhtWarn"><?php echo (int) $f['absoluteStart']; ?>&ndash;<?php
                echo (int) $f['absoluteStart'] + (int) $f['channelCount'] - 1; ?></td>
            <td><?php echo (int) $f['channelCount']; ?></td>
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
    <span class="mhtNote">Channels <span id="mhtRange">&mdash;</span></span>
    <span class="mhtGrow"></span>
    <span id="mhtState" class="mhtPill mhtOff">Released</span>
    <button type="button" id="mhtTake" class="buttons">Take control</button>
    <button type="button" id="mhtRelease" class="buttons">Release</button>
  </div>

  <div class="mhtStage">
    <div id="mhtMask" class="mhtMask">
      <div class="mhtMaskInner">
        <button type="button" id="mhtMaskBtn" class="buttons">Take control</button>
        <div class="mhtMaskNote">Nothing is sent to the fixture until you do</div>
      </div>
    </div>
  <div class="mhtWrap">
    <div id="mhtRadarWrap">
      <!-- Built entirely in JS: the grid extent and cell count come from the
           selected fixture's own pan/tilt range of motion, so a fixture with a
           different range gets a correctly proportioned grid rather than one
           hardcoded to 8x8. -->
      <svg id="mhtRadar" class="mhtRadar" viewBox="0 0 320 240"></svg>
      <!-- Outside the SVG so it can wrap: on a fixture with a narrow reachable
           pan span the pad is only a few blocks wide and this text does not fit
           across it. -->
      <div class="mhtNote mhtPadCaption" id="mhtPadCaption"></div>
      <div class="mhtRow" style="margin-top:8px">
        <button type="button" id="mhtCenter" class="buttons">Center</button>
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
        <legend>Quick Commands</legend>
        <div class="mhtQuick" id="mhtQuick">
          <button type="button" id="mhtLampOn" class="buttons"
                  title="Writes the lamp channel's configured On value.">Lamp On</button>
          <button type="button" id="mhtLampOff" class="buttons"
                  title="Writes the lamp channel's configured Off value.">Lamp Off</button>
        </div>
        <div class="mhtNote" id="mhtLampNote"></div>
        <div class="mhtLampWarn">
          Do not cycle the lamp repeatedly. After a Lamp Off the lamp must cool before it will
          strike again &mdash; forcing an early restrike shortens lamp life or simply fails.
          Lamp On is held until the
          <a href="#mhtLampControl" class="mhtJumpLamp">cooldown</a> has elapsed.
        </div>
        <div class="mhtCooldown" id="mhtCooldown" hidden></div>
      </fieldset>

      <fieldset class="mhtFieldset">
        <legend>Declared by the Model</legend>
        <div id="mhtSemantic"></div>
      </fieldset>

      <fieldset class="mhtFieldset">
        <legend>Raw Channels</legend>
        <div id="mhtRaw"></div>
      </fieldset>

      <fieldset class="mhtFieldset" id="mhtZoneWrap">
        <legend>Position Zones</legend>
        <label style="display:flex;align-items:center;gap:7px;font-size:13px">
          <input type="checkbox" id="mhtHonor" checked> Honor this model's PositionZone rules
        </label>
        <div class="mhtNote" id="mhtZoneDesc"></div>
        <div id="mhtZoneState" class="mhtZoneOff">not in a zone</div>
      </fieldset>
    </div>
  </div>

  </div><!-- /mhtStage -->

  <fieldset class="mhtFieldset">
    <legend>Requests</legend>
    <pre id="mhtLog">Idle</pre>
  </fieldset>

  <?php endif; ?>

  <fieldset class="mhtFieldset" id="mhtLampControl" tabindex="-1">
    <legend>Lamp Control</legend>
    <p class="mhtNote">
      Which channel strikes and douses the lamp, and the two values that do it. Not in the
      model &mdash; xLights holds one fixed value per channel, not a selectable pair &mdash; and
      the values are fixture-specific, so they are entered here. Leave the channel blank to
      remove the Lamp buttons &mdash; clear the values with it. Check your fixture's DMX chart
      before setting these: striking a lamp takes time to restrike and costs lamp life, which is
      what the cooldown enforces.
    </p>
    <?php foreach ($resolved as $f):
        $lamp = $f['lamp'] ?? null;
        // The channel number IS in the model - xLights labels it in NodeNames -
        // so it is offered rather than left for you to find in the raw list. Only
        // the values are genuinely fixture-specific.
        // labels is keyed by channel number, 1..N - not 0-based.
        $guess = 0;
        $guessLabel = '';
        foreach (($f['labels'] ?? []) as $ch1 => $label) {
            if (preg_match('/lamp/i', (string) $label)) {
                $guess = (int) $ch1;
                $guessLabel = (string) $label;
                break;
            }
        }
    ?>
      <form method="post" class="mhtLampRow" data-lamp-row="1">
        <input type="hidden" name="mhtAction" value="lamp">
        <input type="hidden" name="fixture" value="<?php echo htmlspecialchars($f['name']); ?>">
        <span class="mhtLampName"><?php echo htmlspecialchars($f['name']); ?></span>
        <label>Channel</label>
        <input type="number" name="lampChannel" min="1" max="<?php echo (int) $f['channelCount']; ?>"
               step="1" style="width:74px" placeholder="ch" required
               value="<?php echo $lamp ? (int) $lamp['channel'] : ($guess ?: ''); ?>"
               autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
        <label>On</label>
        <input type="number" name="lampOn" min="0" max="255" step="1" style="width:70px"
               value="<?php echo $lamp ? (int) $lamp['onValue'] : ''; ?>"
               autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
        <label>Off</label>
        <input type="number" name="lampOff" min="0" max="255" step="1" style="width:70px"
               value="<?php echo $lamp ? (int) $lamp['offValue'] : ''; ?>"
               autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
        <label title="Seconds the lamp must cool before it may be struck again. Set this from your fixture's manual.">Cooldown s</label>
        <input type="number" name="lampCooldown" min="0" max="3600" step="10" style="width:74px"
               value="<?php echo $lamp ? (int) ($lamp['cooldownSec'] ?? 300) : 300; ?>"
               autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
        <button type="submit" class="buttons">Save</button>
        <?php if (!$lamp && $guess): ?>
          <span class="mhtNote mhtLampHint">ch <?php echo $guess; ?> is labelled
            &ldquo;<?php echo htmlspecialchars($guessLabel); ?>&rdquo; in the model</span>
        <?php endif; ?>
        <span class="mhtNote mhtLampSaved" hidden>Saved</span>
      </form>
    <?php endforeach; ?>
  </fieldset>

  <fieldset class="mhtFieldset">
    <legend>Registered Fixtures</legend>
    <table class="mhtTable">
      <tr><th>Fixture</th><th>Type</th><th>Ch</th><th>Absolute</th><th>On the Wire</th><th>Source</th><th>Set Absolute</th><th></th></tr>
      <?php foreach ($resolved as $f): ?>
        <tr>
          <td><?php echo htmlspecialchars($f['name']); ?></td>
          <td><?php echo htmlspecialchars($f['type']); ?></td>
          <td><?php echo (int) $f['channelCount']; ?></td>
          <td><?php echo $f['absoluteStart'] ? (int) $f['absoluteStart'] : '<span class="mhtWarn">unresolved</span>'; ?></td>
          <td class="mhtNote">
            <?php
            if ($f['emittedHere'] === true) {
                echo 'yes';
            } elseif ($f['emittedHere'] === false) {
                echo '<span class="mhtWarn">not emitted here</span>';
            } else {
                echo '&mdash;';
            }
            ?>
          </td>
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
            <form method="post" style="display:inline-flex;gap:5px">
              <input type="hidden" name="mhtAction" value="override">
              <input type="hidden" name="fixture" value="<?php echo htmlspecialchars($f['name']); ?>">
              <input type="number" name="absolute" min="1" step="1" style="width:96px"
                     placeholder="derived"
                     value="<?php echo isset($f['override']) ? (int) $f['override'] : ''; ?>"
                     title="Overrides the address derived from the model. Blank uses the derived one."
                     autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other">
              <button type="submit" class="buttons">Save</button>
            </form>
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
</div>
