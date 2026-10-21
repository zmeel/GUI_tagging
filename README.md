# BIGSdb AutoTag GUI

A small web page for starting BIGSdb's `autotag.pl` in the background and following its progress.

- Pick a database, tick schemes, paste isolate ids (commas, spaces, new lines, or ranges such as `988-1002`).
- The run continues on the server when you close the page; reopen it any time to see progress.
- At most 3 sessions run at once (configurable). Further sessions wait in a queue and start
  automatically when a running one finishes; queued sessions can be cancelled.
- Identical runs cannot be started or queued twice.
- Each running session shows its progress, an estimate of the time left, and a summary of what was
  tagged so far (alleles tagged, isolates, missing loci, errors).
- Running sessions can be stopped. Finished, failed, stopped and interrupted runs are listed with
  their summary and full log.
- *Run again* copies a finished session's database, schemes and isolates into the form. For a stopped
  or interrupted session, *Run remaining* copies only the isolates that were not done.
- The page header shows the server's CPU load and free memory.

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
- When all slots are taken, a new session is registered as *queued*. When a run ends, its runner
  starts the next queued session (oldest first). `/etc/cron.d/autotag-gui` runs
  `autotag-gui-helper dispatch` every minute as well, so the queue also moves on after a crash or reboot.
- The summary counts the `Allele: N` lines (`Allele: 0` is a missing locus) and the
  `Cannot insert ...` errors in the `autotag.pl` output. The time estimate uses the speed since the
  first isolate.
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
| `/etc/cron.d/autotag-gui` | starts queued sessions every minute if a run ended without doing so |
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

- the path to `autotag.pl` (now `/opt/BIGSdb-v_1.54.1/...`; **update it when you upgrade BIGSdb**);
- the databases and schemes offered on the page;
- `max_running` (3), `max_queued` (10), `keep_finished` (50) and `max_isolates`;
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

## Database backups

`backup/bigsdb-backup` makes the nightly PostgreSQL backups. It replaces the separate `pg_dump` lines
in the postgres crontab.

- Backs up **every** database on the server except `postgres` and the templates, so new BIGSdb
  databases are included automatically. That includes `bigsdb_auth`, `bigsdb_prefs`, `bigsdb_refs`,
  `bigsdb_jobs` and `sequtrecht_bigsdb_users`. Roles and passwords are saved in `globals_DATE.sql`.
- Uses `pg_dump -F custom` (compressed), one file per database: `DATABASE_YYYYMMDD.dump`.
- Each dump is written to a temporary file. It is only kept if `pg_dump` succeeded and `pg_restore`
  can read it back.
- A database's backups older than 7 days are removed only after today's backup of that database
  succeeded, so failing backups never delete the last good ones. Old `.tar` backups are cleaned up
  the same way.
- Everything is logged in `bigsdb-backup.log` in the backup folder. Errors are also printed, so cron
  emails them. A successful run prints nothing.
- `pg_dump` works on a consistent snapshot, so backups are safe while tagging sessions are running.
  Tags added after a dump started are in the next day's backup.

### Installation

```sh
sudo install -o root -g root -m 755 backup/bigsdb-backup /usr/local/bin/
sudo -u postgres /usr/local/bin/bigsdb-backup     # test run; prints nothing when all is well
sudo -u postgres crontab -e                       # replace the old lines with the contents of backup/crontab
```

Settings can be changed in the crontab line, for example
`0 6 * * * KEEP_DAYS=14 EXCLUDE="bigsdb_jobs" /usr/local/bin/bigsdb-backup`:

| Setting | Default | |
| --- | --- | --- |
| `BACKUP_DIR` | `/data/sequtrecht_storage/postgresql/backups` | where backups go |
| `KEEP_DAYS` | `7` | remove backups older than this |
| `EXCLUDE` | (none) | space-separated databases to skip |
| `LOCK_WAIT_TIMEOUT` | `30min` | skip a database (and report it) if a table stays locked by a schema change |

### Restoring

```sh
# Into a new, empty database (e.g. to look at old data):
sudo -u postgres createdb ecoli_isolates_old
sudo -u postgres pg_restore -d ecoli_isolates_old ecoli_isolates_20261021.dump

# Replace a database completely (stop Apache first so nobody is using it):
sudo -u postgres dropdb ecoli_isolates
sudo -u postgres pg_restore --create -d postgres ecoli_isolates_20261021.dump

# On a new server, restore roles and passwords first:
sudo -u postgres psql -f globals_20261021.sql
```

Test a restore now and then. A backup you have never restored is not a proven backup.
