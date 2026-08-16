set +e
STAMP=$(date -u +%Y%m%d-%H%M%S)
DO=1; [ "$APPLY" = "APPLY" ] || DO=0
[ "$DO" = 1 ] || echo "*** DRY RUN — nothing will be changed ***"
run() { if [ "$DO" = 1 ]; then eval "$@"; else echo "   would run: $@"; fi; }

if [ "$QUARANTINE" = "yes" ]; then
echo "══════════ Q. QUARANTINE WEB MALWARE ══════════"
# The diagnostic found index.php + cache.php pairs inside directories
# like wordpress/wordpress/wordpress/wordpress, s/s/s, and
# responsive/responsive — a repeated path segment is not something an
# installer produces, and no theme keeps PHP in its SASS folder.
# That is dropped malware, and it is what has been burning the CPU.
#
# MOVED, never deleted: it is evidence of how the site was broken
# into, and if I have misjudged a file it can be put straight back.
Q="/root/quarantine-$STAMP"
found=0
# CORRECTION. The first version walked the FILES and asked, for each
# one, whether cache.php was beside it. That answer changes as the
# loop runs: once cache.php has been moved, the index.php next to it
# no longer qualifies and is left behind — so whether the dropper was
# fully removed came down to the order `find` happened to return two
# files in. Proven by a local test where cache.php came first and the
# index.php survived.
#
# Decide the DIRECTORIES first, on evidence that nothing in the loop
# modifies, then take both files out of each. Deterministic.
for d in $(find /home/*/domains/*/public_html -maxdepth 12 \
             -name 'cache.php' -mtime -14 2>/dev/null \
           | xargs -r -n1 dirname | sort -u); do
  # Only a directory whose path repeats a segment back to back. That
  # plus the cache.php that found it is two conditions, so an
  # ordinary index.php is never touched.
  echo "$d" | grep -qE '/([^/]+)/\1(/|$)' || continue
  for f in "$d/cache.php" "$d/index.php"; do
    [ -f "$f" ] || continue
    found=$((found+1))
    echo "   $f"
    if [ "$DO" = 1 ]; then
      mkdir -p "$Q$d"
      mv "$f" "$Q$d/" 2>/dev/null && echo "      -> quarantined"
    fi
  done
done
if [ "$found" = 0 ]; then
  echo "   nothing matched"
else
  echo "   $found file(s); originals preserved under $Q"
  echo "   restore everything with:  cp -a $Q/home /  "
  # The workers still running the old code have to go, or the CPU
  # burn continues until they happen to recycle.
  run "systemctl restart php-fpm82.service php-fpm81.service php-fpm80.service php-fpm74.service"
fi
echo
fi

echo "══════════ 0. ROOM IN THE DENY LIST ══════════"
# Blocking is pointless if the list is full. csf.deny is capped by
# DENY_IP_LIMIT, and when it is reached csf EVICTS the oldest entry
# to make room — the four scanners added earlier today pushed out
# four existing blocks, one of them an SSH brute-forcer. Raising the
# cap first means new blocks are additions rather than swaps.
CONF=/etc/csf/csf.conf
if [ -f "$CONF" ]; then
  cur=$(grep -oP '^DENY_IP_LIMIT\s*=\s*"\K[0-9]+' "$CONF" 2>/dev/null)
  used=$(grep -cv '^#' /etc/csf/csf.deny 2>/dev/null)
  echo "deny list: ${used:-?} entries, limit ${cur:-unset}, target $DENYLIMIT"
  if [ -n "$cur" ] && [ "$cur" -lt "$DENYLIMIT" ]; then
    run "cp -n '$CONF' '$CONF.bak-$STAMP'"
    run "sed -i 's/^DENY_IP_LIMIT *= *\"[0-9]*\"/DENY_IP_LIMIT = \"$DENYLIMIT\"/' '$CONF'"
    # csf -r rereads the config; without it the running firewall keeps
    # the old limit and nothing has actually changed.
    run "csf -r >/dev/null 2>&1"
    echo "   raised to $DENYLIMIT; undo with:  cp '$CONF.bak-$STAMP' '$CONF' && csf -r"
  else
    echo "   already at or above $DENYLIMIT — leaving it"
  fi
else
  echo "csf not installed here"
fi

echo
echo "══════════ 1. BLOCK THE SCANNERS ══════════"
# Deliberately NOT a hand-copied list of addresses. An address that
# merely appears a lot might be a real user, a CDN or an uptime
# monitor; what identifies a scanner is WHAT it asks for. So the
# server works that out for itself: an address is blocked only when
# most of its requests are for paths that exist purely to be
# exploited — environment files, credential dumps, known webshells.
# Character classes rather than backslash escapes: awk warns about
# `\.` and treats it as a plain dot anyway.
BAD='[.]env|/config/(secrets|database)[.]ya?ml|[.]env[.](bak|old|php|txt|json)|wp_filemanager|/vendor/phpunit|/[.]git/|/[.]aws/|eval-stdin[.]php|/SDK/webLanguage'
LOGS=$(ls /var/log/httpd/access_log* /var/log/apache2/access.log* 2>/dev/null | head -5)
if [ -z "$LOGS" ]; then
  echo "no access logs found — skipping"
else
  # For every address: total requests, and how many were exploit
  # probes. Block at >=50 probes AND >=60% of that address's traffic,
  # so a busy legitimate client that happens to 404 once is safe.
  cat $LOGS 2>/dev/null | awk -v bad="$BAD" '
    { total[$1]++ }
    $0 ~ bad { hits[$1]++ }
    END { for (ip in hits)
            if (hits[ip] >= 50 && hits[ip] / total[ip] >= 0.6)
              printf "%s %d %d\n", ip, hits[ip], total[ip] }
  ' | sort -k2 -rn | head -25 > /tmp/scanners.txt
  echo "address                probes  total"
  cat /tmp/scanners.txt
  while read -r ip probes total; do
    [ -n "$ip" ] || continue
    if csf -g "$ip" 2>/dev/null | grep -q "DENY"; then
      echo "   $ip already blocked"
      continue
    fi
    run "csf -d $ip 'scanner: $probes/$total requests were exploit probes'"
  done < /tmp/scanners.txt
  echo "undo any of these with:  csf -dr <address>"
fi

echo
echo "══════════ 1b. SHUT XML-RPC ══════════"
# This is where the CPU was actually going, and it took until the
# cgroup accounting was measured rather than assumed to find it.
#
# Ten php-fpm workers, each alive 990 seconds, each burning ~54% of a
# core, one of them holding xmlrpc.php open — while the access log
# recorded two or three requests a minute. That combination has one
# explanation: XML-RPC's system.multicall lets a caller attempt
# hundreds of logins inside a SINGLE http request. The request runs
# for a quarter of an hour, WordPress hashes every password with a
# deliberately expensive algorithm, and Apache writes its one log line
# only when it finally ends — so the load is invisible in the log and
# the machine still has no CPU left. 38,056 rows in wp_users says how
# well it has been going.
#
# Almost nothing legitimate needs xmlrpc.php: the Jetpack plugin and
# the old WordPress mobile app, neither of which a Persian shop is
# likely to use. Denying it costs no PHP at all — Apache answers 403
# itself, before a worker is ever handed the request.
if [ "$XMLRPC" = "yes" ]; then
  # Find a directory Apache already includes, rather than editing a
  # vhost file DirectAdmin regenerates and would overwrite.
  CONFD=""
  for d in /etc/httpd/conf/extra /etc/httpd/conf.d /etc/apache2/conf-enabled /etc/apache2/conf.d; do
    [ -d "$d" ] && { CONFD="$d"; break; }
  done
  if [ -z "$CONFD" ]; then
    echo "   no apache include directory found — skipping"
  else
    F="$CONFD/block-xmlrpc.conf"
    echo "-- writing $F"
    if [ "$DO" = 1 ]; then
      printf '%s\n' \
        '# XML-RPC brute force was saturating this machine: one request' \
        '# can carry hundreds of login attempts via system.multicall.' \
        '# Delete this file and reload apache to undo.' \
        '<LocationMatch "^/+xmlrpc\.php$">' \
        '    Require all denied' \
        '</LocationMatch>' > "$F"
      # Never reload a config the daemon has not accepted; a bad file
      # here takes every site on the box down.
      if httpd -t 2>/dev/null || apachectl -t 2>/dev/null; then
        systemctl reload httpd 2>/dev/null || systemctl reload apache2 2>/dev/null
        echo "   config valid, apache reloaded"
      else
        rm -f "$F"
        echo "   ::warning::apache rejected the config — removed it, nothing changed"
      fi
      # The in-flight brute-force requests are already inside PHP and
      # a reload will not touch them. They have to be cut off.
      echo "   killing workers stuck on long-running requests:"
      for pid in $(ps -eo pid,etimes,comm --no-headers 2>/dev/null \
                   | awk '$3 ~ /php-fpm/ && $2 > 300 {print $1}'); do
        echo "      pid $pid (running $(ps -o etimes= -p $pid 2>/dev/null)s)"
        kill -TERM "$pid" 2>/dev/null
      done
    fi
    echo "   undo with:  rm $F && systemctl reload httpd"
  fi
else
  echo "not requested"
fi

echo
echo "══════════ 2. CAP PHP-FPM ══════════"
# I had assumed an unbounded pool. The dry run disproved that:
# pm.max_children is already 10 on every PHP version here, and ten
# workers is exactly what was seen. So the worker COUNT is not the
# problem — each worker being CPU-bound is, and capping children
# cannot fix that, because six workers can saturate six CPUs just as
# well as ten can.
#
# What actually bounds CPU is a cgroup quota, so that is what gets
# set: PHP may have most of the machine, never all of it, and the
# remainder is what keeps Apache able to accept connections and the
# chat reachable. It is a systemd drop-in, so nothing in the PHP
# configuration is touched and removing one file undoes it.
#
# The max_children logic below is kept as a safety net for the case
# where some pool really is unbounded.
#
# CORRECTION. The first version gave each php-fpm unit its OWN
# ${QUOTA}% quota. There are four of them here (7.4/8.0/8.1/8.2), so
# collectively they were still allowed 4 x 400% = 1600% on a box with
# 600% — which bounds nothing at all, and the machine went right back
# to 0.3% idle. A per-service limit cannot cap a group of services.
#
# One SLICE holding all of them, with a single quota, is what caps
# the group. The per-unit files are removed so there is one number
# in one place rather than two that disagree.
if [ "$QUOTA" != "0" ]; then
  echo "-- php.slice: ${QUOTA}% TOTAL across every php-fpm version (box has $(nproc)00%)"
  if [ "$DO" = 1 ]; then
    printf '%s\n' '# All php-fpm versions share this one budget.' \
      '# A per-service quota does not bound a GROUP of services:' \
      '# four services at 400% each is 1600% on a 600% machine.' \
      '# Delete this file and daemon-reload to undo.' \
      '[Slice]' "CPUQuota=${QUOTA}%" 'CPUAccounting=yes' \
      > /etc/systemd/system/php.slice
  fi
  for unit in $(systemctl list-units --type=service --no-legend 'php*fpm*' 2>/dev/null | awk '{print $1}'); do
    d="/etc/systemd/system/${unit}.d"
    run "mkdir -p '$d'"
    if [ "$DO" = 1 ]; then
      # Replaces the old per-unit quota rather than sitting beside it.
      rm -f "$d/quota.conf"
      printf '%s\n' '# Join the shared PHP budget; see /etc/systemd/system/php.slice' \
        '[Service]' 'Slice=php.slice' > "$d/slice.conf"
    fi
    echo "   $unit -> php.slice"
    echo "   undo with:  rm $d/slice.conf && systemctl daemon-reload && systemctl restart $unit"
  done
  run "systemctl daemon-reload"
fi

# Apache is what has to ACCEPT the connection before the chat can
# answer, and on a contended box it was losing that race to PHP.
# Weight, not a quota: it costs nothing while the box is idle and
# only matters when something is competing. Applied live, so Apache
# is not restarted.
for w in httpd apache2; do
  if systemctl is-active --quiet "$w" 2>/dev/null; then
    echo "-- $w: raising scheduling weight"
    run "systemctl set-property $w CPUWeight=800 IOWeight=800"
    echo "   undo with:  systemctl revert $w"
  fi
done
if [ "$MAXKIDS" = "0" ]; then
  echo "max_children left alone by request"
else
  CONFS=$(find /etc/php* /usr/local/lsws /opt /usr/local/php* /etc/opt \
            -name '*.conf' -path '*fpm*' 2>/dev/null | xargs grep -l 'pm.max_children' 2>/dev/null | head -10)
  [ -z "$CONFS" ] && echo "no php-fpm pool config found"
  for c in $CONFS; do
    cur=$(grep -oP '^\s*pm\.max_children\s*=\s*\K[0-9]+' "$c" | head -1)
    echo "-- $c (currently ${cur:-unset})"
    if [ -n "$cur" ] && [ "$cur" -le "$MAXKIDS" ]; then
      echo "   already at or below $MAXKIDS — leaving it"
      continue
    fi
    run "cp -n '$c' '$c.bak-$STAMP'"
    run "sed -i 's/^\s*pm\.max_children\s*=.*/pm.max_children = $MAXKIDS/' '$c'"
    echo "   undo with:  cp '$c.bak-$STAMP' '$c' && systemctl reload <the php-fpm unit>"
  done
fi

# CORRECTION, and this one silently undid the whole cap.
#
# This loop used to live inside the `else` above, so passing
# max_children=0 — "leave max_children alone" — skipped it. The slice
# was written and daemon-reload ran, but the RUNNING workers were
# never moved into it: systemctl reported ControlGroup=/php.slice/...
# because that is where the unit WOULD start, while the live
# processes stayed in system.slice, uncapped. The slice had
# accumulated 0.8 CPU-seconds in total while those workers had eight
# minutes each.
#
# A cgroup change applies when the service restarts, and that has
# nothing to do with max_children.
for unit in $(systemctl list-units --type=service --no-legend 'php*fpm*' 2>/dev/null | awk '{print $1}'); do
  echo "-- $unit"
  if [ "$DO" != 1 ]; then
    echo "   would restart/reload $unit"
    continue
  fi
  if [ "$QUOTA" != "0" ]; then
    # Restart, not reload: a reload keeps the existing worker
    # processes, which is exactly the thing that has to change.
    systemctl restart "$unit" && echo "   restarted (slice applied)" \
      || echo "   ::warning::restart failed"
  elif [ "$MAXKIDS" != "0" ]; then
    systemctl reload "$unit" && echo "   reloaded" \
      || echo "   ::warning::reload failed, config left in place"
  else
    echo "   nothing to apply"
  fi
done
# Say whether it actually took, rather than assuming. usage_usec
# climbing is the proof the workers are really inside the slice.
if [ -f /sys/fs/cgroup/php.slice/cpu.stat ]; then
  a=$(awk '/^usage_usec/{print $2}' /sys/fs/cgroup/php.slice/cpu.stat); sleep 2
  b=$(awk '/^usage_usec/{print $2}' /sys/fs/cgroup/php.slice/cpu.stat)
  echo "-- php.slice now using $(( (b-a) / 20000 ))% of one cpu (cap ${QUOTA}%)"
fi

echo
echo "══════════ 3. STOP THE FAILING UNITS ══════════"
# n8n has been failing to start every 10 seconds all day (missing
# environment file), and nginx cannot bind 80/443 because Apache
# holds them. Neither is doing any work; both are noise, and a
# half-configured nginx that one day wins the race for port 443 is a
# genuine hazard to the chat site.
for unit in n8n nginx; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^$unit.service"; then
    state=$(systemctl is-active "$unit" 2>/dev/null)
    echo "-- $unit is $state"
    if [ "$state" = "active" ] && [ "$unit" = "nginx" ]; then
      echo "   ::warning::nginx is ACTIVE and serving — leaving it alone."
      continue
    fi
    run "systemctl disable --now $unit"
    echo "   undo with:  systemctl enable --now $unit"
  else
    echo "-- $unit is not installed"
  fi
done

echo
echo "══════════ 4. PROTECT THE CHAT SERVICE ══════════"
# The real fix for "one busy PHP site takes the chat down" is to put
# the chat on its own machine, which cannot be done from here. This
# is the part that can: tell the scheduler the chat matters more than
# the batch work around it, so it keeps getting CPU under load.
#
# Honest about its limits — Apache still has to accept the connection
# in the first place, so this helps the app respond, it does not on
# its own make a saturated box reachable. Capping PHP above is what
# does that.
DROPIN="/etc/systemd/system/${SERVICE}.d"
run "mkdir -p '$DROPIN'"
if [ "$DO" = 1 ]; then
  # printf, not a heredoc: this whole script is already inside one,
  # and a nested terminator that is indented never closes.
  printf '%s\n' \
    '# Added to keep the chat responsive when other workloads on this' \
    '# box saturate the CPU. Delete this file and daemon-reload to undo.' \
    '[Service]' 'CPUWeight=800' 'IOWeight=800' 'Nice=-5' \
    > "$DROPIN/priority.conf"
  systemctl daemon-reload
  systemctl restart "$SERVICE"
  sleep 3
  systemctl is-active "$SERVICE"
else
  echo "   would add $DROPIN/priority.conf (CPUWeight/IOWeight/Nice) and restart"
fi
echo "   undo with:  rm $DROPIN/priority.conf && systemctl daemon-reload && systemctl restart $SERVICE"

echo
echo "══════════ 5. RE-INFECTION WATCHDOG ══════════"
# Quarantining once buys hours, not a fix. Whatever let the attacker
# write into these document roots is still open, so the droppers come
# back — and the first sign of that, without this, is the site going
# down again.
#
# This installs the SAME conservative detection on a 10-minute timer:
# a directory whose path repeats a segment back to back, with
# cache.php sitting beside the file. It moves, never deletes, and it
# writes down every file it touched, so the log doubles as the answer
# to "is the attacker still getting in".
#
# It is a standing change to the server, so it is opt-in and it comes
# with its own removal.
WD=/usr/local/sbin/web-malware-watch
if [ "$WATCHDOG" = "remove" ]; then
  run "systemctl disable --now web-malware-watch.timer"
  run "rm -f /etc/systemd/system/web-malware-watch.timer /etc/systemd/system/web-malware-watch.service '$WD'"
  run "systemctl daemon-reload"
  echo "   watchdog removed; quarantined files and their log are left in place"
elif [ "$WATCHDOG" = "yes" ]; then
  if [ "$DO" = 1 ]; then
    # Single-quoted heredoc terminators are unusable here (this whole
    # script is already inside one), so the script is written with
    # printf, one line per argument.
    printf '%s\n' \
      '#!/bin/sh' \
      '# Re-quarantines dropped PHP malware. Installed by harden-servers.yml.' \
      '# Remove with: harden-servers.yml, watchdog=remove' \
      'LOG=/var/log/web-malware-watch.log' \
      'Q="/root/quarantine-$(date -u +%Y%m%d-%H%M%S)"' \
      'n=0' \
      '# Directories first, then both files out of each. Walking the' \
      '# files instead makes the result depend on find order: move' \
      '# cache.php first and the index.php beside it stops matching.' \
      'for d in $(find /home/*/domains/*/public_html -maxdepth 12 \' \
      '             -name cache.php -mmin -1440 2>/dev/null \' \
      '           | xargs -r -n1 dirname | sort -u); do' \
      '  echo "$d" | grep -qE "/([^/]+)/\1(/|$)" || continue' \
      '  for f in "$d/cache.php" "$d/index.php"; do' \
      '    [ -f "$f" ] || continue' \
      '    mkdir -p "$Q$d"' \
      '    mv "$f" "$Q$d/" 2>/dev/null || continue' \
      '    n=$((n+1))' \
      '    echo "$(date -u +%FT%TZ) quarantined $f" >> "$LOG"' \
      '  done' \
      'done' \
      '# Only disturb the running workers when something was actually' \
      '# found; a restart every ten minutes for nothing is its own' \
      '# outage.' \
      'if [ "$n" -gt 0 ]; then' \
      '  echo "$(date -u +%FT%TZ) $n file(s) -> $Q; restarting php-fpm" >> "$LOG"' \
      '  # One at a time: systemctl given a unit that does not exist' \
      '  # here fails the whole call and restarts none of the others.' \
      '  for u in $(systemctl list-units --type=service --no-legend "php*fpm*" 2>/dev/null | awk "{print \$1}"); do' \
      '    systemctl restart "$u" 2>/dev/null' \
      '  done' \
      'fi' \
      > "$WD"
    chmod 700 "$WD"
    printf '%s\n' '[Unit]' 'Description=Quarantine dropped PHP malware' \
      '[Service]' 'Type=oneshot' "ExecStart=$WD" 'Nice=10' 'IOSchedulingClass=idle' \
      > /etc/systemd/system/web-malware-watch.service
    printf '%s\n' '[Unit]' 'Description=Run the PHP malware quarantine every 10 minutes' \
      '[Timer]' 'OnBootSec=5min' 'OnUnitActiveSec=10min' 'AccuracySec=1min' \
      '[Install]' 'WantedBy=timers.target' \
      > /etc/systemd/system/web-malware-watch.timer
    systemctl daemon-reload
    systemctl enable --now web-malware-watch.timer
  fi
  echo "   installed; every 10 min, log at /var/log/web-malware-watch.log"
  echo "   undo with:  systemctl disable --now web-malware-watch.timer && rm $WD /etc/systemd/system/web-malware-watch.*"
else
  echo "not requested"
fi
# Whatever the watchdog has caught since it was installed is the
# honest answer to whether the break-in is still live.
if [ -f /var/log/web-malware-watch.log ]; then
  echo "-- watchdog log, last 15 lines --"
  tail -15 /var/log/web-malware-watch.log
fi

echo
echo "══════════ RESULT ══════════"
uptime
ps -eo pcpu,comm --sort=-pcpu 2>/dev/null | head -6
# Ask the process which port it is on. This check was hardcoded to
# 3000 and reported akosalman — which serves on 3001 — as dead.
NPORT=$(ss -ltnp 2>/dev/null | awk '/"node"/ {split($4,a,":"); print a[length(a)]; exit}')
code=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:${NPORT:-3000}/" 2>/dev/null || echo 000)
echo "local HTTP check: port ${NPORT:-3000} -> $code"
