package com.rimal.offroad;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RimalNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
