package com.rimal.offroad;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.security.MessageDigest;
import java.util.Locale;

/** Small native helpers for Rimal: in-app updates, opening files (the manual) and voice guidance. */
@CapacitorPlugin(name = "RimalNative")
public class RimalNativePlugin extends Plugin {
    private TextToSpeech tts;
    private boolean ttsReady = false;

    private File toFile(String path) {
        if (path.startsWith("file://")) path = Uri.parse(path).getPath();
        return new File(path);
    }

    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject r = new JSObject();
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo pi = Build.VERSION.SDK_INT >= 28
                ? pm.getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES)
                : pm.getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNATURES);
            r.put("versionName", pi.versionName);
            r.put("versionCode", Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode);
            Signature[] sigs = Build.VERSION.SDK_INT >= 28 ? pi.signingInfo.getApkContentsSigners() : pi.signatures;
            if (sigs != null && sigs.length > 0) {
                byte[] d = MessageDigest.getInstance("SHA-256").digest(sigs[0].toByteArray());
                StringBuilder sb = new StringBuilder();
                for (byte b : d) sb.append(String.format("%02x", b));
                r.put("certSha256", sb.toString());
            }
            r.put("canInstall", Build.VERSION.SDK_INT < 26 || pm.canRequestPackageInstalls());
        } catch (Exception e) {
            r.put("error", e.getMessage());
        }
        call.resolve(r);
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("path required"); return; }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(s);
            JSObject r = new JSObject(); r.put("needsPermission", true); call.resolve(r); return;
        }
        openWith(call, toFile(path), "application/vnd.android.package-archive");
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("path required"); return; }
        openWith(call, toFile(path), call.getString("mime", "application/pdf"));
    }

    private void openWith(PluginCall call, File f, String mime) {
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this device can open " + mime);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang", "en");
        float rate = call.getFloat("rate", 1.0f);
        Runnable go = () -> {
            int ok = tts.setLanguage(lang.startsWith("ar") ? new Locale("ar") : Locale.US);
            tts.setSpeechRate(rate);
            tts.speak(text, TextToSpeech.QUEUE_ADD, null, "rimal-" + System.currentTimeMillis());
            JSObject r = new JSObject(); r.put("languageOk", ok >= 0); call.resolve(r);
        };
        if (tts != null && ttsReady) { go.run(); return; }
        tts = new TextToSpeech(getContext(), status -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) go.run(); else call.reject("No text-to-speech engine on this device");
        });
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
    }
}
