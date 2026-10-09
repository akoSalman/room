# Share report — bistbarg

Generated 2026-10-09T19:57Z by .github/workflows/share-report.yml

```
Warning: Permanently added '185.8.174.198' (ED25519) to the list of known hosts.
### is the version that reports this even running here
server logs [share] at all: yes
server reports encoder stats: yes

### every share attempt, oldest first
Oct 07 20:09:27 srv5524755161 node[295773]: [share] user=- outcome=ok tries=1 captured=1 senders=1 switched=1
Oct 07 20:10:14 srv5524755161 node[295773]: [share] user=- outcome=ok tries=2 captured=1 senders=1 switched=1
Oct 08 16:38:50 srv5524755161 node[377328]: [share] user=- outcome=ok tries=1 captured=1 senders=1 switched=1 scale=1.83
Oct 08 16:38:56 srv5524755161 node[377328]: [share] user=- outcome=stats tries=1 captured=1 senders=1 switched=1 scale=1.83 encoded=0 sent=0 size=0x0 after=5s
Oct 08 16:40:35 srv5524755161 node[377328]: [share] user=- outcome=capture-failed tries=2 captured=1 senders=1 switched=1 scale=1.83
Oct 09 05:35:11 srv5524755161 node[602225]: [share] user=- outcome=ok tries=1 captured=1 senders=1 switched=1 scale=1.83 up=0
Oct 09 05:35:16 srv5524755161 node[602225]: [share] user=- outcome=stats tries=1 captured=1 senders=1 switched=1 scale=1.83 up=0 before=0 encoded=0 sent=0 size=0x0 after=5s
Oct 09 19:17:59 srv5524755161 node[661495]: [share] user=- outcome=ok tries=1 captured=1 senders=1 switched=1 scale=1.83 up=1
Oct 09 19:18:04 srv5524755161 node[661495]: [share] user=- outcome=stats tries=1 captured=1 senders=1 switched=1 scale=1.83 up=1 before=0 encoded=0 sent=0 size=0x0 after=5s

### how many of each outcome
      5 outcome=ok
      3 outcome=stats
      1 outcome=capture-failed

### THE ANSWER: what the encoder did
      1 scale=1.83 up=1 before=0 encoded=0 sent=0 size=0x0 after=5s
      1 scale=1.83 up=0 before=0 encoded=0 sent=0 size=0x0 after=5s

### were any of those shares in a call that was working otherwise
call lines in the window: 0


(ssh exit 0)
```
