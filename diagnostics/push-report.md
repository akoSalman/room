# Push report — bistbarg

Generated 2026-09-22T08:39Z by .github/workflows/push-report.yml

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
total rows: 5
rows per user (user_id, count, shortest/longest token length):
1|1|142|142
6|1|142|142
8|1|142|142
11|1|142|142
13|1|142|142
users who have sent a message in the last 7 days: 12
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
Sep 22 08:35:25 srv5524755161 node[2759254]: [presence] connect user=1 sockets=1
Sep 22 08:35:25 srv5524755161 node[2759254]: [presence] connect user=1 sockets=1
Sep 22 08:35:25 srv5524755161 node[2759254]: [presence] connect user=1 sockets=1
Sep 22 08:35:30 srv5524755161 node[2759254]: [presence] connect user=3 sockets=1
Sep 22 08:35:43 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:35:44 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:35:44 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:35:44 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:35:44 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:35:44 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:35:44 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:35:51 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=0
Sep 22 08:35:51 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=0
Sep 22 08:35:51 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=0
Sep 22 08:35:51 srv5524755161 node[2759254]: [presence] disconnect user=11 held=8s reason=transport-close sockets=0
Sep 22 08:35:51 srv5524755161 node[2759254]: [presence] disconnect user=11 held=8s reason=transport-close sockets=0
Sep 22 08:35:51 srv5524755161 node[2759254]: [presence] disconnect user=11 held=8s reason=transport-close sockets=0
Sep 22 08:35:51 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=-1
Sep 22 08:36:30 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:36:31 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:36:31 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:36:31 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:36:31 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:36:31 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:36:31 srv5524755161 node[2759254]: [presence] connect user=11 sockets=1
Sep 22 08:36:38 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=0
Sep 22 08:36:38 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=0
Sep 22 08:36:38 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=0
Sep 22 08:36:38 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=-1
Sep 22 08:36:38 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=-1
Sep 22 08:36:38 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=-1
Sep 22 08:36:38 srv5524755161 node[2759254]: [presence] disconnect user=11 held=7s reason=transport-close sockets=-1
Sep 22 08:36:53 srv5524755161 node[2759254]: [presence] disconnect user=1 held=88s reason=transport-close sockets=0
Sep 22 08:36:53 srv5524755161 node[2759254]: [presence] disconnect user=1 held=88s reason=transport-close sockets=0
Sep 22 08:36:53 srv5524755161 node[2759254]: [presence] disconnect user=1 held=88s reason=transport-close sockets=0
Sep 22 08:36:53 srv5524755161 node[2759254]: [presence] disconnect user=1 held=88s reason=transport-close sockets=0
Sep 22 08:36:53 srv5524755161 node[2759254]: [presence] disconnect user=1 held=88s reason=transport-close sockets=-1
Sep 22 08:37:28 srv5524755161 node[2759254]: [presence] disconnect user=3 held=118s reason=transport-close sockets=0
Sep 22 08:38:03 srv5524755161 node[2759254]: [presence] connect user=3 sockets=1
Sep 22 08:38:49 srv5524755161 node[2759254]: [presence] disconnect user=3 held=46s reason=transport-close sockets=0
(end of presence lines)

### what the service logged about push, last 2 hours
Sep 22 08:19:27 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 160ms
Sep 22 08:19:28 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 176ms
Sep 22 08:19:28 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 176ms
Sep 22 08:19:28 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 176ms
Sep 22 08:19:29 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 164ms
Sep 22 08:19:29 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 159ms
Sep 22 08:19:29 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 165ms
Sep 22 08:19:29 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 4ms, send 154ms
Sep 22 08:19:29 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 392ms
Sep 22 08:19:29 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 163ms
Sep 22 08:19:30 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 184ms
Sep 22 08:19:30 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 158ms
Sep 22 08:19:30 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 140ms
Sep 22 08:19:30 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 147ms
Sep 22 08:19:30 srv5524755161 node[2753638]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 143ms
Sep 22 08:23:16 srv5524755161 node[2759254]: [FCM] Loaded service account for project "room-f621b" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Sep 22 08:28:55 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [8] — auth 459ms, send 434ms
Sep 22 08:29:10 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 432ms
Sep 22 08:29:15 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 447ms
Sep 22 08:30:41 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 446ms
Sep 22 08:31:06 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [8] — auth 2ms, send 459ms
Sep 22 08:31:19 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [8] — auth 2ms, send 419ms
Sep 22 08:31:31 srv5524755161 node[2759254]: [push] 2 device(s) for 3 user(s) [11,12,13] — auth 0ms, send 1335ms
Sep 22 08:31:36 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [11] — auth 0ms, send 394ms
Sep 22 08:31:45 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [11] — auth 0ms, send 415ms
Sep 22 08:33:40 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [11] — auth 0ms, send 420ms
Sep 22 08:34:09 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [11] — auth 5ms, send 451ms
Sep 22 08:35:02 srv5524755161 node[2759254]: [push] 2 device(s) for 3 user(s) [1,12,13] — auth 1ms, send 579ms
Sep 22 08:35:42 srv5524755161 node[2759254]: [push] 2 device(s) for 3 user(s) [11,12,13] — auth 1ms, send 523ms
Sep 22 08:36:29 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [11] — auth 1ms, send 415ms
Sep 22 08:36:56 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 474ms
Sep 22 08:37:00 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 154ms
Sep 22 08:37:02 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 166ms
Sep 22 08:38:05 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 442ms
Sep 22 08:38:08 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 158ms
Sep 22 08:38:09 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 164ms
Sep 22 08:38:09 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 454ms
Sep 22 08:38:09 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 181ms
Sep 22 08:38:09 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 401ms
Sep 22 08:38:09 srv5524755161 node[2759254]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 165ms
(end of push log lines)

### FCM credentials present?
Sep 22 07:47:02 srv5524755161 node[2753638]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Sep 22 08:23:16 srv5524755161 node[2759254]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
