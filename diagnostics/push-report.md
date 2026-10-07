# Push report — bistbarg

Generated 2026-10-07T08:51Z by .github/workflows/push-report.yml

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
[device] user=1 build=381 keepalive=running state=background received=45 msgs=797 raised=797 skipped=2818 renders=0 rows=0 shareCap=0 shareSend=0 shareSwap=0 why=read-elsewhere failed=0
[device] user=11 build=339 keepalive=running state=background received=17 msgs=12 raised=12 skipped=275 renders=? rows=? why=mine failed=0
[device] user=15 build=339 keepalive=running state=background received=3 msgs=59 raised=59 skipped=127 renders=? rows=? shareCap=? shareSend=? shareSwap=? why=app-active failed=0
[device] user=16 build=339 keepalive=running state=background received=0 msgs=8 raised=8 skipped=2 renders=? rows=? why=mine failed=0
[device] user=6 build=381 keepalive=running state=background received=20 msgs=15 raised=13 skipped=2586 renders=276 rows=7604 shareCap=0 shareSend=0 shareSwap=0 why=read-elsewhere failed=0
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
Oct 07 06:54:40 srv5524755161 node[97865]: [presence] connect user=1 sockets=1
Oct 07 07:01:50 srv5524755161 node[97865]: [presence] connect user=6 sockets=1
Oct 07 07:06:04 srv5524755161 node[97865]: [presence] disconnect user=1 held=684s reason=transport-close sockets=0
Oct 07 07:06:08 srv5524755161 node[97865]: [presence] connect user=1 sockets=1
Oct 07 07:06:41 srv5524755161 node[97865]: [presence] disconnect user=1 held=33s reason=transport-close sockets=0
Oct 07 07:06:44 srv5524755161 node[97865]: [presence] connect user=1 sockets=1
Oct 07 07:31:43 srv5524755161 node[97865]: [presence] disconnect user=1 held=1500s reason=ping-timeout sockets=0
Oct 07 07:32:06 srv5524755161 node[97865]: [presence] connect user=1 sockets=1
Oct 07 07:32:57 srv5524755161 node[97865]: [presence] disconnect user=6 held=1867s reason=transport-close sockets=0
Oct 07 07:35:30 srv5524755161 node[97865]: [presence] connect user=1 sockets=2
Oct 07 07:35:46 srv5524755161 node[97865]: [presence] disconnect user=1 held=220s reason=ping-timeout sockets=1
Oct 07 07:42:21 srv5524755161 node[97865]: [presence] connect user=6 sockets=1
Oct 07 07:42:26 srv5524755161 node[97865]: [presence] disconnect user=6 held=5s reason=transport-close sockets=0
Oct 07 07:57:34 srv5524755161 node[97865]: [presence] disconnect user=1 held=1324s reason=ping-timeout sockets=0
Oct 07 07:57:37 srv5524755161 node[97865]: [presence] connect user=1 sockets=1
Oct 07 08:00:26 srv5524755161 node[97865]: [presence] disconnect user=1 held=169s reason=ping-timeout sockets=0
Oct 07 08:01:27 srv5524755161 node[97865]: [presence] connect user=1 sockets=1
Oct 07 08:23:36 srv5524755161 node[97865]: [presence] connect user=12 sockets=1
Oct 07 08:24:04 srv5524755161 node[97865]: [presence] disconnect user=12 held=28s reason=transport-close sockets=0
(end of presence lines)

### what the service logged about push, last 2 hours
Oct 07 06:55:42 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 1ms, send 447ms
Oct 07 06:55:48 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 401ms
Oct 07 06:56:34 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 473ms
Oct 07 07:02:10 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 434ms
Oct 07 07:03:13 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 441ms
Oct 07 07:03:56 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 425ms
Oct 07 07:04:26 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 439ms
Oct 07 07:05:12 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [1] — auth 3ms, send 443ms
Oct 07 07:05:19 srv5524755161 node[97865]: [push] msg 12452 room 6: suppressed for 1 viewer(s) [1]
Oct 07 07:05:54 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 434ms
Oct 07 07:06:14 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 419ms
Oct 07 07:06:19 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 415ms
Oct 07 07:06:32 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 373ms
Oct 07 07:06:48 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 1ms, send 410ms
Oct 07 07:06:54 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 402ms
Oct 07 07:13:08 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 476ms
(end of push log lines)

### FCM credentials present?
Oct 06 21:02:55 srv5524755161 node[96293]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Oct 06 21:21:49 srv5524755161 node[97865]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
