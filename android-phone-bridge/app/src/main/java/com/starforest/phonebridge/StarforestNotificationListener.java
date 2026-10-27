package com.starforest.phonebridge;

import android.app.Notification;
import android.content.SharedPreferences;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.JSONArray;
import org.json.JSONObject;

public class StarforestNotificationListener extends NotificationListenerService {
    @Override public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            SharedPreferences prefs = getSharedPreferences("bridge", MODE_PRIVATE);
            JSONArray items = new JSONArray(prefs.getString("notifications", "[]"));
            Notification notification = sbn.getNotification();
            JSONObject item = new JSONObject();
            item.put("package", sbn.getPackageName());
            item.put("title", String.valueOf(notification.extras.getCharSequence(Notification.EXTRA_TITLE, "")));
            item.put("text", String.valueOf(notification.extras.getCharSequence(Notification.EXTRA_TEXT, "")));
            item.put("postedAt", sbn.getPostTime());
            items.put(item);
            JSONArray trimmed = new JSONArray();
            for (int i = Math.max(0, items.length() - 100); i < items.length(); i++) trimmed.put(items.get(i));
            prefs.edit().putString("notifications", trimmed.toString()).apply();
        } catch (Exception ignored) { }
    }
}
