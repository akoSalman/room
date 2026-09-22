# Push report — bistbarg

Generated 2026-09-22T20:02Z by .github/workflows/push-report.yml

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

### EVERY DEVICE, as it last registered
# keepalive=blocked -> that phone's foreground service is off for
#                      good on its build: its socket dies when the
#                      app closes, and no notification code helps.
# A phone on an old build has none of the app-side fixes.
[device] user=1 build=327 keepalive=running state=background received=0 msgs=0 raised=0 skipped=0 failed=0
[device] user=13 build=? keepalive=unknown provider=fcm
[device] user=15 build=? keepalive=unknown provider=fcm
[device] user=6 build=325 keepalive=running state=background received=0 msgs=0 raised=0 skipped=0 failed=0
(end of device lines)

### DOES THE SOCKET SURVIVE THE APP CLOSING, last 2 hours
# reason=ping-timeout  -> the app stopped answering; its JS is frozen
#                         or dead and the foreground service is not
#                         keeping it alive. Notification code is
#                         irrelevant until that is fixed.
# reason=transport-close -> the connection itself went (network, or
#                         the process killed outright).
# held=Ns              -> how long it lasted. Compare with when the
#                         app was closed.
Sep 22 19:15:51 srv5524755161 node[2816635]: [presence] connect user=15 sockets=1
Sep 22 19:15:52 srv5524755161 node[2816635]: [presence] disconnect user=15 held=0s reason=forced-server-close sockets=0
Sep 22 19:15:53 srv5524755161 node[2816635]: [presence] connect user=15 sockets=1
Sep 22 19:16:08 srv5524755161 node[2816635]: [presence] disconnect user=15 held=15s reason=transport-close sockets=0
Sep 22 19:16:15 srv5524755161 node[2816635]: [presence] connect user=15 sockets=1
Sep 22 19:25:20 srv5524755161 node[2816635]: [presence] connect user=13 sockets=1
Sep 22 19:25:20 srv5524755161 node[2816635]: [presence] connect user=13 sockets=2
Sep 22 19:25:20 srv5524755161 node[2816635]: [presence] connect user=13 sockets=3
Sep 22 19:25:21 srv5524755161 node[2816635]: [presence] connect user=13 sockets=4
Sep 22 19:25:21 srv5524755161 node[2816635]: [presence] connect user=13 sockets=5
Sep 22 19:25:22 srv5524755161 node[2816635]: [presence] connect user=13 sockets=6
Sep 22 19:25:50 srv5524755161 node[2816635]: [presence] disconnect user=13 held=30s reason=transport-close sockets=5
Sep 22 19:25:50 srv5524755161 node[2816635]: [presence] disconnect user=13 held=30s reason=transport-close sockets=4
Sep 22 19:25:50 srv5524755161 node[2816635]: [presence] disconnect user=13 held=30s reason=transport-close sockets=3
Sep 22 19:25:50 srv5524755161 node[2816635]: [presence] disconnect user=13 held=29s reason=transport-close sockets=2
Sep 22 19:25:50 srv5524755161 node[2816635]: [presence] disconnect user=13 held=29s reason=transport-close sockets=1
Sep 22 19:25:50 srv5524755161 node[2816635]: [presence] disconnect user=13 held=28s reason=transport-close sockets=0
Sep 22 19:28:11 srv5524755161 node[2816635]: [presence] connect user=6 sockets=1
Sep 22 19:30:08 srv5524755161 node[2816635]: [presence] disconnect user=6 held=117s reason=transport-close sockets=0
Sep 22 19:30:29 srv5524755161 node[2816635]: [presence] connect user=3 sockets=1
Sep 22 19:30:55 srv5524755161 node[2816635]: [presence] disconnect user=3 held=26s reason=transport-close sockets=0
Sep 22 19:33:20 srv5524755161 node[2816635]: [presence] connect user=3 sockets=1
Sep 22 19:33:31 srv5524755161 node[2816635]: [presence] connect user=6 sockets=1
Sep 22 19:33:51 srv5524755161 node[2816635]: [presence] disconnect user=6 held=20s reason=transport-close sockets=0
Sep 22 19:34:12 srv5524755161 node[2816635]: [presence] disconnect user=3 held=52s reason=transport-close sockets=0
Sep 22 19:34:32 srv5524755161 node[2816635]: [presence] disconnect user=15 held=1098s reason=transport-close sockets=0
Sep 22 19:36:14 srv5524755161 node[2816635]: [presence] connect user=3 sockets=1
Sep 22 19:36:45 srv5524755161 node[2816635]: [presence] disconnect user=3 held=32s reason=transport-close sockets=0
Sep 22 19:49:46 srv5524755161 node[2816635]: [presence] connect user=3 sockets=1
Sep 22 19:50:24 srv5524755161 node[2816635]: [presence] disconnect user=3 held=39s reason=transport-close sockets=0
Sep 22 19:51:11 srv5524755161 node[2816635]: [presence] connect user=6 sockets=1
Sep 22 19:59:01 srv5524755161 node[2816635]: [presence] disconnect user=6 held=470s reason=transport-close sockets=0
Sep 22 19:59:30 srv5524755161 node[2816635]: [presence] disconnect user=1 held=2818s reason=transport-close sockets=0
Sep 22 19:59:54 srv5524755161 node[2816635]: [presence] connect user=1 sockets=1
Sep 22 20:00:11 srv5524755161 node[2816635]: [presence] connect user=6 sockets=1
Sep 22 20:00:24 srv5524755161 node[2816635]: [presence] disconnect user=6 held=13s reason=transport-close sockets=0
Sep 22 20:00:37 srv5524755161 node[2816635]: [presence] disconnect user=1 held=43s reason=transport-close sockets=0
Sep 22 20:00:41 srv5524755161 node[2816635]: [presence] connect user=3 sockets=1
Sep 22 20:01:00 srv5524755161 node[2816635]: [presence] connect user=1 sockets=1
Sep 22 20:01:33 srv5524755161 node[2816635]: [presence] disconnect user=3 held=52s reason=transport-close sockets=0
(end of presence lines)

### what the service logged about push, last 2 hours
Sep 22 19:57:25 srv5524755161 node[2816635]: [push] msg 8239 room 6: suppressed for 1 viewer(s) [1]
Sep 22 19:57:46 srv5524755161 node[2816635]: [push] msg 8240 room 6: suppressed for 1 viewer(s) [6]
Sep 22 19:57:57 srv5524755161 node[2816635]: [push] msg 8241 room 6: suppressed for 1 viewer(s) [6]
Sep 22 19:58:03 srv5524755161 node[2816635]: [push] msg 8242 room 6: suppressed for 1 viewer(s) [6]
Sep 22 19:58:13 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 446ms
Sep 22 19:58:23 srv5524755161 node[2816635]: [push] msg 8244 room 6: suppressed for 1 viewer(s) [6]
Sep 22 20:00:42 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 8ms, send 574ms
Sep 22 20:00:42 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 17ms, send 578ms
Sep 22 20:00:42 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 598ms
Sep 22 20:00:42 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 436ms
Sep 22 20:00:42 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 392ms
Sep 22 20:00:42 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 13ms, send 416ms
Sep 22 20:00:42 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 135ms
Sep 22 20:00:42 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 5ms, send 135ms
Sep 22 20:00:44 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 149ms
Sep 22 20:00:44 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 176ms
Sep 22 20:00:45 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 152ms
Sep 22 20:00:45 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 173ms
Sep 22 20:00:52 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 423ms
Sep 22 20:00:52 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 396ms
Sep 22 20:00:52 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 174ms
Sep 22 20:00:52 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 459ms
Sep 22 20:00:52 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 219ms
Sep 22 20:00:52 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 229ms
Sep 22 20:01:04 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 561ms
Sep 22 20:01:04 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 462ms
Sep 22 20:01:04 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 461ms
Sep 22 20:01:04 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 407ms
Sep 22 20:01:05 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 334ms
Sep 22 20:01:07 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 156ms
Sep 22 20:01:07 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 180ms
Sep 22 20:01:08 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 142ms
Sep 22 20:01:08 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 196ms
Sep 22 20:01:08 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 177ms
Sep 22 20:01:08 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 190ms
Sep 22 20:01:09 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 167ms
Sep 22 20:01:09 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 1186ms
Sep 22 20:01:09 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 198ms
Sep 22 20:01:09 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 153ms
Sep 22 20:01:11 srv5524755161 node[2816635]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 1673ms
(end of push log lines)

### FCM credentials present?
Sep 22 17:11:32 srv5524755161 node[2815606]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Sep 22 17:18:12 srv5524755161 node[2816635]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
