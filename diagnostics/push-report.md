# Push report — bistbarg

Generated 2026-10-07T10:28Z by .github/workflows/push-report.yml

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
[device] user=1 build=381 keepalive=running state=active received=45 msgs=800 raised=800 skipped=2824 renders=123 rows=1904 shareCap=1 shareSend=1 shareSwap=1 why=read-elsewhere failed=0
[device] user=11 build=339 keepalive=running state=background received=17 msgs=12 raised=12 skipped=275 renders=? rows=? why=mine failed=0
[device] user=15 build=339 keepalive=running state=background received=3 msgs=59 raised=59 skipped=127 renders=? rows=? shareCap=? shareSend=? shareSwap=? why=app-active failed=0
[device] user=16 build=339 keepalive=running state=background received=0 msgs=8 raised=8 skipped=2 renders=? rows=? why=mine failed=0
[device] user=6 build=381 keepalive=running state=background received=20 msgs=15 raised=13 skipped=2592 renders=23 rows=254 shareCap=0 shareSend=0 shareSwap=0 why=read-elsewhere failed=0
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
Oct 07 09:03:18 srv5524755161 node[97865]: [presence] connect user=6 sockets=1
Oct 07 09:03:18 srv5524755161 node[97865]: [presence] disconnect user=6 held=0s reason=forced-server-close sockets=0
Oct 07 09:03:19 srv5524755161 node[97865]: [presence] connect user=6 sockets=1
Oct 07 09:03:31 srv5524755161 node[295773]: [presence] connect user=1 sockets=1
Oct 07 09:03:32 srv5524755161 node[295773]: [presence] connect user=6 sockets=1
Oct 07 09:05:08 srv5524755161 node[295773]: [presence] disconnect user=6 held=95s reason=ping-timeout sockets=0
Oct 07 09:05:57 srv5524755161 node[295773]: [presence] disconnect user=1 held=146s reason=ping-timeout sockets=0
Oct 07 09:06:33 srv5524755161 node[295773]: [presence] connect user=6 sockets=1
Oct 07 09:06:38 srv5524755161 node[295773]: [presence] connect user=1 sockets=1
Oct 07 09:07:14 srv5524755161 node[295773]: [presence] disconnect user=6 held=42s reason=transport-close sockets=0
Oct 07 09:08:28 srv5524755161 node[295773]: [presence] connect user=6 sockets=1
Oct 07 09:08:31 srv5524755161 node[295773]: [presence] disconnect user=6 held=3s reason=transport-close sockets=0
Oct 07 09:08:48 srv5524755161 node[295773]: [presence] connect user=6 sockets=1
Oct 07 09:08:59 srv5524755161 node[295773]: [presence] disconnect user=6 held=11s reason=transport-close sockets=0
Oct 07 09:17:23 srv5524755161 node[295773]: [presence] connect user=6 sockets=1
Oct 07 09:17:26 srv5524755161 node[295773]: [presence] disconnect user=6 held=3s reason=transport-close sockets=0
Oct 07 09:17:36 srv5524755161 node[295773]: [presence] connect user=6 sockets=1
Oct 07 09:17:48 srv5524755161 node[295773]: [presence] disconnect user=6 held=11s reason=transport-close sockets=0
Oct 07 09:18:43 srv5524755161 node[295773]: [presence] disconnect user=1 held=725s reason=ping-timeout sockets=0
Oct 07 09:19:04 srv5524755161 node[295773]: [presence] connect user=1 sockets=1
Oct 07 09:19:49 srv5524755161 node[295773]: [presence] disconnect user=1 held=45s reason=ping-timeout sockets=0
Oct 07 09:20:54 srv5524755161 node[295773]: [presence] connect user=1 sockets=1
Oct 07 09:36:39 srv5524755161 node[295773]: [presence] connect user=6 sockets=1
Oct 07 09:37:26 srv5524755161 node[295773]: [presence] disconnect user=6 held=46s reason=transport-close sockets=0
Oct 07 09:43:14 srv5524755161 node[295773]: [presence] connect user=1 sockets=2
Oct 07 09:43:25 srv5524755161 node[295773]: [presence] disconnect user=1 held=11s reason=transport-close sockets=1
Oct 07 09:48:06 srv5524755161 node[295773]: [presence] connect user=1 sockets=2
Oct 07 09:48:08 srv5524755161 node[295773]: [presence] disconnect user=1 held=2s reason=transport-close sockets=1
Oct 07 10:05:04 srv5524755161 node[295773]: [presence] disconnect user=1 held=2649s reason=ping-timeout sockets=0
Oct 07 10:05:12 srv5524755161 node[295773]: [presence] connect user=1 sockets=1
Oct 07 10:06:48 srv5524755161 node[295773]: [presence] connect user=6 sockets=1
Oct 07 10:06:54 srv5524755161 node[295773]: [presence] disconnect user=6 held=6s reason=transport-close sockets=0
Oct 07 10:07:06 srv5524755161 node[295773]: [presence] connect user=6 sockets=1
Oct 07 10:07:06 srv5524755161 node[295773]: [presence] disconnect user=6 held=0s reason=forced-server-close sockets=0
Oct 07 10:07:07 srv5524755161 node[295773]: [presence] connect user=6 sockets=1
Oct 07 10:07:17 srv5524755161 node[295773]: [presence] disconnect user=6 held=10s reason=transport-close sockets=0
Oct 07 10:25:19 srv5524755161 node[295773]: [presence] connect user=1 sockets=2
Oct 07 10:25:22 srv5524755161 node[295773]: [presence] disconnect user=1 held=3s reason=client-namespace-disconnect sockets=1
Oct 07 10:25:43 srv5524755161 node[295773]: [presence] connect user=3 sockets=1
Oct 07 10:26:59 srv5524755161 node[295773]: [presence] disconnect user=3 held=76s reason=transport-close sockets=0
(end of presence lines)

### what a screen share actually did, last 24 hours
# captured=0            -> Android refused the capture
# captured=1 switched=0 -> the call would not take the track
# captured=1 switched=1 -> the track went in; if the far end
#                          froze, it is the encoder
(end of share lines)

### what the service logged about push, last 2 hours
Oct 07 08:56:02 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [6] — auth 434ms, send 443ms
Oct 07 09:03:25 srv5524755161 node[97865]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 445ms
Oct 07 09:03:31 srv5524755161 node[295773]: [FCM] Loaded service account for project "room-f621b" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Oct 07 09:04:16 srv5524755161 node[295773]: [push] 1 device(s) for 1 user(s) [1] — auth 475ms, send 470ms
Oct 07 09:06:43 srv5524755161 node[295773]: [push] msg 12462 room 6: suppressed for 1 viewer(s) [6]
Oct 07 09:06:56 srv5524755161 node[295773]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 450ms
Oct 07 09:06:57 srv5524755161 node[295773]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 160ms
Oct 07 09:08:27 srv5524755161 node[295773]: [push] 1 device(s) for 1 user(s) [6] — auth 1ms, send 451ms
Oct 07 09:08:53 srv5524755161 node[295773]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 491ms
Oct 07 09:17:21 srv5524755161 node[295773]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 422ms
Oct 07 10:25:51 srv5524755161 node[295773]: [push] 1 device(s) for 1 user(s) [1] — auth 394ms, send 446ms
(end of push log lines)

### FCM credentials present?
Oct 06 21:21:49 srv5524755161 node[97865]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Oct 07 09:03:31 srv5524755161 node[295773]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
