# BIGSdb AutoTag GUI

A small web page for starting BIGSdb's `autotag.pl` in the background and following its progress.

- Pick a database, tick schemes, paste isolate ids (commas, spaces, new lines, or ranges such as `988-1002`).
- The run continues on the server when you close the page; reopen it any time to see progress.
- At most 3 sessions run at once (configurable). Identical runs cannot be started twice.
- Running sessions can be stopped. Finished, failed, stopped and interrupted runs are listed with their full log.

## How it works

```
browser ──> /autotag/api.cgi (www-data) ──sudo──> autotag-gui-helper (bigsdb) ──> autotag.pl
                 │ reads                                  │ writes
                 └──────── /var/lib/autotag-gui/jobs/<job id>/ ◄┘
```

- `web/api.cgi` runs as the web server user. It only reads job folders. To start or stop a job it calls
  the helper through `sudo -u bigsdb`; the sudoers rule allows nothing else.
- `bin/autotag-gui-helper` (Perl, taint mode) checks every request against `/etc/autotag-gui.conf`:
  only the configured databases and schemes, numeric isolate ids, a lock so two requests cannot take
  the last free slot together. It then starts a detached runner in its own session, so the job is
  independent of the web request, sudo and Apache restarts.
- The runner runs
  `autotag.pl --database DB --schemes 1,2 --isolate_list_file <job>/isolates.txt`,
  writes the output to `output.log` and counts the `Isolate: N; Locus: ...` lines for the progress bar.
  It also records the exit code when the run finishes.
- A run whose process is gone, for example after a reboot, is shown as *Interrupted* and no longer
  counts towards the limit.
- Stop sends TERM to the job. `autotag.pl` then finishes the current locus and exits; the alleles tagged so
  far are kept. If the job has not stopped 30 seconds after Stop, *Force stop* kills it.

Each job folder holds `meta.json` (settings), `isolates.txt`, `status.json`, `progress.json`,
`output.log`, `result.json` and `runner.log` (runner errors). The newest 50 finished jobs are kept.

## Installation

On the BIGSdb server, as root, from a checkout of this repository:

```sh
sudo ./install.sh
sudo htpasswd -c /etc/apache2/autotag-gui.htpasswd YOUR_NAME   # login for the page
```

Then open `https://sequtrecht.nl/autotag/`.

`install.sh` installs:

| Path | What |
| --- | --- |
| `/opt/autotag-gui/bin/autotag-gui-helper`, `/opt/autotag-gui/lib/` | helper and Perl module (owned by root) |
| `/etc/autotag-gui.conf` | configuration (an existing file is kept) |
| `/var/lib/autotag-gui/jobs/` | job folders, owner `bigsdb`, group `www-data` |
| `/var/www/html/autotag/` | `index.html`, `app.js`, `style.css`, `api.cgi` |
| `/etc/sudoers.d/autotag-gui` | `www-data` may run the helper as `bigsdb` |
| `/etc/apache2/conf-available/autotag-gui.conf` | enables CGI and the password for `/autotag` (`a2enmod cgi`, `a2enconf autotag-gui`) |

At the end the installer checks that the web server can run the helper. The expected answer is
`{"error":"Select a database.","ok":0}`.

Only core Perl modules are used (JSON::PP, IPC::Open3, IO::Select, Digest::MD5, POSIX).

### Password protection

The BIGSdb login only protects BIGSdb itself (`bigsdb.pl`), not other folders under `/var/www/html`.
Anyone who can open this page can tag alleles in your databases, so the Apache configuration requires
a login (basic authentication with `/etc/apache2/autotag-gui.htpasswd`). Add more users with
`htpasswd /etc/apache2/autotag-gui.htpasswd OTHER_NAME`. The user name is shown next to each job.

If the folder is already protected some other way (VPN, IP restriction, an existing `<Location>`
block), remove the four `Auth`/`Require` lines from `/etc/apache2/conf-available/autotag-gui.conf`
and reload Apache.

## Configuration

Edit `/etc/autotag-gui.conf` (Perl syntax). It holds:

- the path to `autotag.pl` (now `/opt/BIGSdb-v_1.51.4/...`; **update it when you upgrade BIGSdb**);
- the databases and schemes offered on the page;
- `max_running` (3), `keep_finished` (50) and `max_isolates`;
- `extra_args`: arguments always passed to `autotag.pl`, e.g. `[ '--fast' ]`.

Changes take effect immediately; there is no need to restart Apache.

If the BIGSdb user or the web server user is not `bigsdb`/`www-data`, change `run_as` in the
configuration, the sudoers rule, and `RUN_AS`/`WEB_USER` at the top of `install.sh`.

## Troubleshooting

- **"The helper could not be run as bigsdb"**: the sudoers rule is missing or wrong.
  Test with `echo '{}' | sudo -u www-data sudo -n -u bigsdb /opt/autotag-gui/bin/autotag-gui-helper start`.
- **The page shows the source of `api.cgi` or gives 403**: CGI is not enabled for the folder.
  Run `a2enmod cgi && a2enconf autotag-gui && systemctl reload apache2`.
- **A job failed immediately**: open its *Log*. Errors from `autotag.pl` (database name, permissions,
  "Script already running with these parameters") appear there; errors from the runner appear at
  the end, under "Messages from the AutoTag GUI runner".
- Jobs started from the command line are not shown on the page and do not count towards the limit.
