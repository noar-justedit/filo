#!/bin/bash
#
# filo — FTP, FTPS and SFTP client
# Copyright (C) 2026 Just Edit (Arnaud Augst)
# Licensed under the GNU General Public License v3.0 or later. See LICENSE.
#
# Build filo for Linux: an AppImage and a .deb (x64), in dist/.
# Run it ON a Linux machine (Ubuntu, Debian, Pop!_OS…), as your own user,
# never with sudo:
#     ./build_linux.sh
# Everything is done by scripts/build-linux.sh, which checks Node.js, the
# packaging tools and the icons first and says what to install if one is
# missing.
exec bash "$(dirname "${BASH_SOURCE[0]}")/scripts/build-linux.sh" "$@"
