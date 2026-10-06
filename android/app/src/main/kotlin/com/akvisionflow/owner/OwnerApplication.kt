package com.akvisionflow.owner

import android.app.Application
import com.akvisionflow.owner.core.AppContainer

class OwnerApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
