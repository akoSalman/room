# Call report — bistbarg

Generated 2026-11-05T10:00Z by .github/workflows/call-report.yml

```
Warning: Permanently added '185.8.174.198' (ED25519) to the list of known hosts.
### is the version that reports this even running here
server logs [call] at all: yes
ICE config offers a relay: yes (if TURN_URL is set in the environment)
TURN_* actually in the service environment: yes

### coturn
active
-- UDP listeners --
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=49))                                           
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=48))                                           
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=47))                                           
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=46))                                           
-- TCP listeners --
LISTEN 0      1024                       185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=149))                                          
LISTEN 0      1024                       185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=142))                                          
LISTEN 0      1024                       185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=119))                                          
LISTEN 0      1024                           127.0.0.1:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=115))                                          
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
(nothing set: coturn defaults to /var/log/turn_*.log)
log files present: none
-- the journal --
lines coturn logged at all: 2
-- what happened, counted --
-- the most recent few, addresses removed --

### every call, oldest first
Nov 05 09:30:53 srv5524755161 node[2957335]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=1 relay=0 ans=0 turn=1
Nov 05 09:30:54 srv5524755161 node[2957335]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=0 relay=0 ans=1 turn=1
Nov 05 09:58:38 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=1 relay=0 ans=0 turn=1
Nov 05 09:58:38 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=0 relay=0 ans=1 turn=1
Nov 05 09:59:04 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=1 relay=0 ans=0 turn=1
Nov 05 09:59:05 srv5524755161 node[2966329]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=0 relay=0 ans=1 turn=1

### how they ended
      6 outcome=failed

### what ICE managed, counted
ans=0 : 3
ans=1 : 3
turn=0 : 0
turn=1 : 6
srflx=0 : 3
relay=0 : 6

(ssh exit 0)
```
