<?php

# Menu entries for fpp-movingheads.
#
# PLUGIN_GUIDELINES.md #9.1 allows at most one entry per menu area, so the
# tool lives under 'status' (beside FPP's own Display Testing, which is also
# a status-area page) and everything explanatory folds into the single 'help'
# entry rather than adding pages here.

$menuEntries = Array(
	Array(
		'text' => 'Moving Head Test',
		'type' => 'status',
		'page' => 'status.php',
		'wrap' => 1
	),
	Array(
		'text' => 'Moving Head Test - Help',
		'type' => 'help',
		'page' => 'about.php',
		'wrap' => 1
	)
);
