# Push report — bistbarg

Generated 2026-09-22T10:51Z by .github/workflows/push-report.yml

```
Warning: Permanently added '185.8.174.198' (ED25519) to the list of known hosts.
### code actually running on this server
git HEAD (STALE — deploy is scp, not git): 41b70e7
server.js sends the collapse key (burst fix): yes
server.js puts the tag in the DATA payload (expo reads only this): yes
notify.js has the FIXED rule (no bare-404 delete): yes
server.js logs [push] lines: yes

### push_tokens table
db file found: /opt/chatroom-chat.bistbarg.com/chat.db
total rows: 6
rows per user (user_id, count, shortest/longest token length):
1|1|142|142
6|1|142|142
8|1|142|142
11|1|142|142
13|1|142|142
15|1|142|142
users who have sent a message in the last 7 days: 13
…of those, how many have NO push token:
7

### DOES THE SOCKET SURVIVE THE APP CLOSING, last 2 hours
# reason=ping-timeout  -> the app stopped answering; its JS is frozen
#                         or dead and the foreground service is not
#                         keeping it alive. Notification code is
#                         irrelevant until that is fixed.
# reason=transport-close -> the connection itself went (network, or
#                         the process killed outright).
# held=Ns              -> how long it lasted. Compare with when the
#                         app was closed.
Sep 22 10:39:51 srv5524755161 node[2776560]: [presence] connect user=6 sockets=18
Sep 22 10:39:51 srv5524755161 node[2776560]: [presence] connect user=6 sockets=19
Sep 22 10:39:51 srv5524755161 node[2776560]: [presence] connect user=6 sockets=20
Sep 22 10:39:51 srv5524755161 node[2776560]: [presence] connect user=6 sockets=21
Sep 22 10:39:51 srv5524755161 node[2776560]: [presence] connect user=6 sockets=22
Sep 22 10:39:51 srv5524755161 node[2776560]: [presence] connect user=6 sockets=23
Sep 22 10:39:51 srv5524755161 node[2776560]: [presence] connect user=6 sockets=24
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=23
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=7s reason=transport-close sockets=22
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=21
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=20
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=7s reason=transport-close sockets=19
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=9s reason=transport-close sockets=18
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=17
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=9s reason=transport-close sockets=16
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=9s reason=transport-close sockets=15
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=14
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=13
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=9s reason=transport-close sockets=12
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=11
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=10
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=9s reason=transport-close sockets=9
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=8
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=7s reason=transport-close sockets=7
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=6
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=9s reason=transport-close sockets=5
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=4
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=9s reason=transport-close sockets=3
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=7s reason=transport-close sockets=2
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=8s reason=transport-close sockets=1
Sep 22 10:39:58 srv5524755161 node[2776560]: [presence] disconnect user=6 held=9s reason=transport-close sockets=0
Sep 22 10:48:26 srv5524755161 node[2776560]: [presence] connect user=3 sockets=1
Sep 22 10:48:45 srv5524755161 node[2776560]: [presence] disconnect user=1 held=541s reason=transport-close sockets=0
Sep 22 10:49:02 srv5524755161 node[2776560]: [presence] connect user=3 sockets=2
Sep 22 10:49:05 srv5524755161 node[2776560]: [presence] connect user=1 sockets=1
Sep 22 10:49:11 srv5524755161 node[2776560]: [presence] disconnect user=1 held=5s reason=transport-close sockets=0
Sep 22 10:49:11 srv5524755161 node[2776560]: [presence] disconnect user=3 held=45s reason=ping-timeout sockets=1
Sep 22 10:49:32 srv5524755161 node[2776560]: [presence] connect user=1 sockets=1
Sep 22 10:50:42 srv5524755161 node[2776560]: [presence] disconnect user=3 held=100s reason=transport-close sockets=0
Sep 22 10:51:17 srv5524755161 node[2776560]: [presence] connect user=3 sockets=1
(end of presence lines)

### what the service logged about push, last 2 hours
Sep 22 10:49:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 160ms
Sep 22 10:49:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 236ms
Sep 22 10:49:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 163ms
Sep 22 10:49:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 158ms
Sep 22 10:49:26 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 158ms
Sep 22 10:49:26 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 139ms
Sep 22 10:49:26 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 171ms
Sep 22 10:49:26 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 162ms
Sep 22 10:49:27 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 7ms, send 178ms
Sep 22 10:49:27 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 178ms
Sep 22 10:49:27 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 163ms
Sep 22 10:49:27 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 153ms
Sep 22 10:49:28 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 157ms
Sep 22 10:49:28 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 184ms
Sep 22 10:50:20 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 433ms
Sep 22 10:50:21 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 425ms
Sep 22 10:50:21 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 170ms
Sep 22 10:50:21 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 146ms
Sep 22 10:50:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 18ms, send 187ms
Sep 22 10:50:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 212ms
Sep 22 10:50:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 9ms, send 528ms
Sep 22 10:50:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 4ms, send 531ms
Sep 22 10:50:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 27ms, send 656ms
Sep 22 10:50:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 20ms, send 680ms
Sep 22 10:50:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 7ms, send 770ms
Sep 22 10:50:25 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 11ms, send 774ms
Sep 22 10:50:26 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 49ms, send 893ms
Sep 22 10:50:26 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 43ms, send 972ms
Sep 22 10:50:26 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 39ms, send 1027ms
Sep 22 10:50:26 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 33ms, send 1046ms
Sep 22 10:50:26 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 29ms, send 1132ms
Sep 22 10:51:18 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 410ms
Sep 22 10:51:18 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 428ms
Sep 22 10:51:18 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 161ms
Sep 22 10:51:19 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 430ms
Sep 22 10:51:19 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 150ms
Sep 22 10:51:19 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 166ms
Sep 22 10:51:19 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 195ms
Sep 22 10:51:19 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 163ms
Sep 22 10:51:20 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 171ms
(end of push log lines)

### FCM credentials present?
Sep 22 08:45:11 srv5524755161 node[2762713]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Sep 22 10:33:07 srv5524755161 node[2776560]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
