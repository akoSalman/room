# Deploying a second ChatRoom instance (e.g. chat.bistbarg.com)

Each domain runs a fully independent copy of the app: its own server process,
its own SQLite database, its own uploads, and (if it has a native app) its own
Firebase project. Nothing is shared between instances.

## 1. Provision the server

On the new server, as root:

```bash
DOMAIN=chat.bistbarg.com \
REPO_URL=https://github.com/akoSalman/room.git \
BRANCH=main \
./setup-server.sh
```

This installs Node.js (if missing), clones the repo, installs deps, creates a
systemd service, and configures nginx + HTTPS via certbot. It's idempotent —
safe to re-run if something fails partway (e.g. DNS wasn't ready for certbot
yet).

Point `chat.bistbarg.com`'s DNS A record at the new server's IP **before**
running this, or the certbot step will fail (you can just re-run
`certbot --nginx -d chat.bistbarg.com` afterward once DNS propagates).

## 2. Push notifications for the new brand (optional, native app only)

1. In the [Firebase console](https://console.firebase.google.com), create a
   **new project** for this brand (e.g. "bistbarg-chat").
2. Add an Android app with package name `com.bistbarg.chatroom` (must match
   `native-app/brands/bistbarg.json`'s `"package"` field).
3. Download the generated `google-services.json` and commit it to
   `native-app/brands/bistbarg/google-services.json` in this repo.
4. Project settings → Service accounts → Generate new private key. Upload
   that file to the bistbarg server as `firebase-service-account.json`,
   directly in the app's working directory (next to `server.js`), then:
   ```bash
   sudo systemctl restart chatroom-chat-bistbarg-com
   ```

## 3. Building the native app

`.github/workflows/build-native-apk.yml` builds **both** brands on every push
to `native-app/**` (matrix over `brands/*.json`). Each brand gets its own:
- App name / Android package (from `native-app/brands/<brand>.json`)
- API server (`baseUrl` in that same file, baked into `src/api.ts` at build time)
- GitHub release (`releaseTag`/`releaseTitle`), so the two APKs never overwrite
  each other in the `room-releases` repo.

To add a brand: drop a `native-app/brands/<name>.json` file (copy
`bistbarg.json` as a template) and, if it needs push notifications, a
`native-app/brands/<name>/google-services.json`.

## Updating an existing instance

```bash
ssh you@server
cd /opt/chatroom-chat.bistbarg.com   # or wherever it was cloned
git pull
npm install
sudo systemctl restart chatroom-chat-bistbarg-com
```
