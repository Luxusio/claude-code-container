package dev.ccc.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

public final class MainActivity extends Activity {
    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        TextView view = new TextView(this);
        view.setText("CCC Device Lab Fixture Ready");
        view.setTextSize(24);
        view.setContentDescription("ccc-device-lab-fixture-ready");
        setContentView(view);
    }
}
