package com.akosalman.chatroom

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.webkit.*
import android.widget.FrameLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val uris = if (result.resultCode == Activity.RESULT_OK) {
            result.data?.data?.let { arrayOf(it) }
                ?: WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        } else null
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Make status bar transparent / dark
        window.statusBarColor = 0xFF17212B.toInt()

        swipeRefresh = SwipeRefreshLayout(this).apply {
            setColorSchemeColors(0xFF5288C1.toInt())
            setProgressBackgroundColorSchemeColor(0xFF17212B.toInt())
        }

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        swipeRefresh.addView(webView)
        setContentView(swipeRefresh)

        // Pull-to-refresh reloads the page
        swipeRefresh.setOnRefreshListener {
            webView.reload()
        }

        // Disable pull-to-refresh when WebView is scrolled
        webView.setOnScrollChangeListener { _, _, scrollY, _, _ ->
            swipeRefresh.isEnabled = scrollY == 0
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true           // localStorage for auth token
            allowFileAccess = true             // file uploads
            mediaPlaybackRequiresUserGesture = false  // auto-play voice messages
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString ChatRoomAndroid/1.0"
        }

        webView.webChromeClient = object : WebChromeClient() {

            // Handle file chooser (image/file upload)
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                fileChooserLauncher.launch(params.createIntent())
                return true
            }

            // Grant microphone / camera access when page requests it
            override fun onPermissionRequest(request: PermissionRequest) {
                val needed = request.resources.mapNotNull {
                    when (it) {
                        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                        else -> null
                    }
                }
                val missing = needed.filter {
                    ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED
                }
                if (missing.isNotEmpty()) {
                    ActivityCompat.requestPermissions(this@MainActivity, missing.toTypedArray(), 100)
                }
                request.grant(request.resources)
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                swipeRefresh.isRefreshing = false
            }
            // Keep all navigation inside the WebView
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host ?: return false
                return if (host.contains("akosalman.com")) {
                    view.loadUrl(request.url.toString())
                    false
                } else {
                    // Open external links in browser
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    true
                }
            }
        }

        webView.loadUrl("https://chat.akosalman.com")
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    // Keep WebSocket / audio alive when app goes to background
    override fun onResume() { super.onResume(); webView.onResume() }
    override fun onPause() { super.onPause(); webView.onPause() }
    override fun onDestroy() { webView.destroy(); super.onDestroy() }
}
