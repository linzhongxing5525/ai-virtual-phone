package com.starforest.phonebridge;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.TimeUnit;

public class MainActivity extends AppCompatActivity {
    private EditText pairing;
    private TextView status;
    private final String[] runtimePermissions = new String[]{
            Manifest.permission.READ_CONTACTS, Manifest.permission.READ_SMS, Manifest.permission.READ_CALL_LOG,
            Manifest.permission.READ_CALENDAR, Manifest.permission.ACCESS_FINE_LOCATION,
            android.os.Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_IMAGES : Manifest.permission.READ_EXTERNAL_STORAGE
    };

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildUi());
        scheduleWorker();
        updateStatus();
    }

    private View buildUi() {
        int pad = (int)(20 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(pad, pad, pad, pad); root.setGravity(Gravity.CENTER_HORIZONTAL);
        TextView title = new TextView(this); title.setText("Starforest 手机助手"); title.setTextSize(25); root.addView(title);
        TextView info = new TextView(this); info.setText("只读同步你逐项授权的数据。内容在手机端加密，服务器只保存密文。\n\n先在 Starforest → 设置 → 工具箱 → 真实手机桥接中复制配对码。"); info.setTextSize(14); info.setPadding(0, pad / 2, 0, pad); root.addView(info);
        pairing = new EditText(this); pairing.setHint("粘贴 Starforest 配对码"); pairing.setMinLines(3); pairing.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE); root.addView(pairing, new LinearLayout.LayoutParams(-1, -2));
        root.addView(button("保存配对", v -> savePairing()));
        root.addView(button("授权联系人、短信、通话、相册、日历和位置", v -> ActivityCompat.requestPermissions(this, runtimePermissions, 10)));
        root.addView(button("授权通知读取", v -> startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"))));
        root.addView(button("授权应用使用情况", v -> startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:" + getPackageName())))));
        root.addView(button("立即加密同步", v -> new Thread(() -> {
            try { SnapshotUploader.sync(this); runOnUiThread(() -> { Toast.makeText(this, "同步成功", Toast.LENGTH_SHORT).show(); updateStatus(); }); }
            catch (Exception e) { runOnUiThread(() -> Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show()); }
        }).start()));
        status = new TextView(this); status.setTextSize(13); status.setPadding(0, pad, 0, pad); root.addView(status);
        TextView warning = new TextView(this); warning.setText("限制：无法绕过 Android 沙盒读取微信/QQ 私聊、密码或支付信息。通知权限开启后，只能看到系统通知中已经显示的预览。随时可在系统设置撤销任一权限，或卸载本助手。"); warning.setTextSize(12); root.addView(warning);
        ScrollView scroll = new ScrollView(this); scroll.addView(root); return scroll;
    }

    private Button button(String text, View.OnClickListener listener) {
        Button button = new Button(this); button.setText(text); button.setOnClickListener(listener); button.setAllCaps(false); button.setPadding(8, 10, 8, 10); return button;
    }

    private void savePairing() {
        try {
            String decoded = new String(Base64.getDecoder().decode(pairing.getText().toString().trim()), StandardCharsets.UTF_8);
            JSONObject json = new JSONObject(decoded);
            String id = json.getString("i"), secret = json.getString("s"), origin = json.optString("u", "https://starforest.netlify.app");
            if (!id.matches("[a-f0-9]{32}") || !secret.matches("[a-f0-9]{64}") || !origin.startsWith("https://")) throw new Exception("格式不正确");
            getSharedPreferences("bridge", MODE_PRIVATE).edit().putString("id", id).putString("secret", secret).putString("origin", origin).apply();
            pairing.setText(""); Toast.makeText(this, "配对已保存", Toast.LENGTH_SHORT).show(); updateStatus();
        } catch (Exception error) { Toast.makeText(this, "配对码无效：" + error.getMessage(), Toast.LENGTH_LONG).show(); }
    }

    private void scheduleWorker() {
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES).build();
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("starforest-sync", ExistingPeriodicWorkPolicy.UPDATE, request);
    }

    private void updateStatus() {
        SharedPreferences prefs = getSharedPreferences("bridge", MODE_PRIVATE);
        boolean paired = !prefs.getString("id", "").isEmpty(); long last = prefs.getLong("lastSync", 0);
        status.setText("配对状态：" + (paired ? "已配对" : "未配对") + "\n最后同步：" + (last > 0 ? new java.util.Date(last).toString() : "尚未同步"));
    }
}
