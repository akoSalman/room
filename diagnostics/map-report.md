# Map report — bistbarg

Generated 2026-10-03T21:05Z by .github/workflows/map-report.yml

```
Warning: Permanently added '185.8.174.198' (ED25519) to the list of known hosts.
### is the fix even running here
mapTiles.js present: yes
server.js tries a LIST of upstreams: yes
TILE_UPSTREAM(S) set in the environment: 
### can the SERVER reach a tile provider at all
tile.openstreetmap.org -> http=200 bytes=35265 time=0.395964s
a.tile.openstreetmap.fr -> http=200 bytes=29261 time=0.457840s
tile.openstreetmap.de -> http=200 bytes=30807 time=0.500053s

### does OUR OWN endpoint serve a tile
(asking 127.0.0.1:3000)
tiles/15/21061/12900 -> http=200 bytes=35265 time=0.019805s
tiles/15/21064/12904 -> http=200 bytes=29044 time=0.392094s
tiles/16/42122/25800 -> http=200 bytes=25919 time=0.003136s

### THE PUBLIC URL -- the one the app actually asks for
(asking https://chat.bistbarg.com from the server itself)
GET https://chat.bistbarg.com/tiles/15/21061/12900.png -> http=200 bytes=35265 type=image/png
GET https://chat.bistbarg.com/tiles/14/10531/6451.png -> http=200 bytes=36039 type=image/png

### the tile cache on disk
cached tiles: 328
cached in the last hour: 11
half-written leftovers (.part): 0
zoom levels present: 4 5 11 12 13 14 15 16 17 18 
disk free on this filesystem: 45G free of 97G

### what the service has logged about tiles
(end of tile log lines)

### THE PUBLIC URL, asked from GitHub's runner
# A different network again. If the server can fetch its own
# public URL but nobody else can, that is a firewall; if both
# work, the tiles are reachable and the fault is in the app.
GET /tiles/15/21061/12900.png -> http=200 bytes=35265 type=image/png
GET /tiles/13/5265/3225.png -> http=200 bytes=37302 type=image/png
```
