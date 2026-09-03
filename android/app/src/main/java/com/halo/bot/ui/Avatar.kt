package com.halo.bot.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.halo.bot.core.Agent
import com.halo.bot.core.AgentStatus

private const val SLEEP_AFTER_MS = 30 * 60_000L

private val INK = Color(0xFF0D0D0D)

/**
 * Halo's own mark: a filled disc with a two-dot face whose eyes react to the bot's state.
 *
 * Drawn rather than shipped as assets, exactly as on the desktop, because the face has to change with
 * the status — open eyes when it is awake, closed when it has been quiet for half an hour, a smile
 * while it is working — and ten colours times four states is forty images nobody wants to maintain.
 */
@Composable
fun Avatar(agent: Agent, size: Dp = 40.dp, showStatus: Boolean = false) {
    val idleFor = if (agent.lastActivityAt > 0) System.currentTimeMillis() - agent.lastActivityAt else 0
    // A bot nobody has spoken to in a while dozes off, the way the original's avatars do.
    val status = if (agent.status == AgentStatus.IDLE && idleFor > SLEEP_AFTER_MS) AgentStatus.SLEEPING else agent.status
    val color = avatarColor(agent.avatar.color)

    Box(modifier = Modifier.size(size), contentAlignment = Alignment.BottomEnd) {
        Canvas(modifier = Modifier.size(size).clip(CircleShape).background(color)) {
            val s = this.size.minDimension
            fun x(v: Float) = v / 40f * s
            fun y(v: Float) = v / 40f * s

            if (status == AgentStatus.SLEEPING) {
                for (start in listOf(12f, 22f)) {
                    val path = Path().apply {
                        moveTo(x(start), y(19f))
                        quadraticTo(x(start + 3f), y(22f), x(start + 6f), y(19f))
                    }
                    drawPath(path, INK, style = Stroke(width = x(2.6f), cap = StrokeCap.Round))
                }
            } else {
                for (cx in listOf(15f, 25f)) {
                    drawOval(
                        color = INK,
                        topLeft = Offset(x(cx - 2.6f), y(17.5f - 3.6f)),
                        size = Size(x(5.2f), y(7.2f)),
                    )
                }
            }
            if (status == AgentStatus.WORKING) {
                val smile = Path().apply {
                    moveTo(x(15f), y(26f))
                    quadraticTo(x(20f), y(30f), x(25f), y(26f))
                }
                drawPath(smile, INK, style = Stroke(width = x(2.2f), cap = StrokeCap.Round))
            }
        }
        if (showStatus) {
            val dot = when (status) {
                AgentStatus.WORKING -> Color(0xFF00C972)
                AgentStatus.WAITING -> Color(0xFFFF9800)
                else -> Color(0xFF777777)
            }
            Box(
                modifier = Modifier
                    .size(size / 4)
                    .clip(CircleShape)
                    .background(LocalHaloColors.current.bgBase),
                contentAlignment = Alignment.Center,
            ) {
                Box(modifier = Modifier.size(size / 6).clip(CircleShape).background(dot))
            }
        }
    }
}
