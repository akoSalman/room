# Call report — bistbarg

Generated 2026-11-05T09:31Z by .github/workflows/call-report.yml

```
Warning: Permanently added '185.8.174.198' (ED25519) to the list of known hosts.
### is the version that reports this even running here
server logs [call] at all: yes
ICE config offers a relay: yes (if TURN_URL is set in the environment)
TURN_* actually in the service environment: yes

### coturn
active
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=49))                                           
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=48))                                           
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=47))                                           
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=46))                                           
UNCONN 0      0                          185.8.174.198:3478        0.0.0.0:*     users:(("turnserver",pid=930,fd=45))                                           

### every call, oldest first
Nov 05 09:30:53 srv5524755161 node[2957335]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=1 relay=0 ans=0 turn=1
Nov 05 09:30:54 srv5524755161 node[2957335]: [call] user=- outcome=failed kind=dm-voice host=1 srflx=0 relay=0 ans=1 turn=1

### how they ended
      2 outcome=failed

### what ICE managed, counted
ans=0 : 1
ans=1 : 1
turn=0 : 0
turn=1 : 2
srflx=0 : 1
relay=0 : 2

(ssh exit 0)
```
