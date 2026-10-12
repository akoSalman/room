package __PACKAGE__;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Registers ImagePasteModule. See that file for why this lives in the app. */
public class ImagePastePackage implements ReactPackage {
  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext ctx) {
    List<NativeModule> modules = new ArrayList<>();
    modules.add(new ImagePasteModule(ctx));
    return modules;
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext ctx) {
    return Collections.emptyList();
  }
}
