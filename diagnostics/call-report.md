# Call report — bistbarg

Generated 2026-11-05T12:58Z by .github/workflows/call-report.yml

```
Warning: Permanently added '185.8.174.198' (ED25519) to the list of known hosts.
### is the version that reports this even running here
server logs [call] at all: yes
ICE config offers a relay: yes (if TURN_URL is set in the environment)
TURN_* actually in the service environment: yes

### coturn
active
-- listeners by address (udp/tcp), both instances --
  :3478
    udp       6 0.0.0.0:* 
    tcp       6 127.0.0.1 
  :443
    udp      12 0.0.0.0:*       6 [::]:* 
    tcp       1 * 
-- the 443 instance --
active
-- its own log --
0: Listener address to use: -
0: Listener address to use: -
0: Listener address to use: ::1
0: IO method (main listener thread): epoll (with changelist)
-- how coturn is configured (no credentials printed) --
listening-port=3478
lt-cred-mech
realm=chat.bistbarg.com
no-tcp-relay
-- firewall on the TURN ports --
-A INPUT ! -i lo -p tcp -m conntrack --ctstate NEW -m tcp --dport 3478 -j ACCEPT
-A INPUT ! -i lo -p udp -m conntrack --ctstate NEW -m udp --dport 3478 -j ACCEPT
-A INPUT ! -i lo -p udp -m conntrack --ctstate NEW -m udp --dport 49152:65535 -j ACCEPT
-A OUTPUT ! -o lo -p tcp -m conntrack --ctstate NEW -m tcp --dport 3478 -j ACCEPT
-A OUTPUT ! -o lo -p udp -m conntrack --ctstate NEW -m udp --dport 3478 -j ACCEPT
-A OUTPUT ! -o lo -p udp -m conntrack --ctstate NEW -m udp --dport 49152:65535 -j ACCEPT

### did the phones' allocate requests reach coturn
-- where coturn writes --
log-file=/var/log/turnserver/turn.log
simple-log
log files present: /var/log/turnserver/turn.log
/var/log/turnserver/turn_2988051_2026-11-05.log
/var/log/turnserver/turn_2987606_2026-11-05.log
-- turn.log: 1155 lines, last modified 12:58Z --
-- turn_2988051_2026-11-05.log: 4 lines, last modified 12:57Z --
-- turn_2987606_2026-11-05.log: 4 lines, last modified 12:56Z --
-- the journal --
lines coturn logged at all: 149
-- what happened, counted --
-- the most recent few, addresses removed --

### every call, oldest first
Nov 05 12:52:58 srv5524755161 node[2984851]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=1 relay=0 ans=1 turn=1
Nov 05 12:52:58 srv5524755161 node[2984851]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=0 relay=0 ans=1 turn=1

### how they ended
      2 outcome=failed

### what ICE managed, counted
ans=0 : 0
ans=1 : 2
turn=0 : 0
turn=1 : 2
srflx=0 : 1
relay=0 : 2

(ssh exit 0)
```
