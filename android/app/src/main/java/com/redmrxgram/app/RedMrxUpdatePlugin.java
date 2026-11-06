package com.redmrxgram.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "MrxUpdate")
public class RedMrxUpdatePlugin extends Plugin {
    private static final String REPOSITORY = "MRX2827/mrx";
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final long MAX_APK_SIZE = 150L * 1024 * 1024;
    private static final int MAX_RELEASE_SIZE = 256 * 1024;
    private static final Pattern VERSION = Pattern.compile("\\d{1,8}\\.\\d{1,8}\\.\\d{1,8}");
    private static final Pattern DIGEST = Pattern.compile("sha256:[0-9a-f]{64}");
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private Release latest;

    private static class Release {
        final String version;
        final String url;
        final String digest;
        final long size;

        Release(String version, String url, String digest, long size) {
            this.version = version;
            this.url = url;
            this.digest = digest;
            this.size = size;
        }
    }

    @PluginMethod
    public void check(PluginCall call) {
        io.execute(() -> {
            try {
                PackageInfo installed = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
                latest = fetchRelease(installed.versionName);
                JSObject result = new JSObject();
                if (latest != null) {
                    result.put("version", latest.version);
                    result.put("size", latest.size);
                    result.put("ready", apk(latest).length() == latest.size);
                }
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Не удалось проверить обновления");
            }
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        io.execute(() -> {
            File temp = new File(updateDirectory(), "downloading.apk");
            try {
                Release release = requireRelease(call);
                File directory = updateDirectory();
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException();
                File target = apk(release);
                if (target.length() == release.size && validate(target, release)) {
                    call.resolve();
                    return;
                }

                HttpURLConnection connection = connect(release.url, true);
                MessageDigest hash = MessageDigest.getInstance("SHA-256");
                try {
                    if (connection.getResponseCode() != 200) throw new IOException();
                    long downloaded = 0;
                    long lastProgress = 0;
                    try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(temp)) {
                        byte[] buffer = new byte[64 * 1024];
                        int count;
                        while ((count = input.read(buffer)) != -1) {
                            downloaded += count;
                            if (downloaded > release.size || Thread.currentThread().isInterrupted()) throw new IOException();
                            output.write(buffer, 0, count);
                            hash.update(buffer, 0, count);
                            long now = SystemClock.elapsedRealtime();
                            if (now - lastProgress >= 100 || downloaded == release.size) {
                                lastProgress = now;
                                JSObject progress = new JSObject();
                                progress.put("version", release.version);
                                progress.put("downloaded", downloaded);
                                progress.put("total", release.size);
                                notifyListeners("progress", progress);
                            }
                        }
                    }
                    if (downloaded != release.size || !release.digest.equals("sha256:" + hex(hash.digest())) ||
                        !compatibleApk(temp, release)) {
                        call.reject("Файл обновления не прошёл проверку");
                        return;
                    }
                    if (!temp.renameTo(target)) throw new IOException();
                    File[] cached = directory.listFiles();
                    if (cached != null) {
                        for (File file : cached) {
                            if (!file.equals(target) && file.getName().endsWith(".apk")) file.delete();
                        }
                    }
                    call.resolve();
                } finally {
                    connection.disconnect();
                }
            } catch (Exception error) {
                call.reject("Не удалось скачать обновление. Повторите попытку");
            } finally {
                temp.delete();
            }
        });
    }

    @PluginMethod
    public void install(PluginCall call) {
        io.execute(() -> {
            try {
                Release release = requireRelease(call);
                File file = apk(release);
                if (!validate(file, release)) {
                    file.delete();
                    call.reject("Файл обновления не прошёл проверку. Скачайте его снова");
                    return;
                }
                getActivity().runOnUiThread(() -> openInstaller(call, file));
            } catch (Exception error) {
                call.reject("Не удалось подготовить установку. Скачайте обновление снова");
            }
        });
    }

    private void openInstaller(PluginCall call, File file) {
        try {
            JSObject result = new JSObject();
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())));
                result.put("permissionRequired", true);
            } else {
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".updates", file);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, APK_MIME);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(intent);
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Не удалось открыть системный установщик Android");
        }
    }

    private static Release fetchRelease(String installed) throws Exception {
        HttpURLConnection connection = connect("https://api.github.com/repos/" + REPOSITORY + "/releases/latest", false);
        try {
            int status = connection.getResponseCode();
            if (status == 404) return null;
            if (status != 200) throw new IOException();
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (bytes.size() + count > MAX_RELEASE_SIZE) throw new IOException();
                    bytes.write(buffer, 0, count);
                }
            }
            JSONObject metadata = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            String tag = metadata.optString("tag_name");
            if (!tag.startsWith("v") || metadata.optBoolean("draft") || metadata.optBoolean("prerelease")) return null;
            String version = tag.substring(1);
            if (!newerThan(version, baseVersion(installed))) return null;
            String filename = "MRX-" + version + "-githubRelease.apk";
            String url = "https://github.com/" + REPOSITORY + "/releases/download/" + tag + "/" + filename;
            JSONArray assets = metadata.getJSONArray("assets");
            for (int index = 0; index < assets.length(); index++) {
                JSONObject asset = assets.getJSONObject(index);
                long size = asset.optLong("size");
                String digest = asset.optString("digest");
                if (filename.equals(asset.optString("name")) && url.equals(asset.optString("browser_download_url")) &&
                    size > 0 && size <= MAX_APK_SIZE && DIGEST.matcher(digest).matches()) {
                    return new Release(version, url, digest, size);
                }
            }
            return null;
        } finally {
            connection.disconnect();
        }
    }

    private static HttpURLConnection connect(String address, boolean apk) throws IOException {
        URL url = new URL(address);
        for (int redirect = 0; redirect < 5; redirect++) {
            String host = url.getHost();
            boolean trusted = apk
                ? (host.equals("github.com") || host.equals("release-assets.githubusercontent.com") || host.equals("objects.githubusercontent.com"))
                : host.equals("api.github.com");
            if (!url.getProtocol().equals("https") || url.getUserInfo() != null || url.getPort() != -1 || !trusted) {
                throw new IOException("Invalid update URL");
            }
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(apk ? 20000 : 8000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("User-Agent", "MRX Android updater");
            if (!apk) connection.setRequestProperty("Accept", "application/vnd.github+json");
            int status;
            try {
                status = connection.getResponseCode();
            } catch (IOException error) {
                connection.disconnect();
                throw error;
            }
            if (status < 300 || status >= 400) return connection;
            String next = connection.getHeaderField("Location");
            connection.disconnect();
            if (next == null) throw new IOException("Missing update redirect");
            url = new URL(url, next);
        }
        throw new IOException("Too many update redirects");
    }

    private Release requireRelease(PluginCall call) throws IOException {
        if (latest == null || !latest.version.equals(call.getString("version"))) throw new IOException();
        return latest;
    }

    private File updateDirectory() {
        return new File(getContext().getCacheDir(), "mrx-updates");
    }

    private File apk(Release release) {
        return new File(updateDirectory(), "MRX-" + release.version + ".apk");
    }

    private boolean validate(File file, Release release) throws Exception {
        if (file.length() != release.size) return false;
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count);
        }
        return release.digest.equals("sha256:" + hex(hash.digest())) && compatibleApk(file, release);
    }

    @SuppressWarnings("deprecation")
    private boolean compatibleApk(File file, Release release) throws PackageManager.NameNotFoundException {
        PackageManager manager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        String packageName = getContext().getPackageName();
        PackageInfo archive = manager.getPackageArchiveInfo(file.getPath(), flags);
        if (archive == null || !packageName.equals(archive.packageName) || !release.version.equals(baseVersion(archive.versionName))) {
            return false;
        }
        PackageInfo installed = manager.getPackageInfo(packageName, flags);
        Set<Signature> current = signers(installed);
        long installedCode = Build.VERSION.SDK_INT >= 28 ? installed.getLongVersionCode() : installed.versionCode;
        long archiveCode = Build.VERSION.SDK_INT >= 28 ? archive.getLongVersionCode() : archive.versionCode;
        return archiveCode > installedCode && !current.isEmpty() && current.equals(signers(archive));
    }

    @SuppressWarnings("deprecation")
    private static Set<Signature> signers(PackageInfo info) {
        Signature[] values = Build.VERSION.SDK_INT >= 28
            ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners())
            : info.signatures;
        Set<Signature> result = new HashSet<>();
        if (values != null) for (Signature signature : values) result.add(signature);
        return result;
    }

    private static String baseVersion(String versionName) {
        return versionName == null ? "" : versionName.split("-", 2)[0];
    }

    private static boolean newerThan(String release, String installed) {
        if (!VERSION.matcher(release).matches() || !VERSION.matcher(installed).matches()) return false;
        String[] left = release.split("\\.");
        String[] right = installed.split("\\.");
        for (int index = 0; index < left.length; index++) {
            int difference = Integer.compare(Integer.parseInt(left[index]), Integer.parseInt(right[index]));
            if (difference != 0) return difference > 0;
        }
        return false;
    }

    private static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) hex.append(digits[(value & 0xff) >>> 4]).append(digits[value & 0x0f]);
        return hex.toString();
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdownNow();
    }
}
