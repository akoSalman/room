package __PACKAGE__;

// ── Accepting an image pasted from the keyboard ─────────────────────────────
//
// Reported twice with a photograph of Gboard refusing: "BistbargChat does not
// support image pasting here". A keyboard greys out its image key unless the
// focused field declares, through EditorInfo.contentMimeTypes, that it accepts
// images. A React Native TextInput never declares anything, and there is no
// prop for it.
//
// This was "fixed" once by patching ReactEditText.java in node_modules, and
// that patch has never run a single time. Since React Native 0.71 the Android
// code is consumed as a prebuilt artifact from Maven — node_modules/react-
// native/ReactAndroid/src is not compiled unless the project builds React
// Native from source, which this one does not. The patch applied cleanly,
// passed its tests, and changed nothing. Gboard was right all along.
//
// So the work happens HERE, in the app's own module, which is compiled.
//
// Android 12 made this possible without touching the text field at all:
// setOnReceiveContentListener declares the types on the VIEW, and
// TextView.onCreateInputConnection copies them into the EditorInfo the
// keyboard reads. ReactEditText calls through to that super method, so
// attaching the listener to the existing field is enough.
import android.content.ClipData;
import android.content.Context;
import android.net.Uri;
// android.util.Pair, not androidx.core.util.Pair: ContentInfoCompat.partition
// returns the platform one, which the compiler had to say out loud before it
// was believed.
import android.util.Pair;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;

import androidx.core.view.ContentInfoCompat;
import androidx.core.view.OnReceiveContentListener;
import androidx.core.view.ViewCompat;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.facebook.react.uimanager.UIManagerModule;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

public class ImagePasteModule extends ReactContextBaseJavaModule {

  public ImagePasteModule(ReactApplicationContext ctx) {
    super(ctx);
  }

  @Override
  public String getName() {
    return "ImagePaste";
  }

  /**
   * Tell this text field to accept images.
   *
   * Everything is wrapped: a composer that throws while mounting would be a
   * far worse bug than one that cannot take a pasted image.
   */
  @ReactMethod
  public void enable(final int viewTag) {
    try {
      final ReactApplicationContext ctx = getReactApplicationContext();
      final UIManagerModule ui = ctx.getNativeModule(UIManagerModule.class);
      if (ui == null) {
        return;
      }
      ui.addUIBlock(
          nvhm -> {
            try {
              View v = nvhm.resolveView(viewTag);
              if (!(v instanceof EditText)) {
                return;
              }
              ViewCompat.setOnReceiveContentListener(v, new String[] {"image/*"}, listener);
              // The EditorInfo is built when the keyboard connects. If it is
              // already connected — the field was focused before this ran —
              // it has to be asked again or the image key stays grey until
              // the next focus.
              InputMethodManager imm =
                  (InputMethodManager) v.getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
              if (imm != null) {
                imm.restartInput(v);
              }
            } catch (Throwable ignored) {
            }
          });
    } catch (Throwable ignored) {
    }
  }

  private final OnReceiveContentListener listener =
      new OnReceiveContentListener() {
        @Override
        public ContentInfoCompat onReceiveContent(View view, ContentInfoCompat payload) {
          // Only the parts carrying a URI are ours. Everything else — pasted
          // TEXT above all — goes back to the platform to insert as it always
          // did; swallowing it would break ordinary pasting, which is the one
          // thing this must not do.
          Pair<ContentInfoCompat, ContentInfoCompat> split =
              payload.partition(item -> item.getUri() != null);
          ContentInfoCompat ours = split.first;
          ContentInfoCompat rest = split.second;
          if (ours != null) {
            take(view, ours);
          }
          return rest;
        }
      };

  /**
   * Copy what was handed over, before the grant expires.
   *
   * The read permission on the keyboard's content:// URI lasts only for this
   * call. Passing the URI to JavaScript and uploading it a moment later would
   * find nothing there — the paste would look accepted and send an empty file.
   */
  private void take(View view, ContentInfoCompat info) {
    ClipData clip = info.getClip();
    for (int i = 0; i < clip.getItemCount(); i++) {
      Uri uri = clip.getItemAt(i).getUri();
      if (uri == null) {
        continue;
      }
      try {
        Context c = view.getContext();
        String mime = c.getContentResolver().getType(uri);
        if (mime == null) {
          mime = "image/jpeg";
        }
        String ext =
            mime.contains("png")
                ? ".png"
                : mime.contains("gif") ? ".gif" : mime.contains("webp") ? ".webp" : ".jpg";
        File out = new File(c.getCacheDir(), "pasted-" + System.currentTimeMillis() + "-" + i + ext);
        InputStream in = c.getContentResolver().openInputStream(uri);
        if (in == null) {
          continue;
        }
        OutputStream os = new FileOutputStream(out);
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
          os.write(buf, 0, n);
        }
        os.close();
        in.close();

        WritableMap ev = Arguments.createMap();
        ev.putString("uri", "file://" + out.getAbsolutePath());
        ev.putString("name", out.getName());
        ev.putString("mime", mime);
        getReactApplicationContext()
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit("onPasteImage", ev);
      } catch (Throwable ignored) {
      }
    }
  }
}
