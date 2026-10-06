package com.akvisionflow.owner

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.akvisionflow.owner.core.navigation.OwnerNavHost
import com.akvisionflow.owner.core.ui.theme.OwnerAppTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val container = (application as OwnerApplication).container

        setContent {
            OwnerAppTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    OwnerNavHost(container = container)
                }
            }
        }
    }
}
