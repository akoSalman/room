# Push report — bistbarg

Generated 2026-09-22T10:19Z by .github/workflows/push-report.yml

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
Sep 22 09:56:02 srv5524755161 node[2762713]: [presence] connect user=1 sockets=1
Sep 22 09:56:29 srv5524755161 node[2762713]: [presence] connect user=13 sockets=2
Sep 22 09:56:30 srv5524755161 node[2762713]: [presence] disconnect user=13 held=57s reason=transport-close sockets=1
Sep 22 09:56:33 srv5524755161 node[2762713]: [presence] disconnect user=13 held=4s reason=transport-close sockets=0
Sep 22 09:56:37 srv5524755161 node[2762713]: [presence] connect user=13 sockets=1
Sep 22 09:56:41 srv5524755161 node[2762713]: [presence] disconnect user=13 held=4s reason=transport-close sockets=0
Sep 22 10:02:16 srv5524755161 node[2762713]: [presence] connect user=11 sockets=1
Sep 22 10:02:16 srv5524755161 node[2762713]: [presence] connect user=11 sockets=2
Sep 22 10:02:16 srv5524755161 node[2762713]: [presence] connect user=11 sockets=3
Sep 22 10:03:00 srv5524755161 node[2762713]: [presence] disconnect user=11 held=44s reason=ping-timeout sockets=2
Sep 22 10:03:00 srv5524755161 node[2762713]: [presence] disconnect user=11 held=45s reason=ping-timeout sockets=1
Sep 22 10:03:00 srv5524755161 node[2762713]: [presence] disconnect user=11 held=44s reason=ping-timeout sockets=0
Sep 22 10:11:55 srv5524755161 node[2762713]: [presence] connect user=13 sockets=1
Sep 22 10:11:55 srv5524755161 node[2762713]: [presence] connect user=13 sockets=2
Sep 22 10:11:55 srv5524755161 node[2762713]: [presence] connect user=13 sockets=3
Sep 22 10:11:55 srv5524755161 node[2762713]: [presence] connect user=13 sockets=4
Sep 22 10:11:57 srv5524755161 node[2762713]: [presence] connect user=13 sockets=5
Sep 22 10:11:57 srv5524755161 node[2762713]: [presence] connect user=13 sockets=6
Sep 22 10:12:42 srv5524755161 node[2762713]: [presence] connect user=13 sockets=7
Sep 22 10:12:42 srv5524755161 node[2762713]: [presence] connect user=13 sockets=8
Sep 22 10:12:42 srv5524755161 node[2762713]: [presence] connect user=13 sockets=9
Sep 22 10:12:42 srv5524755161 node[2762713]: [presence] connect user=13 sockets=10
Sep 22 10:12:42 srv5524755161 node[2762713]: [presence] connect user=13 sockets=11
Sep 22 10:12:42 srv5524755161 node[2762713]: [presence] connect user=13 sockets=12
Sep 22 10:12:43 srv5524755161 node[2762713]: [presence] disconnect user=13 held=46s reason=transport-close sockets=11
Sep 22 10:12:45 srv5524755161 node[2762713]: [presence] disconnect user=13 held=50s reason=transport-close sockets=10
Sep 22 10:12:45 srv5524755161 node[2762713]: [presence] disconnect user=13 held=50s reason=transport-close sockets=9
Sep 22 10:12:45 srv5524755161 node[2762713]: [presence] disconnect user=13 held=50s reason=transport-close sockets=8
Sep 22 10:12:46 srv5524755161 node[2762713]: [presence] disconnect user=13 held=50s reason=transport-close sockets=7
Sep 22 10:12:47 srv5524755161 node[2762713]: [presence] disconnect user=13 held=49s reason=transport-close sockets=6
Sep 22 10:14:17 srv5524755161 node[2762713]: [presence] disconnect user=13 held=95s reason=transport-close sockets=5
Sep 22 10:14:17 srv5524755161 node[2762713]: [presence] disconnect user=13 held=95s reason=transport-close sockets=4
Sep 22 10:14:17 srv5524755161 node[2762713]: [presence] disconnect user=13 held=95s reason=transport-close sockets=3
Sep 22 10:14:17 srv5524755161 node[2762713]: [presence] disconnect user=13 held=95s reason=transport-close sockets=2
Sep 22 10:14:17 srv5524755161 node[2762713]: [presence] disconnect user=13 held=95s reason=transport-close sockets=1
Sep 22 10:14:17 srv5524755161 node[2762713]: [presence] disconnect user=13 held=95s reason=transport-close sockets=0
Sep 22 10:16:17 srv5524755161 node[2762713]: [presence] disconnect user=1 held=1215s reason=transport-close sockets=0
Sep 22 10:16:29 srv5524755161 node[2762713]: [presence] connect user=3 sockets=1
Sep 22 10:16:56 srv5524755161 node[2762713]: [presence] disconnect user=3 held=28s reason=transport-close sockets=0
Sep 22 10:17:48 srv5524755161 node[2762713]: [presence] connect user=1 sockets=1
(end of presence lines)

### what the service logged about push, last 2 hours
Sep 22 09:15:05 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 169ms
Sep 22 09:15:05 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 173ms
Sep 22 09:15:05 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 156ms
Sep 22 09:15:05 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 3808ms
Sep 22 09:15:05 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 146ms
Sep 22 09:15:05 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 171ms
Sep 22 09:15:06 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 165ms
Sep 22 09:15:06 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 187ms
Sep 22 09:15:06 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 156ms
Sep 22 09:15:06 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 143ms
Sep 22 09:15:07 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 1069ms
Sep 22 09:15:11 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 5167ms
Sep 22 09:19:40 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 5ms, send 395ms
Sep 22 09:20:25 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 423ms
Sep 22 09:21:11 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 6ms, send 394ms
Sep 22 09:31:38 srv5524755161 node[2762713]: [push] 2 device(s) for 3 user(s) [1,12,13] — auth 1ms, send 605ms
Sep 22 09:36:11 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 447ms
Sep 22 09:46:14 srv5524755161 node[2762713]: [push] 2 device(s) for 3 user(s) [1,11,12] — auth 452ms, send 429ms
Sep 22 09:47:29 srv5524755161 node[2762713]: [push] 2 device(s) for 3 user(s) [1,12,13] — auth 1ms, send 568ms
Sep 22 09:48:33 srv5524755161 node[2762713]: [push] msg 7899 room 18: suppressed for 1 viewer(s) [11]
Sep 22 09:48:33 srv5524755161 node[2762713]: [push] 1 device(s) for 2 user(s) [1,12] — auth 0ms, send 463ms
Sep 22 09:48:57 srv5524755161 node[2762713]: [push] 2 device(s) for 3 user(s) [1,11,12] — auth 2ms, send 483ms
Sep 22 09:49:15 srv5524755161 node[2762713]: [push] 2 device(s) for 3 user(s) [1,11,12] — auth 1ms, send 506ms
Sep 22 09:53:58 srv5524755161 node[2762713]: [push] 2 device(s) for 3 user(s) [11,12,13] — auth 1ms, send 497ms
Sep 22 09:54:35 srv5524755161 node[2762713]: [push] 2 device(s) for 3 user(s) [1,11,12] — auth 1ms, send 543ms
Sep 22 10:02:13 srv5524755161 node[2762713]: [push] 2 device(s) for 3 user(s) [11,12,13] — auth 1ms, send 548ms
Sep 22 10:02:25 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [15] — auth 1ms, send 450ms
Sep 22 10:02:45 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [15] — auth 0ms, send 402ms
Sep 22 10:03:08 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 392ms
Sep 22 10:03:13 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [6] — auth 1ms, send 495ms
Sep 22 10:03:16 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [6] — auth 1ms, send 160ms
Sep 22 10:03:19 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 167ms
Sep 22 10:05:16 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [15] — auth 0ms, send 421ms
Sep 22 10:12:38 srv5524755161 node[2762713]: [push] 2 device(s) for 3 user(s) [1,11,12] — auth 1ms, send 525ms
Sep 22 10:16:32 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 438ms
Sep 22 10:16:32 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 419ms
Sep 22 10:16:32 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 182ms
Sep 22 10:16:32 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 179ms
Sep 22 10:16:32 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 174ms
Sep 22 10:16:34 srv5524755161 node[2762713]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 2024ms
(end of push log lines)

### FCM credentials present?
Sep 22 08:23:16 srv5524755161 node[2759254]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Sep 22 08:45:11 srv5524755161 node[2762713]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
