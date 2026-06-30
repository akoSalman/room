package com.akosalman.chatroom

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var splashView: View
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var firstLoad = true

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris = if (result.resultCode == Activity.RESULT_OK)
            result.data?.data?.let { arrayOf(it) }
                ?: WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        else null
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.statusBarColor = Color.parseColor("#17212b")

        val root = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(MATCH, MATCH)
            setBackgroundColor(Color.parseColor("#0e1621"))
        }

        // WebView — hidden until first load completes
        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(MATCH, MATCH)
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            visibility = View.INVISIBLE
        }

        // Thin accent progress bar at top
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            layoutParams = FrameLayout.LayoutParams(MATCH, 8)
            progressDrawable.setTint(Color.parseColor("#5288c1"))
            max = 100
            visibility = View.GONE
        }

        // Instant splash shown while WebView loads (disappears after first paint)
        splashView = makeSplash()

        root.addView(webView)
        root.addView(progressBar)
        root.addView(splashView)
        setContentView(root)

        // Request mic/camera permission upfront so WebView never hits "denied"
        val perms = arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
        val missing = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) ActivityCompat.requestPermissions(this, missing.toTypedArray(), 100)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage for auth token
            allowFileAccess = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            // Cache-first: loads from cache instantly, syncs in background
            cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK
            databaseEnabled = true
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
                // Show WebView and hide splash as soon as page starts rendering
                if (newProgress >= 30 && firstLoad) {
                    firstLoad = false
                    webView.visibility = View.VISIBLE
                    splashView.animate().alpha(0f).setDuration(300).withEndAction {
                        splashView.visibility = View.GONE
                    }.start()
                }
            }

            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                try { fileChooserLauncher.launch(params.createIntent()) }
                catch (e: Exception) { callback.onReceiveValue(null); filePathCallback = null }
                return true
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                // Grant web-level permission (system permission already requested above)
                request.grant(request.resources)
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val host = req.url.host ?: return false
                return if (host.contains("akosalman.com")) false
                else { startActivity(Intent(Intent.ACTION_VIEW, req.url)); true }
            }

            override fun onReceivedError(view: WebView, req: WebResourceRequest, error: WebResourceError) {
                if (req.isForMainFrame) view.postDelayed({ view.reload() }, 3000)
            }
        }

        webView.loadUrl("https://chat.akosalman.com")
    }

    private fun makeSplash(): View {
        val frame = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(MATCH, MATCH)
            setBackgroundColor(Color.parseColor("#0e1621"))
        }
        val label = TextView(this).apply {
            text = "💬 ChatRoom"
            textSize = 24f
            setTextColor(Color.parseColor("#d1d5db"))
            layoutParams = FrameLayout.LayoutParams(WRAP, WRAP, Gravity.CENTER)
        }
        frame.addView(label)
        return frame
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onResume() { super.onResume(); webView.onResume() }
    override fun onPause() { super.onPause(); webView.onPause() }
    override fun onDestroy() { webView.destroy(); super.onDestroy() }

    companion object {
        private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
    }
}
