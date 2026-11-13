package com.freebuff.gowild;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;

import com.freebuff.gowild.designs.Flap;
import com.freebuff.gowild.designs.Grid;

import java.io.File;
import java.io.FileOutputStream;

/**
 * One app, two skins, no switcher: the phone's dark/light setting chooses.
 *
 * Dark  -> FLAP (split-flap board)
 * Light -> GRID (Swiss timetable)
 *
 * `am start … --ei design 1|3` pins a direction and `--es theme dark|light` pins the
 * theme, both for development and for the capture path; neither is reachable by
 * accident from the UI.
 */
public class MainActivity extends Activity {
    private static final String TAG = "gowild";

    private Board board;
    private float density;
    private BoardView view;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }

        board = Board.load(this);
        density = getResources().getDisplayMetrics().density;

        String forcedTheme = getIntent().getStringExtra("theme");
        boolean night = forcedTheme != null ? "dark".equals(forcedTheme) : isNight(getResources().getConfiguration());
        Design start = resolve(night);
        Log.i(TAG, "resolved design=" + start.id() + " night=" + night + " forcedTheme=" + forcedTheme);

        // `am start … --es capture shot-1` renders the design to a PNG in the app's own
        // files and exits. Screenshots taken from outside the app also capture whatever
        // the owner has floating on their screen; this does not.
        String capture = getIntent().getStringExtra("capture");
        if (capture != null) {
            BoardView shotView = new BoardView(this, start);
            int wpx = getResources().getDisplayMetrics().widthPixels;
            int hpx = getResources().getDisplayMetrics().heightPixels;
            // 24dp status bar and 25dp gesture bar at this panel's 2.625 density.
            shotView.forceInsets(63f, 66f);
            shotView.measure(View.MeasureSpec.makeMeasureSpec(wpx, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(hpx, View.MeasureSpec.EXACTLY));
            shotView.layout(0, 0, wpx, hpx);
            Bitmap shot = Bitmap.createBitmap(wpx, hpx, Bitmap.Config.ARGB_8888);
            shotView.draw(new Canvas(shot));
            try (FileOutputStream out = new FileOutputStream(new File(getFilesDir(), capture + ".png"))) {
                shot.compress(Bitmap.CompressFormat.PNG, 100, out);
            } catch (Exception e) {
                Log.w(TAG, "capture failed: " + e.getClass().getSimpleName());
            }
            finish();
            return;
        }

        view = new BoardView(this, start);
        setContentView(view);
    }

    @Override
    public void onConfigurationChanged(Configuration next) {
        super.onConfigurationChanged(next);
        // A pinned direction or theme is a development override; the system theme only
        // takes effect when neither is present.
        if (view == null) return;
        if (getIntent().getStringExtra("theme") != null) return;
        if (getIntent().getIntExtra("design", 0) != 0) return;
        Design swapped = resolve(isNight(next));
        Log.i(TAG, "theme changed, design=" + swapped.id() + " night=" + isNight(next));
        view.setDesign(swapped);
    }

    private static boolean isNight(Configuration c) {
        return (c.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    private Design resolve(boolean night) {
        int pinned = getIntent().getIntExtra("design", 0);
        if (pinned == 1) return new Flap(board, density);
        if (pinned == 3) return new Grid(board, density);
        return night ? new Flap(board, density) : new Grid(board, density);
    }
}
