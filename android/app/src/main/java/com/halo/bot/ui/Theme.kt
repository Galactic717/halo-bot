package com.halo.bot.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/**
 * The desktop build's tokens, moved across whole.
 *
 * Same neutral ramp, same accent, same avatar palette — this is one product on two screens, and a
 * phone version that invented its own colours would read as a different app. What does change is the
 * scale: 13px base type and a 4px grid are right for a mouse and wrong for a thumb, so the type steps
 * up and the touch targets are sized to Android's 48dp minimum rather than to a desktop row.
 */

data class HaloColors(
    val bgBase: Color,
    val bgSubtle: Color,
    val bgElevated: Color,
    val bgScrim: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val textOnPrimary: Color,
    val borderSubtle: Color,
    val borderWeak: Color,
    val borderDefault: Color,
    val borderStrong: Color,
    val fillGhostHover: Color,
    val fillGhostSelected: Color,
    val fillSecondary: Color,
    val fillPrimary: Color,
    val bubbleUser: Color,
    val bubbleAgent: Color,
    val accentSubtle: Color,
    val successSubtle: Color,
    val dangerSubtle: Color,
    val warningSubtle: Color,
    val textSuccess: Color,
    val textDanger: Color,
    val textWarning: Color,
    val accent: Color,
    val isDark: Boolean,
)

private val DarkColors = HaloColors(
    bgBase = Color(0xFF070707),
    bgSubtle = Color(0xFF111111),
    bgElevated = Color(0xFF181818),
    bgScrim = Color(0xB2141414),
    textPrimary = Color(0xFFFCFCFC),
    textSecondary = Color(0x99FCFCFC),
    textTertiary = Color(0x66FCFCFC),
    textOnPrimary = Color(0xFF141414),
    borderSubtle = Color(0x0DFCFCFC),
    borderWeak = Color(0x1AFCFCFC),
    borderDefault = Color(0x26FCFCFC),
    borderStrong = Color(0x4DFCFCFC),
    fillGhostHover = Color(0x2C777777),
    fillGhostSelected = Color(0x52777777),
    fillSecondary = Color(0x17777777),
    fillPrimary = Color(0xFFFCFCFC),
    bubbleUser = Color(0xFF5A5A5A),
    bubbleAgent = Color(0xFF262626),
    accentSubtle = Color(0x2C1084FE),
    successSubtle = Color(0x2C00C972),
    dangerSubtle = Color(0x2CFF263C),
    warningSubtle = Color(0x2CFF9800),
    textSuccess = Color(0xFF38D591),
    textDanger = Color(0xFFFF5667),
    textWarning = Color(0xFFFFAF38),
    accent = Color(0xFF1084FE),
    isDark = true,
)

private val LightColors = HaloColors(
    bgBase = Color(0xFFFCFCFC),
    bgSubtle = Color(0xFFF7F7F7),
    bgElevated = Color(0xFFFFFFFF),
    bgScrim = Color(0x80141414),
    textPrimary = Color(0xFF141414),
    textSecondary = Color(0x99141414),
    textTertiary = Color(0x66141414),
    textOnPrimary = Color(0xFFFCFCFC),
    borderSubtle = Color(0x0D141414),
    borderWeak = Color(0x1A141414),
    borderDefault = Color(0x26141414),
    borderStrong = Color(0x4D141414),
    fillGhostHover = Color(0x17777777),
    fillGhostSelected = Color(0x2B777777),
    fillSecondary = Color(0x17777777),
    fillPrimary = Color(0xFF070707),
    bubbleUser = Color(0xFF070707),
    bubbleAgent = Color(0xFFEEEEEE),
    accentSubtle = Color(0x171084FE),
    successSubtle = Color(0x1700C972),
    dangerSubtle = Color(0x17FF263C),
    warningSubtle = Color(0x17FF9800),
    textSuccess = Color(0xFF009957),
    textDanger = Color(0xFFC21D2E),
    textWarning = Color(0xFFC27400),
    accent = Color(0xFF1084FE),
    isDark = false,
)

val AVATAR_COLORS = linkedMapOf(
    "blue" to Color(0xFF1084FE),
    "orange" to Color(0xFFFF6700),
    "brown" to Color(0xFF97683D),
    "cyan" to Color(0xFF00BCA6),
    "purple" to Color(0xFF9159FE),
    "magenta" to Color(0xFFFF309B),
    "green" to Color(0xFF00C972),
    "red" to Color(0xFFFF263C),
    "yellow" to Color(0xFFFF9800),
    "gray" to Color(0xFF777777),
)

fun avatarColor(name: String): Color = AVATAR_COLORS[name] ?: AVATAR_COLORS.getValue("blue")

val LocalHaloColors = staticCompositionLocalOf { DarkColors }

val Halo1 = 4.dp
val Halo2 = 8.dp
val Halo3 = 12.dp
val Halo4 = 16.dp
val Halo5 = 20.dp
val Halo6 = 24.dp

/** Android's minimum comfortable target. Every row, chip and icon button is at least this tall. */
val TouchTarget = 48.dp

private val HaloTypography = Typography(
    displaySmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 28.sp, lineHeight = 34.sp),
    headlineSmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.SemiBold, fontSize = 19.sp, lineHeight = 25.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 19.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.Default, fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.Default, fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.Default, fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 12.sp),
    labelSmall = TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium, fontSize = 11.sp),
)

@Composable
fun HaloTheme(theme: String, content: @Composable () -> Unit) {
    val dark = when (theme) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val colors = if (dark) DarkColors else LightColors
    val scheme = if (dark) {
        darkColorScheme(
            primary = colors.accent,
            onPrimary = Color.White,
            background = colors.bgBase,
            onBackground = colors.textPrimary,
            surface = colors.bgSubtle,
            onSurface = colors.textPrimary,
            surfaceVariant = colors.bgElevated,
            onSurfaceVariant = colors.textSecondary,
            outline = colors.borderDefault,
            error = colors.textDanger,
        )
    } else {
        lightColorScheme(
            primary = colors.accent,
            onPrimary = Color.White,
            background = colors.bgBase,
            onBackground = colors.textPrimary,
            surface = colors.bgSubtle,
            onSurface = colors.textPrimary,
            surfaceVariant = colors.bgElevated,
            onSurfaceVariant = colors.textSecondary,
            outline = colors.borderDefault,
            error = colors.textDanger,
        )
    }
    /*
     * The app draws under the status and navigation bars, so the colour of the system's own icons is
     * Halo's problem. Android picks it from the system theme, which is the wrong answer whenever the
     * two disagree: a user who set Halo to dark while the phone is light gets a black clock on a
     * black bar. Follow the theme that is actually on screen.
     */
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }

    CompositionLocalProvider(LocalHaloColors provides colors) {
        MaterialTheme(colorScheme = scheme, typography = HaloTypography, content = content)
    }
}
