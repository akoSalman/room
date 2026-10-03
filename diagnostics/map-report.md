# Map report — bistbarg

Generated 2026-10-03T21:02Z by .github/workflows/map-report.yml

```
Warning: Permanently added '185.8.174.198' (ED25519) to the list of known hosts.
### is the fix even running here
mapTiles.js present: yes
server.js tries a LIST of upstreams: yes
TILE_UPSTREAM(S) set in the environment: 
### can the SERVER reach a tile provider at all
tile.openstreetmap.org -> http=200 bytes=35265 time=0.401946s
a.tile.openstreetmap.fr -> http=200 bytes=29176 time=2.463883s
tile.openstreetmap.de -> http=200 bytes=30807 time=1.773757s

### does OUR OWN endpoint serve a tile
(asking 127.0.0.1:3000)
tiles/15/21061/12900 -> http=200 bytes=35265 time=0.423465s
tiles/15/21062/12902 -> http=200 bytes=25546 time=0.116724s
tiles/16/42122/25800 -> http=200 bytes=25919 time=0.114109s

### the tile cache on disk
cached tiles: 326
cached in the last hour: 9
half-written leftovers (.part): 0
zoom levels present: 4 5 11 12 13 14 15 16 17 18 
disk free on this filesystem: 45G free of 97G

### what the service has logged about tiles
(end of tile log lines)
```
