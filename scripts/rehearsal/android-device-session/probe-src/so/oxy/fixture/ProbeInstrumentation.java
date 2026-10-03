package so.oxy.fixture;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.ContentResolver;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;

/** Calls execute in the APK's real UID; no shell/provider UID impersonation. */
public final class ProbeInstrumentation extends Instrumentation {
  private static final Uri HOST = Uri.parse("content://so.oxy.accounts.dev.devicesession");
  private static final String A = "oxy1519-disposable-fixture-device-A";
  private static final String B = "oxy1519-disposable-fixture-device-B";
  private static final String SECRET_A = "disposable-fixture-credential-A-no-backend-session";
  private static final String SECRET_B = "disposable-fixture-credential-B-no-backend-session";
  private Bundle arguments;
  private int checks;

  @Override public void onCreate(Bundle args) { super.onCreate(args); arguments = args; start(); }
  private void check(boolean value, String description) {
    if (!value) throw new AssertionError(description);
    checks++;
  }
  private Bundle call(String method, Bundle extras) {
    return getTargetContext().getContentResolver().call(HOST, method, null, extras);
  }
  private Bundle credential(String id, String secret) {
    Bundle extras = new Bundle(); extras.putString("deviceId", id); extras.putString("deviceSecret", secret); return extras;
  }
  private void present(String id, String secret) {
    Bundle result = call("read", null);
    check(result != null && "present".equals(result.getString("status")), "Expected readable fixture slot");
    check(id.equals(result.getString("deviceId")) && secret.equals(result.getString("deviceSecret")), "Fixture value mismatch");
  }
  private void denied(String method, Bundle extras) {
    boolean refused = false;
    try { refused = call(method, extras) == null; } catch (SecurityException expected) { refused = true; }
    check(refused, "Foreign signature unexpectedly reached " + method);
  }
  @Override public void onStart() {
    Bundle report = new Bundle();
    try {
      String phase = arguments == null ? null : arguments.getString("phase");
      String pkg = getTargetContext().getPackageName();
      if ("foreign".equals(phase)) {
        check("onl.alia.app.dev".equals(pkg), "Foreign phase must run in foreign fixture package");
        denied("read", null); denied("write", credential(B, SECRET_B)); denied("clear", null);
      } else {
        check("earth.mention.app.dev".equals(pkg), "Allowed phase must run in peer fixture package");
        if ("begin".equals(phase)) {
          Bundle original = call("read", null);
          check(original != null && "absent".equals(original.getString("status")), "Refuse overwriting a pre-existing slot");
          Bundle written = call("write", credential(A, SECRET_A));
          check(written != null && written.getBoolean("ok"), "Fixture write failed"); present(A, SECRET_A);
        } else if ("finish".equals(phase)) {
          present(A, SECRET_A); // Foreign write/clear must have changed nothing.
          Bundle written = call("write", credential(B, SECRET_B));
          check(written != null && written.getBoolean("ok"), "Replacement write failed"); present(B, SECRET_B);
          Bundle cleared = call("clear", null);
          check(cleared != null && cleared.getBoolean("ok"), "Fixture clear failed");
          Bundle empty = call("read", null);
          check(empty != null && "absent".equals(empty.getString("status")), "Clear did not propagate");
        } else throw new AssertionError("Exact begin/foreign/finish phase required");
      }
      report.putString("fixtureStatus", "PASS"); report.putInt("checks", checks);
      report.putString("package", pkg); report.putInt("uid", Process.myUid());
      report.putString("limitation", "Shared credential slot only; no backend session/account switch/SDK SSO claim");
      finish(Activity.RESULT_OK, report);
    } catch (Throwable error) {
      report.putString("fixtureStatus", "FAIL"); report.putString("errorClass", error.getClass().getSimpleName());
      // Assertion descriptions contain no credential material; unknown exceptions may.
      if (error instanceof AssertionError) report.putString("assertion", error.getMessage());
      finish(Activity.RESULT_CANCELED, report);
    }
  }
}
