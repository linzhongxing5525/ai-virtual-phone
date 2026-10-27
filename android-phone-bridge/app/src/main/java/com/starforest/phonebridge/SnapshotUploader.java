package com.starforest.phonebridge;

import android.Manifest;
import android.app.AppOpsManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.provider.CallLog;
import android.provider.CalendarContract;
import android.provider.ContactsContract;
import android.provider.MediaStore;
import android.provider.Telephony;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.MessageDigest;
import java.util.Calendar;
import java.util.List;
import java.util.SortedMap;
import java.util.TreeMap;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class SnapshotUploader {
    private SnapshotUploader() { }

    static boolean granted(Context c, String permission) { return ContextCompat.checkSelfPermission(c, permission) == PackageManager.PERMISSION_GRANTED; }
    static JSONArray query(Context c, Uri uri, String[] columns, String order, int limit) {
        JSONArray items = new JSONArray();
        try (Cursor cursor = c.getContentResolver().query(uri, columns, null, null, order)) {
            if (cursor == null) return items;
            while (cursor.moveToNext() && items.length() < limit) {
                JSONObject item = new JSONObject();
                for (int i = 0; i < columns.length; i++) item.put(columns[i], cursor.isNull(i) ? JSONObject.NULL : cursor.getString(i));
                items.put(item);
            }
        } catch (Exception ignored) { }
        return items;
    }

    static boolean notificationsEnabled(Context c) {
        String enabled = Settings.Secure.getString(c.getContentResolver(), "enabled_notification_listeners");
        return enabled != null && enabled.contains(c.getPackageName());
    }

    static boolean usageEnabled(Context c) {
        AppOpsManager manager = (AppOpsManager)c.getSystemService(Context.APP_OPS_SERVICE);
        int mode = manager.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), c.getPackageName());
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    static JSONObject collect(Context c) throws Exception {
        JSONObject result = new JSONObject();
        result.put("version", 1);
        result.put("capturedAt", System.currentTimeMillis());
        JSONObject device = new JSONObject();
        device.put("manufacturer", Build.MANUFACTURER); device.put("model", Build.MODEL); device.put("android", Build.VERSION.RELEASE);
        result.put("device", device);
        JSONObject permissions = new JSONObject();

        boolean contacts = granted(c, Manifest.permission.READ_CONTACTS); permissions.put("contacts", contacts);
        result.put("contacts", contacts ? query(c, ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER},
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC", 300) : new JSONArray());

        boolean sms = granted(c, Manifest.permission.READ_SMS); permissions.put("sms", sms);
        result.put("sms", sms ? query(c, Telephony.Sms.CONTENT_URI,
                new String[]{Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE},
                Telephony.Sms.DATE + " DESC", 200) : new JSONArray());

        boolean calls = granted(c, Manifest.permission.READ_CALL_LOG); permissions.put("calls", calls);
        result.put("calls", calls ? query(c, CallLog.Calls.CONTENT_URI,
                new String[]{CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE},
                CallLog.Calls.DATE + " DESC", 200) : new JSONArray());

        String mediaPermission = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_IMAGES : Manifest.permission.READ_EXTERNAL_STORAGE;
        boolean media = granted(c, mediaPermission); permissions.put("media", media);
        result.put("media", media ? query(c, MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                new String[]{MediaStore.Images.Media.DISPLAY_NAME, MediaStore.Images.Media.DATE_ADDED, MediaStore.Images.Media.MIME_TYPE, MediaStore.Images.Media.RELATIVE_PATH},
                MediaStore.Images.Media.DATE_ADDED + " DESC", 200) : new JSONArray());

        boolean calendar = granted(c, Manifest.permission.READ_CALENDAR); permissions.put("calendar", calendar);
        result.put("calendar", calendar ? query(c, CalendarContract.Events.CONTENT_URI,
                new String[]{CalendarContract.Events.TITLE, CalendarContract.Events.DESCRIPTION, CalendarContract.Events.DTSTART, CalendarContract.Events.DTEND, CalendarContract.Events.EVENT_LOCATION},
                CalendarContract.Events.DTSTART + " DESC", 200) : new JSONArray());

        boolean location = granted(c, Manifest.permission.ACCESS_FINE_LOCATION); permissions.put("location", location);
        JSONObject locationItem = new JSONObject();
        if (location) {
            try {
                LocationManager manager = (LocationManager)c.getSystemService(Context.LOCATION_SERVICE);
                Location last = manager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                if (last == null) last = manager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                if (last != null) { locationItem.put("latitude", last.getLatitude()); locationItem.put("longitude", last.getLongitude()); locationItem.put("accuracy", last.getAccuracy()); locationItem.put("time", last.getTime()); }
            } catch (Exception ignored) { }
        }
        result.put("location", locationItem);

        boolean notifications = notificationsEnabled(c); permissions.put("notifications", notifications);
        result.put("notifications", new JSONArray(c.getSharedPreferences("bridge", Context.MODE_PRIVATE).getString("notifications", "[]")));

        boolean usage = usageEnabled(c); permissions.put("usage", usage);
        JSONArray usageItems = new JSONArray();
        if (usage) {
            UsageStatsManager manager = (UsageStatsManager)c.getSystemService(Context.USAGE_STATS_SERVICE);
            long end = System.currentTimeMillis(), start = end - 7L * 24 * 60 * 60 * 1000;
            List<UsageStats> stats = manager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, start, end);
            stats.sort((a, b) -> Long.compare(b.getLastTimeUsed(), a.getLastTimeUsed()));
            for (UsageStats stat : stats) {
                if (usageItems.length() >= 100 || stat.getTotalTimeInForeground() <= 0) continue;
                JSONObject item = new JSONObject(); item.put("package", stat.getPackageName()); item.put("lastUsed", stat.getLastTimeUsed()); item.put("foregroundMs", stat.getTotalTimeInForeground()); usageItems.put(item);
            }
        }
        result.put("usage", usageItems);
        result.put("permissions", permissions);
        return result;
    }

    static byte[] hex(String value) {
        byte[] data = new byte[value.length() / 2];
        for (int i = 0; i < data.length; i++) data[i] = (byte)Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return data;
    }

    static String authToken(String secret) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(hex(secret));
        StringBuilder result = new StringBuilder();
        for (byte value : digest) result.append(String.format("%02x", value & 0xff));
        return result.toString();
    }

    public static void sync(Context c) throws Exception {
        android.content.SharedPreferences prefs = c.getSharedPreferences("bridge", Context.MODE_PRIVATE);
        String id = prefs.getString("id", ""), secret = prefs.getString("secret", ""), origin = prefs.getString("origin", "https://starforest.netlify.app");
        if (id.isEmpty() || secret.isEmpty()) throw new IllegalStateException("尚未配对");
        byte[] iv = new byte[12]; new SecureRandom().nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(hex(secret), "AES"), new GCMParameterSpec(128, iv));
        byte[] encrypted = cipher.doFinal(collect(c).toString().getBytes(StandardCharsets.UTF_8));
        JSONObject envelope = new JSONObject();
        envelope.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
        envelope.put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP));
        URL url = new URL(origin + "/api/phone-bridge/snapshot?id=" + id);
        HttpURLConnection connection = (HttpURLConnection)url.openConnection();
        connection.setRequestMethod("PUT"); connection.setDoOutput(true); connection.setConnectTimeout(20000); connection.setReadTimeout(30000);
        connection.setRequestProperty("Authorization", "Bearer " + authToken(secret)); connection.setRequestProperty("Content-Type", "application/json");
        try (OutputStream output = connection.getOutputStream()) { output.write(envelope.toString().getBytes(StandardCharsets.UTF_8)); }
        int status = connection.getResponseCode(); connection.disconnect();
        if (status < 200 || status >= 300) throw new IllegalStateException("同步失败 HTTP " + status);
        prefs.edit().putLong("lastSync", System.currentTimeMillis()).apply();
    }
}
