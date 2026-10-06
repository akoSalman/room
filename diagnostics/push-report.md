# Push report — bistbarg

Generated 2026-10-06T20:20Z by .github/workflows/push-report.yml

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
users who have sent a message in the last 7 days: 14
…of those, how many have NO push token:
8

### EVERY DEVICE, as it last registered
# keepalive=blocked -> that phone's foreground service is off for
#                      good on its build: its socket dies when the
#                      app closes, and no notification code helps.
# A phone on an old build has none of the app-side fixes.
[device] user=1 build=373 keepalive=running state=background received=45 msgs=792 raised=792 skipped=2803 renders=781 rows=22161 why=read-elsewhere failed=0
[device] user=11 build=339 keepalive=running state=background received=17 msgs=12 raised=12 skipped=275 renders=? rows=? why=mine failed=0
[device] user=15 build=339 keepalive=running state=background received=3 msgs=59 raised=59 skipped=127 renders=? rows=? why=app-active failed=0
[device] user=16 build=339 keepalive=running state=background received=0 msgs=8 raised=8 skipped=2 renders=? rows=? why=mine failed=0
[device] user=6 build=373 keepalive=running state=background received=14 msgs=14 raised=12 skipped=2573 renders=260 rows=6345 why=read-elsewhere failed=0
[device] user=8 build=? keepalive=unknown provider=fcm
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
Oct 06 18:23:12 srv5524755161 node[86847]: [presence] connect user=1 sockets=1
Oct 06 19:14:25 srv5524755161 node[86847]: [presence] connect user=1 sockets=2
Oct 06 19:14:50 srv5524755161 node[86847]: [presence] connect user=6 sockets=1
Oct 06 19:14:50 srv5524755161 node[86847]: [presence] disconnect user=6 held=0s reason=forced-server-close sockets=0
Oct 06 19:14:51 srv5524755161 node[86847]: [presence] connect user=6 sockets=1
Oct 06 19:18:34 srv5524755161 node[86847]: [presence] disconnect user=1 held=249s reason=transport-close sockets=1
Oct 06 19:19:31 srv5524755161 node[86847]: [presence] connect user=1 sockets=2
Oct 06 19:19:42 srv5524755161 node[86847]: [presence] disconnect user=1 held=11s reason=transport-close sockets=1
Oct 06 19:19:59 srv5524755161 node[86847]: [presence] connect user=1 sockets=2
Oct 06 19:20:08 srv5524755161 node[86847]: [presence] disconnect user=1 held=8s reason=transport-close sockets=1
Oct 06 19:20:33 srv5524755161 node[86847]: [presence] disconnect user=6 held=342s reason=transport-close sockets=0
Oct 06 19:26:01 srv5524755161 node[90497]: [presence] connect user=1 sockets=1
Oct 06 19:26:45 srv5524755161 node[90497]: [presence] disconnect user=1 held=44s reason=ping-timeout sockets=0
Oct 06 19:29:43 srv5524755161 node[90497]: [presence] connect user=1 sockets=1
Oct 06 19:31:33 srv5524755161 node[90497]: [presence] disconnect user=1 held=110s reason=ping-timeout sockets=0
Oct 06 20:02:15 srv5524755161 node[90497]: [presence] connect user=1 sockets=1
Oct 06 20:02:28 srv5524755161 node[90497]: [presence] disconnect user=1 held=13s reason=transport-close sockets=0
Oct 06 20:06:33 srv5524755161 node[90497]: [presence] connect user=1 sockets=1
Oct 06 20:15:05 srv5524755161 node[90497]: [presence] connect user=1 sockets=2
Oct 06 20:16:07 srv5524755161 node[90497]: [presence] disconnect user=1 held=63s reason=transport-close sockets=1
Oct 06 20:16:25 srv5524755161 node[90497]: [presence] connect user=1 sockets=2
Oct 06 20:17:21 srv5524755161 node[90497]: [presence] disconnect user=1 held=56s reason=transport-close sockets=1
(end of presence lines)

### what the service logged about push, last 2 hours
Oct 06 18:23:10 srv5524755161 node[86847]: [FCM] Loaded service account for project "room-f621b" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Oct 06 19:14:34 srv5524755161 node[86847]: [push] 1 device(s) for 1 user(s) [6] — auth 494ms, send 458ms
Oct 06 19:14:37 srv5524755161 node[86847]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 153ms
Oct 06 19:14:58 srv5524755161 node[86847]: [push] msg 12416 room 6: suppressed for 1 viewer(s) [1]
Oct 06 19:15:05 srv5524755161 node[86847]: [push] msg 12417 room 6: suppressed for 1 viewer(s) [1]
Oct 06 19:15:15 srv5524755161 node[86847]: [push] msg 12418 room 6: suppressed for 1 viewer(s) [6]
Oct 06 19:15:20 srv5524755161 node[86847]: [push] msg 12419 room 6: suppressed for 1 viewer(s) [1]
Oct 06 19:15:22 srv5524755161 node[86847]: [push] msg 12420 room 6: suppressed for 1 viewer(s) [6]
Oct 06 19:15:39 srv5524755161 node[86847]: [push] msg 12421 room 6: suppressed for 1 viewer(s) [1]
Oct 06 19:16:00 srv5524755161 node[86847]: [push] msg 12422 room 6: suppressed for 1 viewer(s) [6]
Oct 06 19:16:19 srv5524755161 node[86847]: [push] msg 12423 room 6: suppressed for 1 viewer(s) [1]
Oct 06 19:16:26 srv5524755161 node[86847]: [push] msg 12424 room 6: suppressed for 1 viewer(s) [6]
Oct 06 19:16:40 srv5524755161 node[86847]: [push] msg 12425 room 6: suppressed for 1 viewer(s) [1]
Oct 06 19:16:46 srv5524755161 node[86847]: [push] msg 12426 room 6: suppressed for 1 viewer(s) [6]
Oct 06 19:17:15 srv5524755161 node[86847]: [push] msg 12427 room 6: suppressed for 1 viewer(s) [1]
Oct 06 19:17:28 srv5524755161 node[86847]: [push] msg 12428 room 6: suppressed for 1 viewer(s) [6]
Oct 06 19:17:33 srv5524755161 node[86847]: [push] msg 12429 room 6: suppressed for 1 viewer(s) [6]
Oct 06 19:17:39 srv5524755161 node[86847]: [push] msg 12430 room 6: suppressed for 1 viewer(s) [1]
Oct 06 19:17:42 srv5524755161 node[86847]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 485ms
Oct 06 19:18:17 srv5524755161 node[86847]: [push] msg 12433 room 6: suppressed for 1 viewer(s) [6]
Oct 06 19:18:25 srv5524755161 node[86847]: [push] msg 12434 room 6: suppressed for 1 viewer(s) [6]
Oct 06 19:18:31 srv5524755161 node[86847]: [push] msg 12435 room 6: suppressed for 1 viewer(s) [1]
Oct 06 19:26:00 srv5524755161 node[90497]: [FCM] Loaded service account for project "room-f621b" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Oct 06 20:15:11 srv5524755161 node[90497]: [push] 1 device(s) for 1 user(s) [6] — auth 562ms, send 457ms
Oct 06 20:15:53 srv5524755161 node[90497]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 410ms
(end of push log lines)

### FCM credentials present?
Oct 06 18:23:10 srv5524755161 node[86847]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Oct 06 19:26:00 srv5524755161 node[90497]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
