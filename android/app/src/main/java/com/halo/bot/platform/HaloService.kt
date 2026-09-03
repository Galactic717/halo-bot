package com.halo.bot.platform

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import com.halo.bot.Halo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Keeps the bots working when Halo is not on screen.
 *
 * The desktop build closes to a tray icon and keeps running; a phone will kill the process instead,
 * so the equivalent promise needs a foreground service. It is a setting rather than a default the
 * user cannot see: a persistent notification and a process that never sleeps is a real cost on a
 * phone, and somebody who only wants bots while they are looking at them should be able to say so
 * (Settings → General → Keep working in the background).
 *
 * All it does is hold the process up and re-post its own notification as the working count changes;
 * the scheduler and the runner are the same objects the UI is using.
 */
class HaloService : Service() {

    private var scope: CoroutineScope? = null
    private var job: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Halo.start(this)
        Notifications.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat(Halo.workingCount())
        val created = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scope = it }
        job?.cancel()
        job = created.launch {
            var lastWorking = -1
            while (isActive) {
                val working = Halo.workingCount()
                if (working != lastWorking) {
                    lastWorking = working
                    startForegroundCompat(working)
                }
                delay(5_000)
            }
        }
        return START_STICKY
    }

    private fun startForegroundCompat(working: Int) {
        val notification = Notifications.serviceNotification(this, working)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this,
                Notifications.SERVICE_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(Notifications.SERVICE_NOTIFICATION_ID, notification)
        }
    }

    override fun onDestroy() {
        job?.cancel()
        scope?.cancel()
        super.onDestroy()
    }

    companion object {
        fun sync(context: Context, wanted: Boolean) {
            val intent = Intent(context, HaloService::class.java)
            if (wanted) {
                runCatching { androidx.core.content.ContextCompat.startForegroundService(context, intent) }
            } else {
                runCatching { context.stopService(intent) }
            }
        }
    }
}
