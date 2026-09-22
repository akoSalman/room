# Push report — bistbarg

Generated 2026-09-22T22:44Z by .github/workflows/push-report.yml

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
[device] user=1 build=334 keepalive=blocked state=background received=0 msgs=22 raised=21 skipped=1 why=mine failed=0
[device] user=11 build=? keepalive=unknown provider=fcm
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
Sep 22 20:53:30 srv5524755161 node[2816635]: [presence] disconnect user=1 held=1923s reason=transport-close sockets=0
Sep 22 20:53:54 srv5524755161 node[2816635]: [presence] connect user=1 sockets=1
Sep 22 20:54:18 srv5524755161 node[2816635]: [presence] connect user=3 sockets=1
Sep 22 20:54:31 srv5524755161 node[2816635]: [presence] disconnect user=1 held=37s reason=transport-close sockets=0
Sep 22 20:54:49 srv5524755161 node[2816635]: [presence] disconnect user=3 held=31s reason=transport-close sockets=0
Sep 22 21:07:40 srv5524755161 node[2816635]: [presence] connect user=1 sockets=1
Sep 22 21:18:45 srv5524755161 node[2816635]: [presence] disconnect user=1 held=665s reason=ping-timeout sockets=0
Sep 22 21:19:10 srv5524755161 node[2816635]: [presence] connect user=1 sockets=1
Sep 22 21:28:59 srv5524755161 node[2816635]: [presence] connect user=3 sockets=1
Sep 22 21:29:22 srv5524755161 node[2816635]: [presence] disconnect user=1 held=612s reason=transport-close sockets=0
Sep 22 21:29:55 srv5524755161 node[2816635]: [presence] disconnect user=3 held=57s reason=transport-close sockets=0
Sep 22 21:30:29 srv5524755161 node[2816635]: [presence] connect user=1 sockets=1
Sep 22 21:40:25 srv5524755161 node[2816635]: [presence] connect user=3 sockets=1
Sep 22 21:40:30 srv5524755161 node[2816635]: [presence] disconnect user=3 held=5s reason=transport-close sockets=0
Sep 22 21:51:27 srv5524755161 node[2816635]: [presence] connect user=3 sockets=1
Sep 22 21:51:54 srv5524755161 node[2816635]: [presence] disconnect user=3 held=27s reason=transport-close sockets=0
Sep 22 21:52:39 srv5524755161 node[2816635]: [presence] connect user=3 sockets=1
Sep 22 21:52:44 srv5524755161 node[2816635]: [presence] disconnect user=3 held=5s reason=transport-close sockets=0
Sep 22 22:01:21 srv5524755161 node[2846232]: [presence] connect user=1 sockets=1
Sep 22 22:05:06 srv5524755161 node[2846232]: [presence] disconnect user=1 held=225s reason=ping-timeout sockets=0
Sep 22 22:05:37 srv5524755161 node[2846232]: [presence] connect user=1 sockets=1
Sep 22 22:37:24 srv5524755161 node[2846232]: [presence] disconnect user=1 held=1907s reason=transport-close sockets=0
Sep 22 22:37:51 srv5524755161 node[2846232]: [presence] connect user=1 sockets=1
Sep 22 22:38:28 srv5524755161 node[2846232]: [presence] connect user=3 sockets=1
Sep 22 22:38:41 srv5524755161 node[2846232]: [presence] disconnect user=1 held=50s reason=transport-close sockets=0
Sep 22 22:38:58 srv5524755161 node[2846232]: [presence] connect user=1 sockets=1
Sep 22 22:39:04 srv5524755161 node[2846232]: [presence] disconnect user=1 held=7s reason=transport-close sockets=0
Sep 22 22:39:20 srv5524755161 node[2846232]: [presence] connect user=1 sockets=1
Sep 22 22:39:46 srv5524755161 node[2846232]: [presence] disconnect user=1 held=27s reason=transport-close sockets=0
Sep 22 22:39:53 srv5524755161 node[2846232]: [presence] connect user=1 sockets=1
Sep 22 22:39:57 srv5524755161 node[2846232]: [presence] disconnect user=1 held=4s reason=transport-close sockets=0
Sep 22 22:40:11 srv5524755161 node[2846232]: [presence] connect user=1 sockets=1
Sep 22 22:40:56 srv5524755161 node[2846232]: [presence] disconnect user=1 held=45s reason=transport-close sockets=0
Sep 22 22:41:54 srv5524755161 node[2846232]: [presence] connect user=1 sockets=1
Sep 22 22:42:05 srv5524755161 node[2846232]: [presence] disconnect user=3 held=217s reason=transport-close sockets=0
(end of presence lines)

### what the service logged about push, last 2 hours
Sep 22 22:38:48 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 161ms
Sep 22 22:38:49 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 151ms
Sep 22 22:39:08 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 432ms
Sep 22 22:39:08 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 375ms
Sep 22 22:39:09 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 176ms
Sep 22 22:39:10 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 159ms
Sep 22 22:39:49 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 412ms
Sep 22 22:39:49 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 429ms
Sep 22 22:39:50 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 167ms
Sep 22 22:40:00 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 413ms
Sep 22 22:40:00 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 422ms
Sep 22 22:40:01 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 128ms
Sep 22 22:40:01 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 133ms
Sep 22 22:40:01 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 129ms
Sep 22 22:40:07 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 374ms
Sep 22 22:40:07 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 134ms
Sep 22 22:40:08 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 135ms
Sep 22 22:40:08 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 145ms
Sep 22 22:40:09 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 124ms
Sep 22 22:40:16 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 403ms
Sep 22 22:40:16 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 428ms
Sep 22 22:40:16 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 159ms
Sep 22 22:41:04 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 429ms
Sep 22 22:41:05 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 407ms
Sep 22 22:41:05 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 165ms
Sep 22 22:41:08 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 145ms
Sep 22 22:41:08 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 154ms
Sep 22 22:41:08 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 179ms
Sep 22 22:41:09 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 174ms
Sep 22 22:41:09 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 168ms
Sep 22 22:41:10 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 194ms
Sep 22 22:41:13 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 185ms
Sep 22 22:41:13 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 174ms
Sep 22 22:41:14 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 148ms
Sep 22 22:41:15 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 160ms
Sep 22 22:41:39 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 7ms, send 415ms
Sep 22 22:41:39 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 377ms
Sep 22 22:41:39 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 145ms
Sep 22 22:41:40 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 164ms
Sep 22 22:41:41 srv5524755161 node[2846232]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 174ms
(end of push log lines)

### FCM credentials present?
Sep 22 17:18:12 srv5524755161 node[2816635]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Sep 22 22:01:21 srv5524755161 node[2846232]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
