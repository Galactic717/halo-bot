package com.halo.bot.platform

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.halo.bot.MainActivity
import com.halo.bot.R
import com.halo.bot.core.Agent
import com.halo.bot.core.ApprovalRequest
import com.halo.bot.core.Message

/**
 * Three channels, because the three things Halo interrupts you about are not equally urgent.
 *
 * A bot waiting on permission is the one worth a heads-up notification: nothing else in the app can
 * make progress until it is answered, which is exactly what the desktop build says by giving that
 * one `urgency: critical`. A message is a normal notification. The service's own notice is silent
 * and low — it exists because Android requires one, not because anybody wants to read it.
 */
object Notifications {
    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_APPROVALS = "approvals"
    const val CHANNEL_SERVICE = "service"
    const val SERVICE_NOTIFICATION_ID = 1

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_MESSAGES, "Messages from your bots", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "What a bot sends you while Halo is not on screen."
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVALS, "Permission requests", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A bot is waiting for you to allow or refuse something."
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "Bots running", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Shown while your bots keep working in the background."
                setShowBadge(false)
            },
        )
    }

    private fun openIntent(context: Context, agentId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            agentId?.let { putExtra(MainActivity.EXTRA_FOCUS_AGENT, it) }
        }
        return PendingIntent.getActivity(
            context,
            agentId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun allowed(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    fun message(context: Context, agent: Agent, message: Message) {
        if (!allowed(context)) return
        val notification = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(agent.name)
            .setContentText(message.text.take(220))
            .setStyle(NotificationCompat.BigTextStyle().bigText(message.text.take(1200)))
            .setContentIntent(openIntent(context, agent.id))
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(agent.id.hashCode(), notification) }
    }

    fun approval(context: Context, request: ApprovalRequest) {
        if (!allowed(context)) return
        val notification = NotificationCompat.Builder(context, CHANNEL_APPROVALS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(request.agentName + " needs permission")
            .setContentText(request.summary)
            .setStyle(NotificationCompat.BigTextStyle().bigText(request.summary + "\n\n" + request.reason))
            .setContentIntent(openIntent(context, request.agentId))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(Notification.CATEGORY_CALL)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(request.id.hashCode(), notification) }
    }

    fun clearApproval(context: Context, id: String) {
        runCatching { NotificationManagerCompat.from(context).cancel(id.hashCode()) }
    }

    fun serviceNotification(context: Context, working: Int): Notification =
        NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (working > 0) "$working bot${if (working == 1) "" else "s"} working" else "Halo Bot")
            .setContentText(if (working > 0) "Tap to watch" else "Your bots are idle and their routines are running")
            .setContentIntent(openIntent(context, null))
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
}
