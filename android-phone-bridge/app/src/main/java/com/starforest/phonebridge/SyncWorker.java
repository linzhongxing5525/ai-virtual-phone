package com.starforest.phonebridge;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public class SyncWorker extends Worker {
    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }
    @NonNull @Override public Result doWork() {
        try { SnapshotUploader.sync(getApplicationContext()); return Result.success(); }
        catch (Exception error) { return Result.retry(); }
    }
}
