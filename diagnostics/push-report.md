# Push report — bistbarg

Generated 2026-11-05T12:57Z by .github/workflows/push-report.yml

```
Warning: Permanently added '185.8.174.198' (ED25519) to the list of known hosts.
### code actually running on this server
git HEAD (STALE — deploy is scp, not git): 41b70e7
server.js sends the collapse key (burst fix): yes
server.js puts the tag in the DATA payload (expo reads only this): yes
notify.js has the FIXED rule (no bare-404 delete): yes
server.js logs [push] lines: yes

### WHICH PUSH ROUTE, and is the second one switched on
NAJVA configured in the service environment: NO  <-- FCM is the only route
tokens by provider:
  fcm|6
najva lines in the last 2 hours:
  0

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
users who have sent a message in the last 7 days: 15
…of those, how many have NO push token:
9

### EVERY DEVICE, as it last registered
# keepalive=blocked -> that phone's foreground service is off for
#                      good on its build: its socket dies when the
#                      app closes, and no notification code helps.
# A phone on an old build has none of the app-side fixes.
[device] user=1 build=447 keepalive=running state=background received=95 msgs=1448 raised=1451 skipped=5483 renders=119 rows=814 shareCap=0 shareSend=0 shareSwap=0 why=read-elsewhere failed=0
[device] user=11 build=423 keepalive=running state=background received=21 msgs=22 raised=22 skipped=479 renders=33 rows=108 shareCap=0 shareSend=0 shareSwap=0 why=read-elsewhere failed=0
[device] user=15 build=339 keepalive=running state=background received=13 msgs=103 raised=103 skipped=227 renders=? rows=? shareCap=? shareSend=? shareSwap=? why=app-active failed=0
[device] user=16 build=435 keepalive=running state=background received=0 msgs=82 raised=84 skipped=127 renders=142 rows=645 shareCap=0 shareSend=0 shareSwap=0 why=read-elsewhere failed=0
[device] user=6 build=447 keepalive=running state=background received=46 msgs=33 raised=31 skipped=4770 renders=63 rows=391 shareCap=0 shareSend=0 shareSwap=0 why=read-elsewhere failed=0
[device] user=8 build=435 keepalive=running state=background received=0 msgs=38 raised=37 skipped=163 renders=92 rows=381 shareCap=0 shareSend=0 shareSwap=0 why=read-elsewhere failed=0
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
Nov 05 12:00:06 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:01:22 srv5524755161 node[2969692]: [presence] disconnect user=8 held=76s reason=transport-close sockets=0
Nov 05 12:01:23 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:04:04 srv5524755161 node[2969692]: [presence] disconnect user=8 held=161s reason=transport-close sockets=0
Nov 05 12:04:05 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:04:30 srv5524755161 node[2969692]: [presence] disconnect user=8 held=26s reason=transport-close sockets=0
Nov 05 12:04:31 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:05:47 srv5524755161 node[2969692]: [presence] disconnect user=8 held=76s reason=transport-close sockets=0
Nov 05 12:05:48 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:05:51 srv5524755161 node[2969692]: [presence] disconnect user=8 held=2s reason=transport-close sockets=0
Nov 05 12:05:51 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:06:21 srv5524755161 node[2969692]: [presence] connect user=1 sockets=1
Nov 05 12:09:15 srv5524755161 node[2969692]: [presence] disconnect user=8 held=204s reason=transport-close sockets=0
Nov 05 12:09:16 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:11:36 srv5524755161 node[2969692]: [presence] disconnect user=8 held=141s reason=transport-close sockets=0
Nov 05 12:11:37 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:12:03 srv5524755161 node[2969692]: [presence] disconnect user=8 held=25s reason=transport-close sockets=0
Nov 05 12:12:05 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:12:11 srv5524755161 node[2969692]: [presence] disconnect user=1 held=350s reason=ping-timeout sockets=0
Nov 05 12:12:56 srv5524755161 node[2969692]: [presence] disconnect user=8 held=51s reason=transport-close sockets=0
Nov 05 12:12:57 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:13:48 srv5524755161 node[2969692]: [presence] disconnect user=8 held=51s reason=transport-close sockets=0
Nov 05 12:13:48 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:14:44 srv5524755161 node[2969692]: [presence] disconnect user=8 held=56s reason=transport-close sockets=0
Nov 05 12:14:46 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:15:37 srv5524755161 node[2969692]: [presence] disconnect user=8 held=51s reason=transport-close sockets=0
Nov 05 12:15:39 srv5524755161 node[2969692]: [presence] connect user=8 sockets=1
Nov 05 12:16:25 srv5524755161 node[2969692]: [presence] connect user=1 sockets=1
Nov 05 12:19:00 srv5524755161 node[2969692]: [presence] disconnect user=8 held=201s reason=ping-timeout sockets=0
Nov 05 12:20:34 srv5524755161 node[2969692]: [presence] disconnect user=1 held=248s reason=ping-timeout sockets=0
Nov 05 12:30:42 srv5524755161 node[2969692]: [presence] connect user=16 sockets=1
Nov 05 12:31:14 srv5524755161 node[2969692]: [presence] connect user=11 sockets=1
Nov 05 12:31:27 srv5524755161 node[2969692]: [presence] disconnect user=16 held=45s reason=ping-timeout sockets=0
Nov 05 12:31:36 srv5524755161 node[2969692]: [presence] disconnect user=11 held=21s reason=transport-error sockets=0
Nov 05 12:32:43 srv5524755161 node[2969692]: [presence] connect user=16 sockets=1
Nov 05 12:32:45 srv5524755161 node[2969692]: [presence] disconnect user=16 held=2s reason=transport-error sockets=0
Nov 05 12:37:37 srv5524755161 node[2969692]: [presence] connect user=1 sockets=1
Nov 05 12:40:10 srv5524755161 node[2984851]: [presence] connect user=1 sockets=1
Nov 05 12:52:40 srv5524755161 node[2984851]: [presence] connect user=6 sockets=1
Nov 05 12:56:50 srv5524755161 node[2984851]: [presence] disconnect user=6 held=250s reason=ping-timeout sockets=0
(end of presence lines)

### what a screen share actually did, last 24 hours
# captured=0            -> Android refused the capture
# captured=1 switched=0 -> the call would not take the track
# captured=1 switched=1 -> the track went in; if the far end
#                          froze, it is the encoder
(end of share lines)

### what the service logged about push, last 2 hours
Nov 05 11:06:04 srv5524755161 node[2969692]: [push] 1 device(s) for 1 user(s) [6] — auth 460ms, send 462ms
Nov 05 11:06:41 srv5524755161 node[2969692]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 479ms
Nov 05 11:06:54 srv5524755161 node[2969692]: [push] msg 16158 room 6: suppressed for 1 viewer(s) [1]
Nov 05 11:42:20 srv5524755161 node[2969692]: [push] 1 device(s) for 1 user(s) [8] — auth 1ms, send 427ms
Nov 05 11:42:38 srv5524755161 node[2969692]: [push] holding 1 for the socket
Nov 05 11:42:44 srv5524755161 node[2969692]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 447ms
Nov 05 11:43:16 srv5524755161 node[2969692]: [push] holding 1 for the socket
Nov 05 11:43:21 srv5524755161 node[2969692]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 473ms
Nov 05 11:44:39 srv5524755161 node[2969692]: [push] holding 1 for the socket
Nov 05 11:44:43 srv5524755161 node[2969692]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 449ms
Nov 05 11:44:44 srv5524755161 node[2969692]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 152ms
Nov 05 11:51:59 srv5524755161 node[2969692]: [push] msg 16164 room 9: suppressed for 1 viewer(s) [8]
Nov 05 12:06:48 srv5524755161 node[2969692]: [push] 2 device(s) for 4 user(s) [11,12,15,16] — auth 352ms, send 427ms
Nov 05 12:30:56 srv5524755161 node[2969692]: [push] 3 device(s) for 4 user(s) [1,11,12,15] — auth 0ms, send 569ms
Nov 05 12:31:28 srv5524755161 node[2969692]: [push] 2 device(s) for 4 user(s) [1,12,15,16] — auth 1ms, send 544ms
Nov 05 12:38:07 srv5524755161 node[2984370]: [FCM] Loaded service account for project "room-f621b" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Nov 05 12:39:56 srv5524755161 node[2984851]: [FCM] Loaded service account for project "room-f621b" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Nov 05 12:51:28 srv5524755161 node[2984851]: [push] 1 device(s) for 1 user(s) [6] — auth 438ms, send 397ms
Nov 05 12:52:13 srv5524755161 node[2984851]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 387ms
Nov 05 12:52:42 srv5524755161 node[2984851]: [push] 1 device(s) for 1 user(s) [6] — auth 0ms, send 415ms
(end of push log lines)

### FCM credentials present?
Nov 05 12:38:07 srv5524755161 node[2984370]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Nov 05 12:39:56 srv5524755161 node[2984851]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
