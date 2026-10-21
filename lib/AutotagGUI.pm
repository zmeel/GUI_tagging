package AutotagGUI;

# Shared code for the AutoTag GUI: configuration, job folders and job status.
# Used by both the web API (running as the web server user) and the helper
# (running as the BIGSdb user), so everything here must be safe under taint mode.

use strict;
use warnings;
use Exporter qw(import);
use JSON::PP ();
use POSIX qw(strftime);

our $VERSION = '1.0';
our @EXPORT_OK = qw(
  CONFIG_FILE load_config encode_json decode_json read_json write_json
  is_job_id new_job_id job_dir boot_id list_jobs job_info is_active
  parse_isolate_ids tail_lines remove_job
);

use constant CONFIG_FILE       => '/etc/autotag-gui.conf';
use constant HEARTBEAT_TIMEOUT => 90;    #Seconds without heartbeat before a runner is presumed dead
use constant START_GRACE       => 30;    #Seconds a job may exist without a runner while starting

my $JSON = JSON::PP->new->utf8->canonical;
sub encode_json { return $JSON->encode( $_[0] ) }
sub decode_json { return $JSON->decode( $_[0] ) }

sub load_config {
	my ($file) = @_;
	$file //= CONFIG_FILE;
	my $config = do $file;
	if ( ref $config ne 'HASH' ) {
		my $error = $@ || $! || 'file does not return a hash';
		die "Cannot read configuration $file: $error\n";
	}
	foreach my $key (qw(autotag_script run_as helper jobs_dir max_running databases schemes)) {
		die "Configuration $file: '$key' is not set.\n" if !defined $config->{$key};
	}
	$config->{'keep_finished'} //= 50;
	$config->{'max_isolates'}  //= 50_000;
	$config->{'extra_args'}    //= [];
	return $config;
}

sub read_json {
	my ($path) = @_;
	open( my $fh, '<:raw', $path ) || return;
	local $/ = undef;
	my $data = <$fh>;
	close $fh;
	return eval { $JSON->decode($data) };
}

#Write to a temporary file and rename, so readers never see a half-written file.
sub write_json {
	my ( $path, $data ) = @_;
	my $tmp = "$path.tmp.$$";
	open( my $fh, '>:raw', $tmp ) || die "Cannot write $tmp: $!\n";
	print $fh $JSON->encode($data);
	close $fh || die "Cannot write $tmp: $!\n";
	rename( $tmp, $path ) || die "Cannot rename $tmp: $!\n";
	return;
}

#Returns the untainted job id, or undef if it is not a valid id.
sub is_job_id {
	my ($id) = @_;
	return if !defined $id;
	return $id =~ /^(\d{8}-\d{6}-[0-9a-f]{4})$/x ? $1 : undef;
}

sub new_job_id {
	return strftime( '%Y%m%d-%H%M%S', localtime ) . sprintf( '-%04x', int( rand(0x10000) ) );
}

sub job_dir {
	my ( $config, $id ) = @_;
	return "$config->{'jobs_dir'}/$id";
}

sub boot_id {
	open( my $fh, '<', '/proc/sys/kernel/random/boot_id' ) || return q();
	my $id = <$fh> // q();
	close $fh;
	return $id =~ /^([0-9a-f-]+)/x ? $1 : q();
}

sub is_active {
	my ($state) = @_;
	return $state =~ /^(?:starting|running|stopping)$/x ? 1 : 0;
}

#All jobs, newest first.
sub list_jobs {
	my ($config) = @_;
	opendir( my $dh, $config->{'jobs_dir'} ) || return;
	my @ids = sort { $b cmp $a } grep { defined } map { is_job_id($_) } readdir $dh;
	closedir $dh;
	return grep { defined } map { job_info( $config, $_ ) } @ids;
}

sub job_info {
	my ( $config, $id ) = @_;
	my $dir  = job_dir( $config, $id );
	my $meta = read_json("$dir/meta.json") // return;
	my $status   = read_json("$dir/status.json")   // {};
	my $progress = read_json("$dir/progress.json") // {};
	my $result   = read_json("$dir/result.json");
	my $state;
	if ($result) {
		$state = $result->{'state'};
	} elsif ( !$status->{'runner_pid'} ) {
		$state = time - $meta->{'created'} < START_GRACE ? 'starting' : 'interrupted';
	} elsif ( _runner_alive( $dir, $id, $status ) ) {
		$state = -e "$dir/stop.requested" ? 'stopping' : 'running';
	} else {
		$state = 'interrupted';
	}
	my $info = {
		id              => $id,
		state           => $state,
		database        => $meta->{'database'},
		database_label  => $meta->{'database_label'},
		schemes         => $meta->{'schemes'},
		isolate_count   => $meta->{'isolate_count'},
		user            => $meta->{'user'},
		command         => $meta->{'command'},
		fingerprint     => $meta->{'fingerprint'},
		created         => $meta->{'created'},
		started         => $status->{'started'},
		finished        => $result ? $result->{'finished'} : undef,
		exit_code       => $result ? $result->{'exit_code'} : undef,
		message         => $result ? $result->{'message'} : undef,
		done            => $progress->{'done'} // 0,
		current_isolate => $progress->{'current_isolate'},
		lines           => $progress->{'lines'} // 0,
	};
	$info->{'done'} = $info->{'isolate_count'} if $state eq 'finished';
	return $info;
}

sub _runner_alive {
	my ( $dir, $id, $status ) = @_;
	return 0 if ( $status->{'boot_id'} // q() ) ne boot_id();
	my $pid = $status->{'runner_pid'};
	return 0 if ( $pid // q() ) !~ /^\d+$/x;
	if ( open( my $fh, '<', "/proc/$pid/cmdline" ) ) {
		local $/ = undef;
		my $cmdline = <$fh> // q();
		close $fh;
		return index( $cmdline, "autotag-gui-runner $id" ) >= 0 ? 1 : 0;
	}
	return 0 if -e '/proc/1';    #Other processes are visible, so the runner has gone.

	#Other users' processes are hidden (/proc mounted with hidepid) - rely on the heartbeat.
	my $heartbeat = ( stat "$dir/heartbeat" )[9];
	return defined $heartbeat && time - $heartbeat < HEARTBEAT_TIMEOUT ? 1 : 0;
}

#Accepts ids separated by commas, semicolons, spaces or new lines, and ranges such as 988-1002.
#Returns sorted unique (untainted) ids and a list of tokens that could not be understood.
sub parse_isolate_ids {
	my ( $text, $max ) = @_;
	$text //= q();
	$text =~ s/\s*-\s*/-/gx;
	my ( %seen, @bad );
	foreach my $token ( split /[\s,;]+/x, $text ) {
		next if $token eq q();
		if ( $token =~ /^0*([1-9]\d{0,8})$/x ) {
			$seen{$1} = 1;
		} elsif ( $token =~ /^0*([1-9]\d{0,8})-0*([1-9]\d{0,8})$/x && $1 <= $2 ) {
			my ( $from, $to ) = ( $1, $2 );
			die "Range $token is larger than the maximum of $max isolates.\n" if $to - $from >= $max;
			$seen{$_} = 1 foreach $from .. $to;
		} else {
			push @bad, $token;
		}
		die "More than the maximum of $max isolates.\n" if keys %seen > $max;
	}
	my @ids = sort { $a <=> $b } map { /^(\d+)$/x ? $1 : () } keys %seen;
	return ( \@ids, \@bad );
}

#Last $count lines of a (possibly very large) file.
sub tail_lines {
	my ( $path, $count, $bytes ) = @_;
	$bytes //= 16_384;
	open( my $fh, '<:raw', $path ) || return [];
	my $size  = -s $fh;
	my $start = $size > $bytes ? $size - $bytes : 0;
	seek( $fh, $start, 0 );
	local $/ = undef;
	my $data = <$fh> // q();
	close $fh;
	my @lines = split /\r?\n/x, $data;
	shift @lines if $start && @lines;    #First line is probably partial
	splice( @lines, 0, @lines - $count ) if @lines > $count;
	return \@lines;
}

#Job folders only contain plain files.
sub remove_job {
	my ( $config, $id ) = @_;
	$id = is_job_id($id) // return;
	my $dir = job_dir( $config, $id );
	opendir( my $dh, $dir ) || return;
	my @files = map { /^([\w.\-]+)$/x ? $1 : () } readdir $dh;
	closedir $dh;
	unlink "$dir/$_" foreach grep { $_ ne '.' && $_ ne '..' } @files;
	rmdir $dir;
	return;
}

1;
