# Never fail the job over a missing log file: a partial picture is
# still worth having, and half these paths differ per distribution.
set +e
SINCE="-${HOURS}h"

echo "══════════ NOW ══════════"
date -u
uptime
echo "cpus: $(nproc)"
free -m | head -3
df -h / | tail -1

echo
echo "══════════ BUSIEST PROCESSES ══════════"
ps -eo pcpu,pmem,etimes,user,comm --sort=-pcpu | head -15

echo
echo "══════════ REBOOTS ══════════"
# An outage that ends in a reboot is a different story from one that
# does not, and the box has rebooted several times today.
last -x reboot shutdown | head -10

echo
echo "══════════ KERNEL: PRESSURE ══════════"
# Out-of-memory kills and hung tasks are what a box under real strain
# leaves behind, and they survive the reboot that hid everything else.
journalctl -k --since "$SINCE" --no-pager 2>/dev/null \
  | grep -iE 'out of memory|oom-killer|killed process|blocked for more than|hung task|nf_conntrack: table full' \
  | tail -25 || echo "none"

echo
echo "══════════ SYSTEM WARNINGS AND ERRORS ══════════"
journalctl --since "$SINCE" -p warning --no-pager 2>/dev/null | tail -40

echo
echo "══════════ THE CHAT SERVICE ══════════"
systemctl status "$SERVICE" --no-pager -l 2>/dev/null | head -12
journalctl -u "$SERVICE" --since "$SINCE" --no-pager 2>/dev/null | tail -30

echo
echo "══════════ IS THE CHAT ACTUALLY SERVING ══════════"
# Ask the process what port it is on rather than assuming 3000. A
# health check against a hardcoded port reports a healthy server as
# dead, which is worse than no check at all.
NPORT=$(ss -ltnp 2>/dev/null | grep -o 'users:(("node".*' | head -1 >/dev/null; \
        ss -ltnp 2>/dev/null | awk '/"node"/ {split($4,a,":"); print a[length(a)]; exit}')
echo "node is listening on: ${NPORT:-<not found>}"
if [ -n "$NPORT" ]; then
  echo "HTTP on 127.0.0.1:$NPORT -> $(curl -sS -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$NPORT/" 2>/dev/null || echo unreachable)"
fi

echo "══════════ WEB SERVER IN FRONT ══════════"
ss -ltn 2>/dev/null | grep -E ':(80|443|3000)\b'
echo "-- socket summary --"
ss -s 2>/dev/null | head -5
for l in /var/log/apache2/error.log /var/log/httpd/error_log \
         /usr/local/apache/logs/error_log /var/log/nginx/error.log; do
  [ -f "$l" ] || continue
  echo "-- $l --"
  tail -30 "$l"
done

echo
echo "══════════ WHAT PHP AND MYSQL ARE DOING ══════════"
# php-fpm and mysqld between them ate all six CPUs on bistbarg while
# the chat app used under a second. Naming the pool and the queries
# is the difference between "PHP is busy" and knowing which site.
ps -eo pcpu,user,args --sort=-pcpu 2>/dev/null | head -12 | cut -c1-200
# ps %CPU is an AVERAGE over each process's whole lifetime, which is
# useless for "what is it doing now" and can look like a quota is
# being ignored when it is not. Take a real instantaneous sample.
echo "-- instantaneous cpu (top, second sample) --"
# The second sample only: the first is a lifetime average, same trap
# as ps. And HEAD after the marker, not tail — tail returns the
# idlest processes, which is the opposite of what is wanted.
top -bn2 -d1 2>/dev/null | awk '/^top -/{n++} n==2' | head -14

# Did the CPU quota actually take? Ask systemd and the kernel rather
# than inferring it from process averages.
echo "-- cgroup version --"
stat -fc %T /sys/fs/cgroup 2>/dev/null
# The quota now lives on the SLICE, not the services — the services
# each read "infinity" and that is correct. Reading only the service
# cgroup reported "none" for a cap that was in place, so read the
# parent too, and read what it has actually been THROTTLED by.
echo "-- php.slice (where the shared quota lives) --"
for f in /sys/fs/cgroup/php.slice/cpu.max /sys/fs/cgroup/php.slice/cpu.stat; do
  [ -f "$f" ] && echo "   $f = $(tr '\n' ' ' < "$f" 2>/dev/null)"
done
# A quota being CONFIGURED is not the same as a quota BINDING, and
# reporting the first as if it were the second is how a cap that does
# nothing gets called protection. ps says the workers average 53%
# each, which for ten of them is 530% against a 400% cap — yet
# nr_throttled is zero. One of those two numbers is wrong.
#
# The kernel's own accounting settles it: usage_usec is cumulative
# CPU time for the whole subtree, so the difference over a known
# interval IS the percentage, with no averaging trap.
if [ -f /sys/fs/cgroup/php.slice/cpu.stat ]; then
  a=$(awk '/^usage_usec/{print $2}' /sys/fs/cgroup/php.slice/cpu.stat)
  t0=$(date +%s%N); sleep 2; t1=$(date +%s%N)
  b=$(awk '/^usage_usec/{print $2}' /sys/fs/cgroup/php.slice/cpu.stat)
  echo "   measured over $(( (t1-t0)/1000000 ))ms: php.slice is using $(( (b-a) * 100000 / ((t1-t0)/1000) ))% of one cpu"
  echo "   (cap is 400%; box has $(nproc)00%)"
fi
echo "-- is anything else outside the cap --"
for s in /sys/fs/cgroup/system.slice/cpu.stat /sys/fs/cgroup/user.slice/cpu.stat; do
  [ -f "$s" ] && echo "   $s throttled=$(awk '/^nr_throttled/{print $2}' "$s")"
done
for u in $(systemctl list-units --type=service --no-legend 'php*fpm*' 2>/dev/null | awk '{print $1}'); do
  echo "-- $u"
  systemctl show "$u" -p CPUQuotaPerSecUSec -p CPUAccounting -p ControlGroup 2>/dev/null
  cg=$(systemctl show "$u" -p ControlGroup --value 2>/dev/null)
  [ -n "$cg" ] || continue
  for f in /sys/fs/cgroup${cg}/cpu.max /sys/fs/cgroup/cpu${cg}/cpu.cfs_quota_us; do
    [ -f "$f" ] && echo "   $f = $(cat "$f" 2>/dev/null)"
  done
done

# ── WHICH site, and is this an attack or real work? ────────────
# The decisive question, and it has a decisive answer: a php-fpm
# worker's working directory IS the document root of the site it is
# serving, so /proc/<pid>/cwd names the site without guessing.
echo "-- what the busiest php workers are serving --"
for pid in $(ps -eo pid,comm --sort=-pcpu 2>/dev/null | awk '$2 ~ /php-fpm/ {print $1}' | head -6); do
  echo "   pid $pid cwd=$(readlink /proc/$pid/cwd 2>/dev/null) started=$(ps -o lstart= -p $pid 2>/dev/null)"
done

# Signs of compromise rather than load. A miner or webshell usually
# runs from a temp directory, or is a process nobody installed.
echo "-- processes running from temp or dev-shm --"
for pid in $(ps -eo pid --no-headers 2>/dev/null); do
  exe=$(readlink /proc/$pid/exe 2>/dev/null)
  case "$exe" in
    /tmp/*|/dev/shm/*|/var/tmp/*) echo "   SUSPICIOUS pid $pid -> $exe" ;;
  esac
done | head -10
echo "-- top outbound connections (a miner talks to a pool) --"
ss -tnp state established 2>/dev/null \
  | awk 'NR>1 {split($4,l,":"); split($5,r,":"); if (r[length(r)] != "") print r[length(r)]}' \
  | sort | uniq -c | sort -rn | head -8
echo "-- php files changed in the last day under the busy roots --"
for pid in $(ps -eo pid,comm --sort=-pcpu 2>/dev/null | awk '$2 ~ /php-fpm/ {print $1}' | head -2); do
  root=$(readlink /proc/$pid/cwd 2>/dev/null)
  [ -n "$root" ] && [ -d "$root" ] || continue
  find "$root" -name '*.php' -mtime -1 2>/dev/null | head -10
done

echo "-- php-fpm pools --"
ls /etc/php/*/fpm/pool.d/ /opt/*/php*/etc/php-fpm.d/ 2>/dev/null | head -20

# WHICH SCRIPT is burning the CPU. cwd only names the site; the open
# file descriptors name the actual file being executed, which is the
# difference between "WordPress is busy" and knowing whether it is a
# backdoor, wp-cron or a search query.
echo "-- files open in the busiest php workers --"
for pid in $(ps -eo pid,comm --sort=-pcpu 2>/dev/null | awk '$2 ~ /php-fpm/ {print $1}' | head -3); do
  echo "   pid $pid:"
  ls -l /proc/$pid/fd 2>/dev/null | awk '{print $NF}' \
    | grep -E '\.php$|/tmp/|/dev/shm/' | sort -u | head -6 | sed 's/^/      /'
done

# ── WHAT IS PHP ACTUALLY EXECUTING ────────────────────────────
# The numbers stopped adding up: php-fpm workers burning ~350% with
# 42% of it in the KERNEL, MySQL with every connection asleep, and an
# access log holding four thousand requests for a whole day. There is
# no flood and no database work, so the CPU is not coming from
# ordinary traffic.
#
# php-fpm workers only run when the web server hands them a request,
# and Apache logs a request when it FINISHES. A request that never
# finishes never appears in the log — which is exactly what a webshell
# told to loop looks like. mod_status lists requests still in flight,
# so it can see what the log cannot.
echo "-- apache: requests in flight --"
timeout 15 curl -sS -m 10 'http://127.0.0.1/server-status?auto' 2>/dev/null \
  | head -12 || echo "   mod_status not reachable on 127.0.0.1"
timeout 15 curl -sS -m 10 'http://127.0.0.1/server-status' 2>/dev/null \
  | sed -e 's/<[^>]*>/ /g' -e '/^ *$/d' | grep -iE '^ *[0-9]+ .*(GET|POST)' | head -12
echo "-- what the busy workers are blocked on --"
for pid in $(ps -eo pid,comm --sort=-pcpu 2>/dev/null | awk '$2 ~ /php-fpm/ {print $1}' | head -3); do
  echo "   pid $pid wchan=$(cat /proc/$pid/wchan 2>/dev/null) state=$(awk '/^State/{print $2}' /proc/$pid/status 2>/dev/null) threads=$(awk '/^Threads/{print $2}' /proc/$pid/status 2>/dev/null)"
  # The FastCGI request parameters land in the worker's environment,
  # so this names the script and the caller when it works.
  tr '\0' '\n' < /proc/$pid/environ 2>/dev/null \
    | grep -E '^(SCRIPT_FILENAME|REQUEST_URI|REMOTE_ADDR|QUERY_STRING|HTTP_HOST)=' | sed 's/^/      /'
  echo "      open: $(ls -l /proc/$pid/fd 2>/dev/null | awk '{print $NF}' | grep -v '^$' | sort -u | tr '\n' ' ' | cut -c1-300)"
done
echo "-- outbound connections owned by php --"
ss -tnp state established 2>/dev/null | grep -c 'php-fpm' \
  | sed 's/^/   php-fpm sockets: /'

# Persistence lives in cron as often as in a file, and a cron job
# explains CPU with no matching web traffic.
echo "-- user crontabs --"
# head -5 showed MAILTO and PATH and stopped, which is exactly the
# part that says nothing. Drop the variable assignments and print the
# actual jobs.
for c in /var/spool/cron/* /var/spool/cron/crontabs/*; do
  [ -f "$c" ] || continue
  body=$(grep -vE '^\s*(#|$|[A-Z_]+=)' "$c" 2>/dev/null | head -12)
  [ -n "$body" ] && { echo "   $c:"; echo "$body" | cut -c1-180 | sed 's/^/      /'; }
done

# How long the busy workers have been on this ONE request. php-fpm
# requests are normally milliseconds; minutes means something is
# looping or scanning, and it also explains an empty access log,
# since Apache only logs a request once it finishes.
echo "-- how long php workers have been running --"
ps -eo etimes,pcpu,pid,comm --sort=-pcpu 2>/dev/null \
  | awk 'NR==1 || $4 ~ /php-fpm/' | head -8

echo "-- mysql: what is running right now --"
# root has no my.cnf here, but DirectAdmin keeps credentials in a
# known place — without them this section printed nothing at all and
# the busiest process on the box went unexplained.
DACNF=/usr/local/directadmin/conf/mysql.conf
if [ -f "$DACNF" ]; then
  DAU=$(awk -F= '/^user=/{print $2}' "$DACNF" 2>/dev/null)
  DAP=$(awk -F= '/^passwd=/{print $2}' "$DACNF" 2>/dev/null)
  m() { MYSQL_PWD="$DAP" timeout 20 mysql -u"$DAU" --connect-timeout=5 "$@" 2>/dev/null; }
  # Three samples, because one snapshot of a processlist is a
  # coincidence. What repeats is what is costing the machine.
  for i in 1 2 3; do
    m -e 'SHOW FULL PROCESSLIST;' | awk -F'\t' '$5=="Query" && $8!~/PROCESSLIST/ {print "   " $6 "s " substr($8,1,150)}'
    sleep 2
  done
  echo "   -- what those queries are scanning --"
  DB=$(m -N -e "SELECT table_schema FROM information_schema.tables
                WHERE table_name LIKE '%postmeta' GROUP BY table_schema
                ORDER BY SUM(data_length+index_length) DESC LIMIT 1")
  if [ -n "$DB" ]; then
    echo "   biggest wordpress db: $DB"
    m -e "SELECT table_name, table_rows,
                 ROUND((data_length+index_length)/1048576) AS mb
          FROM information_schema.tables WHERE table_schema='$DB'
          ORDER BY (data_length+index_length) DESC LIMIT 6;" | sed 's/^/   /'
    # WooCommerce queues its background work here. A queue that only
    # grows is a job that never finishes and restarts for ever.
    m -e "SELECT status, COUNT(*) FROM ${DB}.wp_actionscheduler_actions
          GROUP BY status;" 2>/dev/null | sed 's/^/   scheduler: /' \
      || echo "   (no action scheduler table)"
  fi
else
  mysql -e 'SHOW FULL PROCESSLIST;' 2>/dev/null | cut -c1-200 | head -20 \
    || echo "could not query mysql without credentials"
fi

echo
echo "══════════ WHO IS CALLING ══════════"
# A flood shows up here as one or two addresses with an implausible
# share of the requests. Top 12 only.
# The first pass matched an EMPTY apache2 log and stopped there, so
# it reported nothing while the real traffic was logged elsewhere.
#
# CORRECTION. Taking the BIGGEST log then picked access_log.3 — a
# rotated file — and reported hours-old traffic as if it were what
# the box is doing now. "Who is hitting us at this moment" has to
# come from the NEWEST log, and from the last few minutes of it.
newest=$(ls -t /var/log/httpd/*access* /var/log/apache2/*access* \
               /var/log/nginx/*access* /home/*/logs/*log 2>/dev/null \
         | grep -v '[.]gz$' | head -1)
if [ -n "$newest" ] && [ -s "$newest" ]; then
  echo "-- $newest ($(wc -l < "$newest") lines) --"
  # The tail is the recent traffic; the whole file may span a day.
  tail -5000 "$newest" > /tmp/recent.log 2>/dev/null
  echo "window: $(head -1 /tmp/recent.log | grep -o '\[[^]]*\]' | head -1) .. $(tail -1 /tmp/recent.log | grep -o '\[[^]]*\]' | head -1)"
  echo "top callers (last 5000 requests):"
  awk '{print $1}' /tmp/recent.log | sort | uniq -c | sort -rn | head -12
  echo "most requested (last 5000):"
  awk '{print $7}' /tmp/recent.log | sort | uniq -c | sort -rn | head -12
  # A flood is only a flood if it is fast. Requests per minute over
  # the window is what separates "busy site" from "under attack".
  echo "requests per minute, last 10 minutes:"
  awk -F'[][]' '{print $2}' /tmp/recent.log | cut -d: -f1-3 \
    | uniq -c | tail -10
else
  echo "no non-empty access log found in the usual places"
fi

echo
echo "══════════ SUMMARY ══════════"
# Everything above is detail. This is the answer, and it is last so
# that reading the tail of the log is enough.
echo "load:        $(uptime | sed 's/.*load average: //') on $(nproc) cpus"
echo "chat:        port ${NPORT:-?} -> $(curl -sS -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:${NPORT:-3000}/" 2>/dev/null || echo unreachable)"
# The quota is on the slice, not on each service. Reporting only the
# service cgroup printed "none" for a cap that was in place.
echo "php quota:   php.slice $(cat /sys/fs/cgroup/php.slice/cpu.max 2>/dev/null || echo 'no slice') (period 100000 = 1 cpu)"
echo "php throttled: $(awk '/nr_throttled|throttled_usec/ {printf "%s=%s ", $1, $2}' /sys/fs/cgroup/php.slice/cpu.stat 2>/dev/null || echo '?')"
echo "idle cpu:    $(top -bn2 -d1 2>/dev/null | awk '/^%Cpu/{l=$0} END{print l}')"
echo "watchdog:    $(systemctl is-active web-malware-watch.timer 2>/dev/null || echo 'not installed'), $(grep -c quarantined /var/log/web-malware-watch.log 2>/dev/null || echo 0) file(s) caught since install"
echo "csf deny:    $(wc -l < /etc/csf/csf.deny 2>/dev/null || echo '?') entries, limit $(grep -oP '^DENY_IP_LIMIT\s*=\s*"\K[0-9]+' /etc/csf/csf.conf 2>/dev/null || echo '?')"
