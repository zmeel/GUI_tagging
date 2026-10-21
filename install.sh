#!/bin/bash
#
# Installs the AutoTag GUI. Run as root from the repository folder:  sudo ./install.sh
#
#   /opt/autotag-gui/            helper and Perl module (root owned)
#   /etc/autotag-gui.conf        configuration (kept if it already exists)
#   /var/lib/autotag-gui/jobs/   job folders (owned by the BIGSdb user, readable by the web server)
#   /var/www/html/autotag/       web page and API
#   /etc/sudoers.d/autotag-gui   lets the web server run the helper as the BIGSdb user
#   /etc/apache2/conf-available/autotag-gui.conf
#
set -euo pipefail

RUN_AS=bigsdb
WEB_USER=www-data
APP_DIR=/opt/autotag-gui
WEB_DIR=/var/www/html/autotag
DATA_DIR=/var/lib/autotag-gui

cd "$(dirname "$0")"
if [ "$(id -u)" -ne 0 ]; then
	echo "Please run as root: sudo $0" >&2
	exit 1
fi
id "$RUN_AS" >/dev/null
id "$WEB_USER" >/dev/null

echo "Installing helper and library in $APP_DIR"
install -d -o root -g root -m 755 "$APP_DIR/bin" "$APP_DIR/lib/AutotagGUI"
install -o root -g root -m 755 bin/autotag-gui-helper "$APP_DIR/bin/"
install -o root -g root -m 644 lib/AutotagGUI.pm "$APP_DIR/lib/"
install -o root -g root -m 644 lib/AutotagGUI/Autoflush.pm "$APP_DIR/lib/AutotagGUI/"

if [ -e /etc/autotag-gui.conf ]; then
	echo "Keeping existing /etc/autotag-gui.conf"
else
	echo "Installing /etc/autotag-gui.conf"
	install -o root -g root -m 644 etc/autotag-gui.conf /etc/
fi

echo "Creating job folder $DATA_DIR/jobs"
install -d -o "$RUN_AS" -g "$WEB_USER" -m 2750 "$DATA_DIR" "$DATA_DIR/jobs"

echo "Installing web files in $WEB_DIR"
install -d -o root -g root -m 755 "$WEB_DIR"
install -o root -g root -m 644 web/index.html web/app.js web/style.css "$WEB_DIR/"
install -o root -g root -m 755 web/api.cgi "$WEB_DIR/"

echo "Installing sudoers rule"
visudo -cf etc/sudoers.d/autotag-gui
install -o root -g root -m 440 etc/sudoers.d/autotag-gui /etc/sudoers.d/

if [ -d /etc/apache2/conf-available ]; then
	echo "Installing Apache configuration"
	install -o root -g root -m 644 etc/apache2/autotag-gui.conf /etc/apache2/conf-available/
	a2enmod -q cgi
	a2enconf -q autotag-gui
	if [ ! -e /etc/apache2/autotag-gui.htpasswd ]; then
		echo
		echo "No password file yet. Create a login for the page with:"
		echo "  htpasswd -c /etc/apache2/autotag-gui.htpasswd YOUR_NAME"
	fi
	apache2ctl configtest && (systemctl reload apache2 || apache2ctl graceful)
else
	echo "No /etc/apache2/conf-available - configure your web server by hand (see README)."
fi

echo
echo "Checking that the web server can run the helper:"
echo '{}' | sudo -u "$WEB_USER" sudo -n -u "$RUN_AS" "$APP_DIR/bin/autotag-gui-helper" start || true
echo "(An error like \"Select a database.\" means the setup works.)"
