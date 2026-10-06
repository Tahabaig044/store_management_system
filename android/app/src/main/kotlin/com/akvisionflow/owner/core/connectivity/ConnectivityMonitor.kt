package com.akvisionflow.owner.core.connectivity

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Whether the device currently has a working network path. This is a HINT for the UI (the offline banner, when
 * to re-validate the session) - never a gate: a request is always attempted, and its own outcome (see
 * ApiErrorKind.NETWORK) is what decides how a screen reacts.
 */
interface ConnectivityMonitor {
    val isOnline: StateFlow<Boolean>
    val reconnects: StateFlow<Int>
}

/** Pure state holder, shared by the Android implementation and the tests. */
class ConnectivityState(initialOnline: Boolean) : ConnectivityMonitor {
    private val _online = MutableStateFlow(initialOnline)
    override val isOnline: StateFlow<Boolean> = _online.asStateFlow()

    /** How many times the connection came BACK after being lost - what "reconnected" listeners react to. */
    private val _reconnects = MutableStateFlow(0)
    override val reconnects: StateFlow<Int> = _reconnects.asStateFlow()

    fun set(online: Boolean) {
        val was = _online.value
        _online.value = online
        if (!was && online) _reconnects.value += 1
    }
}

class AndroidConnectivityMonitor(context: Context) : ConnectivityMonitor {
    private val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val state = ConnectivityState(currentlyOnline())
    override val isOnline: StateFlow<Boolean> get() = state.isOnline
    override val reconnects: StateFlow<Int> get() = state.reconnects

    init {
        // Lives for the process (an app-lifetime singleton), so there is nothing to unregister it from.
        runCatching {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onLost(network: Network) = state.set(currentlyOnline())
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) =
                    state.set(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
            })
        }
    }

    private fun currentlyOnline(): Boolean {
        val caps = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }
}
