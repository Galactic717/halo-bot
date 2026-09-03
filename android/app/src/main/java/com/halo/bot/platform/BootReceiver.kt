package com.halo.bot.platform

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.halo.bot.Halo

/**
 * Brings the bots back after a reboot, but only if the user asked for them to keep working.
 *
 * The desktop equivalent is "start with Windows"; the same setting drives both. Without this a
 * routine set for 07:00 would silently stop firing the first time the phone restarted overnight, and
 * a scheduler nobody can rely on is worse than no scheduler.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Halo.start(context)
        if (Halo.store.getSettings().backgroundService) HaloService.sync(context, true)
    }
}
