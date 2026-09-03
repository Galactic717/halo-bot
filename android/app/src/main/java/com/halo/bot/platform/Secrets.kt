package com.halo.bot.platform

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.halo.bot.core.SecretCodec
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The API key and any plugin credentials, encrypted before `settings.json` is written.
 *
 * Electron's `safeStorage` becomes the Android keystore: an AES key generated inside it, never
 * exported, and unusable outside this app's uid. On a device with a secure element the key material
 * never reaches the app's memory at all. Everything else in settings stays readable, which is the
 * same trade the desktop build makes — a file a person can open and fix is worth more than one that
 * is uniformly opaque.
 *
 * The IV travels with the ciphertext because GCM needs a fresh one per encryption and storing it
 * separately would be one more thing to lose.
 */
class Secrets : SecretCodec {

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "halo-bot-secrets"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }

    private val key: SecretKey by lazy { loadOrCreate() }

    private fun loadOrCreate(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Deliberately not user-authentication-bound: a routine that fires at 07:00 has to be
                // able to reach the model server without somebody unlocking the phone for it.
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    override fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
    }

    override fun decrypt(value: String): String {
        val raw = Base64.decode(value, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES))
        return String(cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES), Charsets.UTF_8)
    }
}
