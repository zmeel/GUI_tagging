package AutotagGUI::Autoflush;

# Loaded into autotag.pl (perl -MAutotagGUI::Autoflush autotag.pl ...) so its
# output reaches the job log line by line instead of in large buffered blocks.

use strict;
use warnings;
use IO::Handle;

STDOUT->autoflush(1);
STDERR->autoflush(1);

1;
