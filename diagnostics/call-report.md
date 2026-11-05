# Call report — akosalman

Generated 2026-11-05T10:16Z by .github/workflows/call-report.yml

```
Warning: Permanently added '185.208.172.96' (ED25519) to the list of known hosts.
### is the version that reports this even running here
server logs [call] at all: yes
ICE config offers a relay: yes (if TURN_URL is set in the environment)
TURN_* actually in the service environment: yes

### coturn
active
-- UDP listeners --
UNCONN 0      0                        185.208.172.96:3478      0.0.0.0:*    users:(("turnserver",pid=436,fd=21))     
UNCONN 0      0                        185.208.172.96:3478      0.0.0.0:*    users:(("turnserver",pid=436,fd=20))     
UNCONN 0      0                             127.0.0.1:3478      0.0.0.0:*    users:(("turnserver",pid=436,fd=17))     
UNCONN 0      0                             127.0.0.1:3478      0.0.0.0:*    users:(("turnserver",pid=436,fd=16))     
-- TCP listeners --
LISTEN 0      1024                          127.0.0.1:3478      0.0.0.0:*    users:(("turnserver",pid=436,fd=54))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             
LISTEN 0      1024                          127.0.0.1:3478      0.0.0.0:*    users:(("turnserver",pid=436,fd=43))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             
LISTEN 0      1024                     185.208.172.96:3478      0.0.0.0:*    users:(("turnserver",pid=436,fd=58))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             
LISTEN 0      1024                     185.208.172.96:3478      0.0.0.0:*    users:(("turnserver",pid=436,fd=47))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             
-- how coturn is configured (no credentials printed) --
listening-port=3478
lt-cred-mech
realm=chat.akosalman.com
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
lines coturn logged at all: 1
-- what happened, counted --
-- the most recent few, addresses removed --

### every call, oldest first

### how they ended

### what ICE managed, counted
ans=0 : 0
ans=1 : 0
turn=0 : 0
turn=1 : 0
srflx=0 : 0
relay=0 : 0

(ssh exit 0)
```
