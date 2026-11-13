package com.freecut.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import java.io.ByteArrayOutputStream

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var saveBuffer: ByteArrayOutputStream? = null
    private var saveName: String = "FreeCut.mp4"

    private val picker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        if (result.resultCode != Activity.RESULT_OK) { cb.onReceiveValue(null); return@registerForActivityResult }
        val data = result.data
        val uris = mutableListOf<Uri>()
        data?.clipData?.let { for (i in 0 until it.itemCount) uris.add(it.getItemAt(i).uri) }
        if (uris.isEmpty()) data?.data?.let { uris.add(it) }
        // grant persistable read permission so ffmpeg can re-read later
        uris.forEach {
            try { contentResolver.takePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
        }
        cb.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        // Serve the bundled web app from a trusted https origin WITH the
        // cross-origin isolation headers the video engine (ffmpeg.wasm) needs.
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? {
                if (request.url.host != "appassets.androidplatform.net") return null
                var path = request.url.path ?: return null
                if (path == "/" || path.isEmpty()) path = "/index.html"
                val assetPath = "app" + path
                return try {
                    val mime = when (path.substringAfterLast('.', "")) {
                        "html" -> "text/html"
                        "js" -> "text/javascript"
                        "css" -> "text/css"
                        "ttf" -> "font/ttf"
                        "png" -> "image/png"
                        "webmanifest" -> "application/manifest+json"
                        else -> "application/octet-stream"
                    }
                    val headers = mapOf(
                        "Cross-Origin-Opener-Policy" to "same-origin",
                        "Cross-Origin-Embedder-Policy" to "credentialless",
                        "Access-Control-Allow-Origin" to "*",
                        "Cache-Control" to "no-cache"
                    )
                    WebResourceResponse(mime, "utf-8", 200, "OK", headers,
                        assets.open(assetPath))
                } catch (e: Exception) { null }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                val intent = params.createIntent()
                try { picker.launch(intent) }
                catch (e: Exception) { fileCallback = null; return false }
                return true
            }
        }

        webView.addJavascriptInterface(object {
            @JavascriptInterface fun startSave(name: String) {
                saveName = name
                saveBuffer = ByteArrayOutputStream()
            }
            @JavascriptInterface fun saveChunk(base64: String) {
                saveBuffer?.write(Base64.decode(base64, Base64.DEFAULT))
            }
            @JavascriptInterface fun endSave() {
                val data = saveBuffer?.toByteArray()
                saveBuffer = null
                if (data == null) return
                runOnUiThread { saveToGallery(data) }
            }
        }, "AndroidBridge")

        webView.loadUrl("https://appassets.androidplatform.net/index.html")
    }

    private fun saveToGallery(data: ByteArray) {
        try {
            val values = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, saveName)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/FreeCut")
            }
            val resolver = contentResolver
            val uri = resolver.insert(
                MediaStore.Video.Media.getContentUri(
                    if (Build.VERSION.SDK_INT >= 29) MediaStore.VOLUME_EXTERNAL_PRIMARY
                    else MediaStore.VOLUME_EXTERNAL
                ), values
            ) ?: throw Exception("insert failed")
            resolver.openOutputStream(uri)?.use { it.write(data) }
                ?: throw Exception("open failed")
            Toast.makeText(this, "Saved to Gallery → Movies/FreeCut", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Save failed: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
