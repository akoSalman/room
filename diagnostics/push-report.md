# Push report — bistbarg

Generated 2026-09-22T17:06Z by .github/workflows/push-report.yml

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
[device] user=1 build=319 keepalive=running provider=fcm
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
Sep 22 15:12:25 srv5524755161 node[2776560]: [presence] connect user=3 sockets=1
Sep 22 15:12:59 srv5524755161 node[2776560]: [presence] disconnect user=3 held=34s reason=transport-close sockets=0
Sep 22 15:17:13 srv5524755161 node[2776560]: [presence] disconnect user=15 held=4588s reason=transport-close sockets=0
Sep 22 15:26:43 srv5524755161 node[2776560]: [presence] connect user=3 sockets=1
Sep 22 15:27:06 srv5524755161 node[2776560]: [presence] disconnect user=3 held=23s reason=transport-close sockets=0
Sep 22 15:27:55 srv5524755161 node[2776560]: [presence] connect user=3 sockets=1
Sep 22 15:28:18 srv5524755161 node[2776560]: [presence] disconnect user=3 held=23s reason=transport-close sockets=0
Sep 22 15:43:17 srv5524755161 node[2776560]: [presence] connect user=12 sockets=1
Sep 22 15:44:56 srv5524755161 node[2776560]: [presence] disconnect user=12 held=99s reason=transport-close sockets=0
Sep 22 15:49:25 srv5524755161 node[2776560]: [presence] disconnect user=1 held=8618s reason=ping-timeout sockets=0
Sep 22 15:50:09 srv5524755161 node[2776560]: [presence] connect user=1 sockets=1
Sep 22 15:52:32 srv5524755161 node[2776560]: [presence] connect user=3 sockets=1
Sep 22 15:52:54 srv5524755161 node[2776560]: [presence] disconnect user=3 held=22s reason=transport-close sockets=0
Sep 22 15:55:04 srv5524755161 node[2776560]: [presence] disconnect user=1 held=296s reason=ping-timeout sockets=0
Sep 22 15:55:14 srv5524755161 node[2776560]: [presence] connect user=1 sockets=1
Sep 22 15:56:24 srv5524755161 node[2776560]: [presence] disconnect user=1 held=70s reason=ping-timeout sockets=0
Sep 22 15:59:10 srv5524755161 node[2776560]: [presence] connect user=1 sockets=1
Sep 22 16:02:18 srv5524755161 node[2776560]: [presence] connect user=3 sockets=1
Sep 22 16:02:40 srv5524755161 node[2776560]: [presence] disconnect user=3 held=22s reason=transport-close sockets=0
Sep 22 16:34:03 srv5524755161 node[2776560]: [presence] connect user=6 sockets=1
Sep 22 16:35:04 srv5524755161 node[2776560]: [presence] disconnect user=6 held=61s reason=transport-close sockets=0
Sep 22 16:36:50 srv5524755161 node[2776560]: [presence] connect user=3 sockets=1
Sep 22 16:37:17 srv5524755161 node[2776560]: [presence] disconnect user=3 held=27s reason=transport-close sockets=0
Sep 22 16:43:31 srv5524755161 node[2811942]: [presence] connect user=1 sockets=1
Sep 22 16:44:50 srv5524755161 node[2811942]: [presence] connect user=6 sockets=1
Sep 22 16:46:47 srv5524755161 node[2811942]: [presence] disconnect user=6 held=117s reason=transport-close sockets=0
Sep 22 16:47:26 srv5524755161 node[2811942]: [presence] connect user=6 sockets=1
Sep 22 16:48:01 srv5524755161 node[2811942]: [presence] disconnect user=6 held=34s reason=transport-close sockets=0
Sep 22 16:54:49 srv5524755161 node[2811942]: [presence] disconnect user=1 held=678s reason=ping-timeout sockets=0
Sep 22 16:55:07 srv5524755161 node[2811942]: [presence] connect user=1 sockets=1
Sep 22 17:02:05 srv5524755161 node[2811942]: [presence] connect user=3 sockets=1
Sep 22 17:02:12 srv5524755161 node[2811942]: [presence] disconnect user=3 held=6s reason=transport-close sockets=0
Sep 22 17:04:09 srv5524755161 node[2811942]: [presence] disconnect user=1 held=542s reason=transport-close sockets=0
Sep 22 17:04:25 srv5524755161 node[2811942]: [presence] connect user=1 sockets=1
Sep 22 17:04:46 srv5524755161 node[2811942]: [presence] disconnect user=1 held=21s reason=transport-close sockets=0
Sep 22 17:04:50 srv5524755161 node[2811942]: [presence] connect user=3 sockets=1
Sep 22 17:05:27 srv5524755161 node[2811942]: [presence] connect user=1 sockets=1
Sep 22 17:06:04 srv5524755161 node[2811942]: [presence] disconnect user=3 held=74s reason=transport-close sockets=0
(end of presence lines)

### what the service logged about push, last 2 hours
Sep 22 15:12:31 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 447ms
Sep 22 15:12:37 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 441ms
Sep 22 16:34:19 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 370ms, send 413ms
Sep 22 16:34:43 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 450ms
Sep 22 16:34:54 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 386ms
Sep 22 16:35:31 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 404ms
Sep 22 16:35:32 srv5524755161 node[2776560]: [push] 1 recipient(s) [3] have no device token
Sep 22 16:35:32 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 171ms
Sep 22 16:35:36 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [6] — auth 1ms, send 157ms
Sep 22 16:35:41 srv5524755161 node[2776560]: [push] 1 device(s) for 1 user(s) [6] — auth 1ms, send 422ms
Sep 22 16:43:30 srv5524755161 node[2811942]: [FCM] Loaded service account for project "room-f621b" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Sep 22 16:45:39 srv5524755161 node[2811942]: [push] msg 8108 room 6: suppressed for 1 viewer(s) [1]
Sep 22 16:45:39 srv5524755161 node[2811942]: [push] msg 8109 room 6: suppressed for 1 viewer(s) [1]
Sep 22 16:46:04 srv5524755161 node[2811942]: [push] msg 8110 room 6: suppressed for 1 viewer(s) [1]
Sep 22 16:46:22 srv5524755161 node[2811942]: [push] msg 8111 room 6: suppressed for 1 viewer(s) [1]
Sep 22 16:55:41 srv5524755161 node[2811942]: [push] 1 device(s) for 1 user(s) [6] — auth 371ms, send 441ms
Sep 22 16:55:51 srv5524755161 node[2811942]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 395ms
Sep 22 17:04:55 srv5524755161 node[2811942]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 463ms
Sep 22 17:04:56 srv5524755161 node[2811942]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 161ms
Sep 22 17:04:56 srv5524755161 node[2811942]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 448ms
Sep 22 17:04:56 srv5524755161 node[2811942]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 175ms
Sep 22 17:05:31 srv5524755161 node[2811942]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 406ms
Sep 22 17:05:32 srv5524755161 node[2811942]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 408ms
Sep 22 17:05:32 srv5524755161 node[2811942]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 135ms
Sep 22 17:05:33 srv5524755161 node[2811942]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 156ms
(end of push log lines)

### FCM credentials present?
Sep 22 10:33:07 srv5524755161 node[2776560]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Sep 22 16:43:30 srv5524755161 node[2811942]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
