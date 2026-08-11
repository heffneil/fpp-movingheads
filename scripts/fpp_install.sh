#!/bin/bash
set -e

# fpp-plugin-MovingHeadTest install script

. ${FPPDIR}/scripts/common

# Data directory for imported fixture descriptors. Guideline #5 confines a
# plugin to its own directory, its log, config/plugin.<repoName>, and
# <mediadir>/plugindata/ - this is the last of those.
DATADIR="${MEDIADIR}/plugindata/fpp-plugin-MovingHeadTest"
mkdir -p "${DATADIR}"
chown ${FPPUSER}:${FPPUSER} "${DATADIR}" 2>/dev/null || true

# No commands/descriptions.json and no native binary, so fppd does not need a
# restart: the pages are plain PHP and the runtime talks to FPP's existing
# overlay API. Deliberately not setting restartFlag.

echo "fpp-plugin-MovingHeadTest installed. Status/Control -> Moving Head Test"
