# Push report — bistbarg

Generated 2026-09-20T16:22Z by .github/workflows/push-report.yml

```
Warning: Permanently added '185.8.174.198' (ED25519) to the list of known hosts.
### code actually running on this server
git HEAD: 41b70e7
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

### what the service logged about push, last 2 hours
Sep 20 15:19:14 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [8] — auth 1ms, send 428ms
Sep 20 15:20:35 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 417ms
Sep 20 15:20:59 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 4ms, send 456ms
Sep 20 15:21:24 srv5524755161 node[2322248]: [push] msg 7181 room 9: suppressed for 1 viewer(s) [1]
Sep 20 15:21:50 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [8] — auth 0ms, send 435ms
Sep 20 15:22:06 srv5524755161 node[2322248]: [push] msg 7183 room 9: suppressed for 1 viewer(s) [1]
Sep 20 15:22:37 srv5524755161 node[2322248]: [push] msg 7184 room 9: suppressed for 1 viewer(s) [1]
Sep 20 15:22:58 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 2ms, send 453ms
Sep 20 15:23:28 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 407ms
Sep 20 15:24:12 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [8] — auth 1ms, send 446ms
Sep 20 15:24:40 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 4ms, send 424ms
Sep 20 15:38:31 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 446ms
Sep 20 15:38:33 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 179ms
Sep 20 16:05:25 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 383ms, send 449ms
Sep 20 16:05:35 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 444ms
Sep 20 16:05:41 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 409ms
Sep 20 16:06:13 srv5524755161 node[2322248]: [push] msg 7194 room 2: suppressed for 1 viewer(s) [1]
Sep 20 16:06:33 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 466ms
Sep 20 16:07:00 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 443ms
Sep 20 16:07:04 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 162ms
Sep 20 16:07:08 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 166ms
Sep 20 16:16:13 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 441ms
Sep 20 16:16:18 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 436ms
Sep 20 16:16:29 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 428ms
Sep 20 16:18:34 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 401ms
Sep 20 16:18:38 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 172ms
Sep 20 16:18:41 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 153ms
Sep 20 16:18:43 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 152ms
Sep 20 16:18:47 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 156ms
Sep 20 16:18:54 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 432ms
Sep 20 16:19:03 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 0ms, send 425ms
Sep 20 16:19:06 srv5524755161 node[2322248]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 148ms
Sep 20 16:19:33 srv5524755161 node[2534989]: [FCM] Loaded service account for project "room-f621b" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Sep 20 16:19:46 srv5524755161 node[2534989]: [push] 1 recipient(s) [3] have no device token
Sep 20 16:20:01 srv5524755161 node[2534989]: [push] 1 device(s) for 1 user(s) [1] — auth 464ms, send 479ms
Sep 20 16:20:06 srv5524755161 node[2534989]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 397ms
Sep 20 16:20:08 srv5524755161 node[2534989]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 176ms
Sep 20 16:20:16 srv5524755161 node[2534989]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 422ms
Sep 20 16:20:20 srv5524755161 node[2534989]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 244ms
Sep 20 16:20:22 srv5524755161 node[2534989]: [push] 1 device(s) for 1 user(s) [1] — auth 1ms, send 142ms
(end of push log lines)

### FCM credentials present?
Sep 18 15:59:59 srv5524755161 node[2322248]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
Sep 20 16:19:33 srv5524755161 node[2534989]: [FCM] Loaded service account for project "REDACTED" from /opt/chatroom-chat.bistbarg.com/firebase-service-account.json
(end)
```
