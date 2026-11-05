# Call report — bistbarg

Generated 2026-11-05T10:14Z by .github/workflows/call-report.yml

```
Warning: Permanently added '185.8.174.198' (ED25519) to the list of known hosts.
### is the version that reports this even running here
server logs [call] at all: yes
ICE config offers a relay: yes (if TURN_URL is set in the environment)
TURN_* actually in the service environment: yes

### coturn
active
-- UDP listeners --
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=2968336,fd=121))                                      
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=2968336,fd=120))                                      
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=2968336,fd=119))                                      
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=2968336,fd=118))                                      
-- TCP listeners --
LISTEN 0      1024                       185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=2968336,fd=102))                                      
LISTEN 0      1024                           127.0.0.1:3478        0.0.0.0:*     users:(("turnserver",pid=2968336,fd=95))                                       
LISTEN 0      1024                       185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=2968336,fd=85))                                       
LISTEN 0      1024                       185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=2968336,fd=61))                                       
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
/var/log/turnserver/turn_2968334_2026-11-05.log
-- turn.log: 27 lines, last modified 10:11Z --
-- turn_2968334_2026-11-05.log: 4 lines, last modified 10:11Z --
-- the journal --
lines coturn logged at all: 7
-- what happened, counted --
-- the most recent few, addresses removed --

### every call, oldest first
Nov 05 09:58:38 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=1 relay=0 ans=0 turn=1
Nov 05 09:58:38 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=0 relay=0 ans=1 turn=1
Nov 05 09:59:04 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=1 relay=0 ans=0 turn=1
Nov 05 09:59:05 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=0 relay=0 ans=1 turn=1
Nov 05 10:03:44 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=0 relay=0 ans=0 turn=1
Nov 05 10:03:45 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=1 relay=0 ans=1 turn=1
Nov 05 10:04:40 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=0 relay=0 ans=0 turn=1
Nov 05 10:04:42 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=1 relay=0 ans=1 turn=1

### how they ended
      8 outcome=failed

### what ICE managed, counted
ans=0 : 4
ans=1 : 4
turn=0 : 0
turn=1 : 8
srflx=0 : 4
relay=0 : 8

(ssh exit 0)
```
