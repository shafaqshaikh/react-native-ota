package com.otaupdates

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class OTAUpdatesPackage : ReactPackage {
    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
        listOf(OTAUpdatesModule(ctx))

    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
