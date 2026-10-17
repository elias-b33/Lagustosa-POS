package se.restaurant.nativepos;

import android.app.Application;

public final class PosApplication extends Application {
  private PosController controller;

  @Override
  public void onCreate() {
    super.onCreate();
    controller = new PosController(this);
  }

  public PosController controller() {
    return controller;
  }
}
