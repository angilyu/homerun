#!/usr/bin/perl
# Where an xcodebuild run's time went (.github/workflows/ios.yml ios-sim). Reads a build.log whose
# lines start with the seconds since the build began, so it works on a build cut off by a timeout:
# the targets by wall-clock span, the actions by count, and xcodebuild's own timing summary when
# the build got that far.
use strict;
use warnings;

my (%first, %last, %actions, %kinds, @summary, $end, $result);
my $in_summary = 0;
while (<>) {
  next unless s/^\s*([0-9]+\.[0-9])\s//;
  my $t = $1;
  $end = $t;
  $result = $1 if /\*\* (BUILD \w+) \*\*/;
  $in_summary = 1 if /^Build Timing Summary/;
  push @summary, $_ if $in_summary && /\|\s*[0-9.]+ seconds/;
  next unless /^(\S+) .*\(in target '([^']+)' from project '([^']+)'\)/;
  my ($kind, $target) = ($1, "$3/$2");
  $first{$target} //= $t;
  $last{$target} = $t;
  $actions{$target}++;
  $kinds{$kind}++;
}
die "no timestamped lines\n" unless defined $end;

printf "%s after %.0f s\n", $result // "no result (cut off?)", $end;
print "\nTargets by wall-clock span (they overlap):\n";
for my $target (sort { ($last{$b} - $first{$b}) <=> ($last{$a} - $first{$a}) } keys %first) {
  printf "  %6.0f s  %6.0f..%-6.0f %5d actions  %s\n", $last{$target} - $first{$target}, $first{$target},
    $last{$target}, $actions{$target}, $target;
}
print "\nActions by count:\n";
my @kinds = sort { $kinds{$b} <=> $kinds{$a} } keys %kinds;
printf "  %6d  %s\n", $kinds{$_}, $_ for @kinds[0 .. ($#kinds < 11 ? $#kinds : 11)];
if (@summary) {
  print "\nxcodebuild's timing summary, longest first:\n";
  my $seconds = sub { $_[0] =~ /\|\s*([0-9.]+) seconds/ ? $1 : 0 };
  print "  $_" for (sort { $seconds->($b) <=> $seconds->($a) } @summary)[0 .. ($#summary < 14 ? $#summary : 14)];
}
