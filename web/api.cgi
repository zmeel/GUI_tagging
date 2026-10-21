#!/usr/bin/perl
#
# AutoTag GUI web API. Runs as the web server user and only reads job folders;
# starting and stopping jobs is done by the helper, run as the BIGSdb user via sudo.
#
#   GET  api.cgi?action=status            settings and jobs (JSON)
#   GET  api.cgi?action=log&job=JOB_ID    full autotag.pl output (text)
#   POST api.cgi?action=start             JSON body {database, schemes, isolates, threads}
#   POST api.cgi?action=stop&job=JOB_ID

use strict;
use warnings;
use lib '/opt/autotag-gui/lib';
use AutotagGUI qw(
  load_config encode_json decode_json is_job_id job_dir list_jobs job_info is_active tail_lines
);
use IPC::Open3 qw(open3);

use constant MAX_BODY   => 2_000_000;
use constant TAIL_LINES => 8;

binmode STDOUT;
$SIG{'PIPE'} = 'IGNORE';
my %param  = parse_query( $ENV{'QUERY_STRING'} );
my $method = $ENV{'REQUEST_METHOD'} // 'GET';
my $action = $param{'action'} // 'status';
my $config = eval { load_config() } || send_json( 500, { ok => 0, error => "$@" } );

if ( $method eq 'GET' && $action eq 'status' ) {
	send_json( 200, status() );
} elsif ( $method eq 'GET' && $action eq 'log' ) {
	send_log( $param{'job'} );
} elsif ( $method eq 'POST' ) {

	#Browsers cannot add this header to cross-site requests, so other sites cannot start jobs.
	send_json( 403, { ok => 0, error => 'Missing X-Requested-With header.' } )
	  if ( $ENV{'HTTP_X_REQUESTED_WITH'} // q() ) ne 'autotag-gui';
	if ( $action eq 'start' ) {
		my $request = eval { decode_json( read_body() ) };
		send_json( 400, { ok => 0, error => 'Invalid request.' } ) if ref $request ne 'HASH';
		my %job = map { $_ => $request->{$_} } qw(database schemes isolates threads);
		$job{'user'} = $ENV{'REMOTE_USER'} // q();
		send_json( 200, run_helper( encode_json( \%job ), 'start' ) );
	} elsif ( $action eq 'stop' ) {
		my $id = is_job_id( $param{'job'} ) // send_json( 400, { ok => 0, error => 'Invalid job id.' } );
		send_json( 200, run_helper( q(), 'stop', $id ) );
	}
}
send_json( 400, { ok => 0, error => 'Unknown action.' } );

sub status {
	my @jobs = list_jobs($config);
	foreach my $job (@jobs) {
		delete $job->{'fingerprint'};
		next if $job->{'state'} eq 'finished';
		$job->{'tail'} = tail_lines( job_dir( $config, $job->{'id'} ) . '/output.log', TAIL_LINES );
	}
	return {
		ok           => 1,
		now          => time,
		max_running  => $config->{'max_running'},
		running      => scalar( grep { is_active( $_->{'state'} ) } @jobs ),
		max_threads  => $config->{'max_threads'},
		max_isolates => $config->{'max_isolates'},
		databases    => [ map { { name => $_->{'name'}, label => $_->{'label'} // $_->{'name'} } } @{ $config->{'databases'} } ],
		schemes      => [ map { { id => $_->{'id'}, label => $_->{'label'} // "Scheme $_->{'id'}", default => $_->{'default'} ? \1 : \0 } } @{ $config->{'schemes'} } ],
		jobs         => \@jobs,
		user         => $ENV{'REMOTE_USER'}
	};
}

sub send_log {
	my ($id) = @_;
	$id = is_job_id($id) // send_json( 400, { ok => 0, error => 'Invalid job id.' } );
	my $dir = job_dir( $config, $id );
	send_json( 404, { ok => 0, error => 'Job not found.' } ) if !-d $dir;
	print "Status: 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\n\r\n";
	foreach my $file ( 'output.log', 'runner.log' ) {
		open( my $fh, '<:raw', "$dir/$file" ) || next;
		print "\n--- Messages from the AutoTag GUI runner ---\n" if $file eq 'runner.log' && -s $fh;
		while ( read( $fh, my $chunk, 65_536 ) ) {
			print $chunk;
		}
		close $fh;
	}
	exit;
}

#Runs the helper as the BIGSdb user; it prints a single JSON line.
sub run_helper {
	my ( $input, @args ) = @_;
	my ( $in, $out );
	my $pid = eval { open3( $in, $out, undef, 'sudo', '-n', '-u', $config->{'run_as'}, $config->{'helper'}, @args ) }
	  || return { ok => 0, error => "Cannot run sudo: $@" };
	print $in $input;
	close $in;
	local $/ = undef;
	my $output = <$out> // q();
	close $out;
	waitpid( $pid, 0 );
	foreach my $line ( reverse split /\r?\n/x, $output ) {
		next if $line !~ /^\{/x;
		my $result = eval { decode_json($line) };
		return $result if ref $result eq 'HASH';
	}
	$output =~ s/\s+$//x;
	return {
		ok    => 0,
		error => "The helper could not be run as $config->{'run_as'} (check the sudoers rule, see README): $output"
	};
}

sub read_body {
	my $length = $ENV{'CONTENT_LENGTH'} // 0;
	send_json( 413, { ok => 0, error => 'Request too large.' } ) if $length !~ /^\d+$/x || $length > MAX_BODY;
	binmode STDIN;
	my $body = q();
	while ( length $body < $length ) {
		read( STDIN, $body, $length - length $body, length $body ) || last;
	}
	return $body;
}

sub parse_query {
	my ($query) = @_;
	my %values;
	foreach my $pair ( split /[&;]/x, $query // q() ) {
		my ( $key, $value ) = map {
			( my $text = $_ ) =~ tr/+/ /;
			$text =~ s/%([0-9A-Fa-f]{2})/chr hex $1/egx;
			$text
		} split /=/x, $pair, 2;
		$values{$key} = $value // q();
	}
	return %values;
}

sub send_json {
	my ( $code, $data ) = @_;
	my %text = ( 200 => 'OK', 400 => 'Bad Request', 403 => 'Forbidden', 404 => 'Not Found', 413 => 'Payload Too Large',
		500 => 'Internal Server Error' );
	print "Status: $code $text{$code}\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\n\r\n";
	print encode_json($data);
	exit;
}
