package com.freebuff.gowild;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;

/**
 * Hosts the current Design and scrolls it. Which design it holds is decided by the
 * system theme (FLAP when the phone is dark, GRID when it is light), so there is no
 * switcher chrome on the screen at all.
 */
public class BoardView extends View {
    private Design design;
    private final float d;
    private float scroll = 0f;
    private float contentHeight = 0f;
    private float lastY = 0f;
    private float downY = 0f;
    private boolean dragging = false;
    private float insetTop = 0f;
    private float insetBottom = 0f;

    public BoardView(Context ctx, Design design) {
        super(ctx);
        this.design = design;
        this.d = ctx.getResources().getDisplayMetrics().density;
        setBackgroundColor(Color.BLACK);
        setClickable(true);
        setOnApplyWindowInsetsListener(new OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets wi) {
                insetTop = wi.getSystemWindowInsetTop();
                insetBottom = wi.getSystemWindowInsetBottom();
                invalidate();
                return wi;
            }
        });
    }

    /** Used when the phone flips between light and dark while the app is open. */
    public void setDesign(Design next) {
        design = next;
        scroll = 0f;
        invalidate();
    }

    /** Used by the capture path only: a bitmap render has no window insets to read. */
    public void forceInsets(float top, float bottom) {
        insetTop = top;
        insetBottom = bottom;
    }

    @Override
    protected void onDraw(Canvas canvas) {
        contentHeight = design.draw(canvas, getWidth(), getHeight(), scroll, new Insets(insetTop, insetBottom));
        float max = Math.max(0f, contentHeight - getHeight());
        if (scroll > max) {
            scroll = max;
            invalidate();
        }
        if (scroll < 0f) {
            scroll = 0f;
            invalidate();
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                lastY = e.getY();
                downY = e.getY();
                dragging = false;
                break;
            case MotionEvent.ACTION_MOVE:
                if (Math.abs(e.getY() - downY) > d * 5) dragging = true;
                if (dragging) {
                    scroll += lastY - e.getY();
                    if (scroll < 0f) scroll = 0f;
                    invalidate();
                }
                lastY = e.getY();
                break;
            default:
                break;
        }
        return true;
    }
}
