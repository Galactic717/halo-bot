package com.halo.bot

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import com.halo.bot.platform.HaloService
import com.halo.bot.ui.HaloApp
import com.halo.bot.ui.HaloViewModel

/**
 * The one window.
 *
 * On the desktop the renderer is a separate process talking to Electron's main over IPC; here the
 * runtime lives in the application process and this activity is only a view onto it. That is why
 * nothing is started from `onCreate` beyond `Halo.start`, which is idempotent: the service, a boot
 * receiver or a notification tap can all have brought the runtime up before anybody opened a window.
 */
class MainActivity : ComponentActivity() {

    private val model: HaloViewModel by viewModels()

    /**
     * Asked once, on the first launch, and never insisted on.
     *
     * A bot waiting for permission is the one thing worth interrupting somebody for, and without
     * this it waits silently until the app is opened again. Refusing costs the notifications and
     * nothing else — the runtime never checks the answer, `Notifications` does.
     */
    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Halo.start(this)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        HaloService.sync(this, Halo.store.getSettings().backgroundService)
        focusFrom(intent)
        setContent { HaloApp(model) }
    }

    /** The activity is `singleTask`, so a notification tap arrives here rather than in a new window. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        focusFrom(intent)
    }

    private fun focusFrom(intent: Intent?) {
        val agentId = intent?.getStringExtra(EXTRA_FOCUS_AGENT) ?: return
        if (Halo.store.getAgent(agentId) != null || Halo.store.getChannel(agentId) != null) Halo.focus(agentId)
    }

    override fun onResume() {
        super.onResume()
        // Suppresses notifications while the user is already looking at the app.
        Halo.inForeground = true
    }

    override fun onPause() {
        Halo.inForeground = false
        super.onPause()
    }

    companion object {
        /** Which conversation a notification wants opened. */
        const val EXTRA_FOCUS_AGENT = "halo.focus.agent"
    }
}
